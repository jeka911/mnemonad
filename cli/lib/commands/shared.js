import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { getAddress } from 'viem';
import { MnemonadPinataProvider } from 'mnemonad';

// monadsync re-exports its whole sync-primitives surface (see monadsync/index.js), so
// these come from there rather than adding a second, lower-level dependency.
import { DoubleSync as SyncEngine, CDCStore, DoubleSyncSnapshot as SyncSnapshot } from 'monadsync';
import { FSFolder } from '../FSFolder.js';
import { createPresignProvider } from '../presignProvider.js';

const DEFAULT_FS_EXCLUDES = ['node_modules', '.git', '.env', '.DS_Store', '.mnemonad', '.claude', 'pnpm-lock.yaml', 'package-lock.json'];

export function makeExcludes(args) {
    if (!args.exclude) return undefined;
    const extra = args.exclude.split(',').map(s => s.trim());
    return [...DEFAULT_FS_EXCLUDES, ...extra];
}

/**
 * Resolves how a writing command (push, watch, compact) offloads large items, as extra
 * fields to spread into a `Mnemonad`/`Mnemonad.create` params object. Precedence:
 *
 *   1. `--pinata-jwt` — a direct Pinata credential, no signing needed. Goes through
 *      `MnemonadPinataProvider` (not a bare `pinningJwt` field): the default `MnemonadIpfs`
 *      Mnemonad would otherwise build needs an explicit `pinningUrl` too, which
 *      `MnemonadPinataProvider` supplies — passing `pinningJwt` alone to the plain
 *      constructor path silently never enables write capability at all.
 *   2. `--presign-url` (or its config-file/env-var default — see bin/mnemonad.js) — no
 *      credential needed; the account itself signs a request proving it paid the on-chain
 *      escrow, and the presign server exchanges that for a one-shot upload URL (see
 *      presign-server/README.md). Requires a signing `account` (the caller only reaches
 *      this branch from a write path, which already has one).
 *   3. Neither configured — just `gatewayUrl`, which is read-only: no offload capability at
 *      all, so a push with an oversized item fails with a clear error instead of silently
 *      falling back to something the caller didn't ask for.
 *
 * @param {Object} args - parsed CLI args
 * @param {Object} account - viem account signing this command's writes
 * @returns {{offloadingProvider: Object} | {gatewayUrl: ?string}}
 */
export function resolveOffloadParams(args, account) {
    if (args.pinataJwt) {
        return { offloadingProvider: new MnemonadPinataProvider({ pinningJwt: args.pinataJwt, gatewayUrl: args.gatewayUrl }) };
    }
    if (args.presignUrl) {
        return { offloadingProvider: createPresignProvider({ presignUrl: args.presignUrl, gatewayUrl: args.gatewayUrl, account }) };
    }
    return { gatewayUrl: args.gatewayUrl };
}

/**
 * Resolves a folder path argument. Deliberately does NOT fall back to `process.cwd()` when
 * `p` is missing — every command that touches a folder requires the caller to name it
 * explicitly, so a typo'd or omitted `path` never silently operates on whatever directory
 * the CLI happened to be run from.
 */
export function resolvePath(p) {
    if (!p) {
        const err = new Error('a folder path is required (e.g. `mnemonad <command> ... /path/to/folder`)');
        err._isUserError = true;
        throw err;
    }
    if (p.startsWith('~')) return join(homedir(), p.slice(1));
    return resolve(p);
}

export function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatPath(path) {
    const home = homedir();
    if (path.startsWith(home)) {
        return '~' + path.slice(home.length);
    }
    return path;
}

/**
 * Address that owns the stream, or null when it can't be determined (RPC failure, or the
 * stream doesn't exist yet — `ownerOf` on a nonexistent token id reverts).
 */
export async function getStreamOwner(mn) {
    try {
        return await mn.owner();
    } catch {
        return null;
    }
}

/**
 * Fail before any push when the signer doesn't own the stream — otherwise on-chain storage
 * (and any IPFS pin) gets paid for and only the final write is rejected. Stays quiet when
 * ownership can't be determined and lets the chain decide.
 *
 * An EVM address comparison via viem's `getAddress` (checksum-normalizes both sides) is all
 * that's needed here.
 */
export async function assertStreamOwner(mn, signerAddress) {
    const owner = await getStreamOwner(mn);
    if (!owner || !signerAddress) return;
    if (getAddress(owner) === getAddress(signerAddress)) return;

    const err = new Error(
        `stream ${mn.id} is owned by ${owner}\n` +
        `  but you are signing as ${signerAddress}.\n` +
        `  Nothing was uploaded. Use the owner's key (--key / --phrase / MNEMONAD_KEY),\n` +
        `  or run push without a stream id to create your own stream.`
    );
    err._isUserError = true;
    throw err;
}

/**
 * Unlocks `mn` for reading/writing an encrypted stream from just a password, correctly
 * fetching that stream's own persisted salt (`streamMeta.kek`) via `Mnemonad.unlockWithPassword`.
 *
 * Passing `password` straight to the `Mnemonad` constructor only works when *creating* a
 * new stream (`Mnemonad.create()` generates and publishes the salt itself, so the instance
 * doing the creating already has the matching one). Reopening an *existing* encrypted
 * stream from a separate instance — which is what every read/re-push path here does — needs
 * that already-published salt, and only `unlockWithPassword()` fetches it; passing the
 * password to the constructor instead silently derives a key from a fresh, different salt,
 * and every subsequent read/write then fails deep inside decryption with an opaque
 * "aes-gcm: invalid tag", or (worse, on a write) succeeds but wraps a key nothing else can
 * ever unwrap again.
 *
 * Throws the same friendly, guaranteed-correct message every command wants when the stream
 * is encrypted and no password was given; does nothing for a public stream.
 *
 * @param {import('mnemonad').default} mn
 * @param {?string} password
 * @returns {Promise<boolean>} whether the stream was encrypted (and, if so, is now unlocked)
 */
export async function unlockStream(mn, password) {
    await mn.initialize();
    if (!(await mn.isEncrypted())) return false;
    if (!password) {
        throw new Error('This stream is encrypted. Provide --password to decrypt.');
    }
    await mn.unlockWithPassword(password);
    return true;
}

export async function countTree(folder) {
    let files = 0;
    let folders = 0;
    const children = await folder.list();
    for (const child of children) {
        if (child.getContent) {
            files++;
        } else {
            folders++;
            const sub = await countTree(child);
            files += sub.files;
            folders += sub.folders;
        }
    }
    return { files, folders };
}

export function hashContent(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export async function readManifest(destPath) {
    try {
        const raw = await readFile(join(destPath, '.mnemonad'), 'utf8');
        return JSON.parse(raw);
    } catch { return null; }
}

export async function writeManifest(destPath, manifest) {
    await writeFile(join(destPath, '.mnemonad'), JSON.stringify(manifest, null, 2));
}

export const DISK_EXCLUDES = new Set(['.mnemonad', '.git', '.DS_Store', 'node_modules']);

export async function hashDiskTree(dirPath, prefix = []) {
    const files = {};
    let entries;
    try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return files; }
    for (const entry of entries) {
        if (DISK_EXCLUDES.has(entry.name) || entry.name.startsWith('.')) continue;
        const relParts = [...prefix, entry.name];
        const relPath = relParts.join('/');
        const fullPath = join(dirPath, entry.name);
        if (entry.isFile()) {
            const buf = await readFile(fullPath);
            files[relPath] = hashContent(buf);
        } else if (entry.isDirectory()) {
            Object.assign(files, await hashDiskTree(fullPath, relParts));
        }
    }
    return files;
}

export async function localTreeHash(dirPath) {
    const fsFolder = new FSFolder(dirPath);
    const children = await fsFolder.list();
    if (children.length === 0) return null;

    const sync = new SyncEngine();
    const store = new CDCStore();
    const snapshotBytes = await sync.buildSnapshot({ root: fsFolder, store });
    return new SyncSnapshot(snapshotBytes).treeHash;
}

export async function syncMemoryFolderToDisk(folder, destPath, oldFiles) {
    const newFiles = {};
    const newDirs = new Set();
    const stats = { written: 0, skipped: 0, deleted: 0, folders: 0, bytes: 0 };

    // walkAndSync only mkdir's a child directory as it descends into it — a root-level file
    // (no subfolder ever created first) would otherwise fail to write into a destPath that
    // doesn't exist yet, e.g. the very first `pull` into a brand-new directory.
    await mkdir(destPath, { recursive: true });
    await walkAndSync(folder, destPath, [], oldFiles, newFiles, newDirs, stats);

    if (oldFiles) {
        for (const relPath of Object.keys(oldFiles)) {
            if (!(relPath in newFiles)) {
                const absPath = join(destPath, ...relPath.split('/'));
                await rm(absPath, { force: true });
                stats.deleted++;
            }
        }
    }

    await removeStaleDirectories(destPath, newDirs);

    return { stats, newFiles };
}

export function hashMapsEqual(a, b) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k, i) => k === keysB[i] && a[k] === b[k]);
}

export async function hashLocalTree(fsFolder, prefix = []) {
    const files = {};
    const children = await fsFolder.list();
    for (const child of children) {
        const relParts = [...prefix, child.name];
        const relPath = relParts.join('/');
        if (child.getContent) {
            const content = await child.getContent();
            files[relPath] = hashContent(content);
        } else {
            Object.assign(files, await hashLocalTree(child, relParts));
        }
    }
    return files;
}

async function walkAndSync(folder, destPath, prefix, oldFiles, newFiles, newDirs, stats) {
    const children = await folder.list();

    for (const child of children) {
        const relParts = [...prefix, child.name];
        const relPath = relParts.join('/');
        const absPath = join(destPath, child.name);

        if (child.getContent) {
            const content = await child.getContent();
            const hash = hashContent(content);
            newFiles[relPath] = hash;

            if (oldFiles && oldFiles[relPath] === hash) {
                stats.skipped++;
            } else {
                await writeFile(absPath, content);
                stats.written++;
                stats.bytes += content.length;
            }
        } else {
            await mkdir(absPath, { recursive: true });
            newDirs.add(relPath);
            stats.folders++;
            await walkAndSync(child, absPath, relParts, oldFiles, newFiles, newDirs, stats);
        }
    }
}

async function removeStaleDirectories(destPath, newDirs) {
    let entries;
    try { entries = await readdir(destPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (DISK_EXCLUDES.has(entry.name) || entry.name.startsWith('.')) continue;
        const fullPath = join(destPath, entry.name);
        if (!newDirs.has(entry.name)) {
            await rm(fullPath, { recursive: true, force: true });
        } else {
            await removeStaleSubdirs(fullPath, entry.name, newDirs);
        }
    }
}

async function removeStaleSubdirs(dirPath, prefix, newDirs) {
    let entries;
    try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const relPath = prefix + '/' + entry.name;
        const fullPath = join(dirPath, entry.name);
        if (!newDirs.has(relPath)) {
            await rm(fullPath, { recursive: true, force: true });
        } else {
            await removeStaleSubdirs(fullPath, relPath, newDirs);
        }
    }
}
