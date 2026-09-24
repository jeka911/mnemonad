import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { getAddress } from 'viem';
import { MnemonadPinataProvider, kekMethodOf } from 'mnemonad';

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
 *
 * `mustExist` additionally requires the folder to be there already. Every command that
 * *reads* the local folder passes it, because the alternative is worse than an error in
 * both directions: `push`/`compact` used to surface a raw ENOENT stack trace from deep
 * inside `readdir`, and `diff` used to treat a missing folder as an empty one and report
 * every file in the stream as locally deleted — which reads as "your data is gone" rather
 * than "you typed the wrong path". `pull` is the one command that leaves it off, since
 * creating the destination is exactly its job.
 *
 * @param {?string} p
 * @param {Object} [options]
 * @param {boolean} [options.mustExist=false]
 */
export function resolvePath(p, { mustExist = false } = {}) {
    if (!p) {
        throw userError('a folder path is required (e.g. `mnemonad <command> ... /path/to/folder`)');
    }

    const resolved = p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p);
    if (!mustExist) return resolved;

    const stat = statOrNull(resolved);
    if (!stat) {
        throw userError(
            `no such folder: ${resolved}\n` +
            '  Create it first, or use `mnemonad pull <stream-id> <path>` to fetch one into it.'
        );
    }
    if (!stat.isDirectory()) {
        throw userError(`not a folder: ${resolved}\n  This command syncs a directory, not a single file.`);
    }
    return resolved;
}

/** @returns {?import('node:fs').Stats} null when the path doesn't exist or isn't readable. */
function statOrNull(path) {
    try {
        return statSync(path);
    } catch {
        return null;
    }
}

/** Whether `path` is an existing directory. For a command that reports on one rather than
 *  refusing to run without it (see info.js). */
export function folderExists(path) {
    return statOrNull(path)?.isDirectory() === true;
}

/**
 * Canonical display form for a stream id: `0x` + the full 32-byte token id, zero-padded,
 * lowercase. Matches the dApp's own formatting (explorer/src/includes/formatStreamId.js),
 * unelided — a CLI command needs the whole id to actually reuse, where the dApp's UI only
 * needs enough of it to recognize at a glance.
 *
 * Takes whatever a stream id shows up as in this codebase — a bigint (`mn.id`), or a raw
 * CLI arg that's either a decimal or a `0x`-hex string — since `BigInt()` parses all three
 * natively; see bin/mnemonad.js's own `isStreamId` for why both string forms are accepted
 * as input in the first place.
 *
 * @param {bigint|string} id
 * @returns {string}
 */
export function formatStreamId(id) {
    return '0x' + BigInt(id).toString(16).padStart(64, '0');
}

/**
 * Whether two stream ids refer to the same token, regardless of which form either was
 * written in (decimal, hex, differently-padded hex) — a plain `===` on the raw strings
 * would wrongly call `123` and `0x7b` different streams.
 */
export function streamIdsEqual(a, b) {
    if (a == null || b == null) return a === b;
    return BigInt(a) === BigInt(b);
}

/** Networks a qualified stream id can name — see `parseQualifiedStreamId` below. Kept in
 *  sync by hand with `chainClient.js`'s own `CHAINS` map (which also lists `local`, never
 *  meaningful here — no URL is ever built with it) and with the explorer's
 *  `src/settings.js` `NETWORKS` map, the source these prefixes actually come from. */
export const NETWORK_PREFIXES = ['testnet', 'mainnet'];

/**
 * Splits the network-qualified stream-id form the explorer's URLs use — `<network>-0x<hex>`
 * (or `<network>-<decimal>`), e.g. `testnet-0x648f18…` — into its network and bare id. Same
 * split the explorer's own `streamRouteId()`/`parseStreamRouteId()`
 * (`explorer/src/includes/streamRoute.js`) do, so an id copied straight out of a
 * `/stream/<id>` link parses here too, instead of failing `BigInt()` on the whole string.
 *
 * Returns null for anything that isn't this exact shape — an unqualified id, a malformed
 * one, or a prefix that isn't a known network (not a stream on some network this build
 * hasn't heard of, just not this form).
 *
 * @param {string} s
 * @returns {{network: string, id: string}|null}
 */
export function parseQualifiedStreamId(s) {
    if (typeof s !== 'string') return null;
    const dash = s.indexOf('-');
    if (dash === -1) return null;
    const prefix = s.slice(0, dash).toLowerCase();
    if (!NETWORK_PREFIXES.includes(prefix)) return null;
    const rest = s.slice(dash + 1);
    if (!/^0x[0-9a-fA-F]+$/.test(rest) && !/^\d+$/.test(rest)) return null;
    return { network: prefix, id: rest };
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
        `stream ${formatStreamId(mn.id)} is owned by ${owner}\n` +
        `  but you are signing as ${signerAddress}.\n` +
        `  Nothing was uploaded. Use the owner's key (--key, --phrase, or the MNEMONAD_KEY\n` +
        `  env var, set to the private key),\n` +
        `  or run push without a stream id to create your own stream.`
    );
    err._isUserError = true;
    throw err;
}

/**
 * Decides how a NEW stream should be keyed, from the encryption flags given.
 *
 * `--encrypt` alone is rejected rather than guessed at: both methods are reachable from the
 * same invocation (the `--key` account can always sign), and picking one silently would
 * decide, unprompted, whether the stream is recoverable by a password or bound forever to
 * whatever key happened to be in the environment.
 *
 * @param {Object} args - parsed CLI args
 * @returns {?('password'|'wallet')} `null` when the stream should stay unencrypted
 */
export function resolveEncryptMethod(args) {
    const requested = args.encryptWith || (args.password ? 'password' : null);

    if (!args.encrypt) {
        if (args.encryptWith) {
            throw userError('--encrypt-with needs --encrypt (it only applies when creating a stream)');
        }
        return null;
    }
    if (!requested) {
        throw userError(
            '--encrypt needs a method: --encrypt-with password (with --password), or\n' +
            '  --encrypt-with wallet to key it to the --key/--phrase account\'s signature'
        );
    }
    if (requested !== 'password' && requested !== 'wallet') {
        throw userError(`unknown --encrypt-with '${requested}', expected password or wallet`);
    }
    if (requested === 'password' && !args.password) {
        throw userError('--encrypt-with password needs --password');
    }
    if (requested === 'wallet' && args.password) {
        throw userError(
            '--encrypt-with wallet takes no --password — a wallet-keyed stream is unwrapped by\n' +
            '  the owner\'s signature, and the two methods cannot both key one stream'
        );
    }
    return requested;
}

/**
 * Unlocks `mn` for reading/writing an encrypted stream, whichever way it was keyed.
 *
 * Which credential to try comes from the stream's own published `kek` block via
 * `kekMethodOf` — but only as a *hint*: stream metadata is written once at creation and can
 * never be corrected, while the owner can rewrap under a different method at any time. The
 * GCM tag on the wrapped key is the authority, and a mismatch surfaces as the SDK's typed
 * `KEK_MISMATCH` error either way.
 *
 * Neither credential is ever passed to the `Mnemonad` constructor here. For a password that
 * would silently derive a key from a *fresh* salt instead of the stream's published one, and
 * every later read/write would fail deep inside decryption (or, worse, succeed and wrap a
 * key nothing else can ever unwrap). `unlockWithPassword`/`unlockWithSignature` are the only
 * paths that read what the stream actually published.
 *
 * @param {import('mnemonad').default} mn
 * @param {Object} [credentials]
 * @param {?string} [credentials.password]
 * @param {?Object} [credentials.signer] - viem WalletClient/Account, for a wallet-keyed stream
 * @returns {Promise<boolean>} whether the stream was encrypted (and, if so, is now unlocked)
 */
export async function unlockStream(mn, credentials = {}) {
    const { password = null, signer = null } = credentials;

    await mn.initialize();
    if (!(await mn.isEncrypted())) return false;

    const method = kekMethodOf({ kek: mn.streamMeta.kek, encrypted: true });

    if (method === 'password') {
        if (!password) {
            throw userError('This stream is encrypted with a password. Provide --password to decrypt.');
        }
        await mn.unlockWithPassword(password);
        return true;
    }

    // 'signature' — including every stream created before the method marker existed, which
    // published no kek block at all.
    if (!signer) {
        throw userError(
            'This stream is encrypted to its owner\'s wallet. Provide the owner\'s key with\n' +
            '  --key, --phrase, or the MNEMONAD_KEY env var (set it to the private key) to decrypt it.'
        );
    }
    await mn.unlockWithSignature(signer);
    return true;
}

function userError(message) {
    const err = new Error(message);
    err._isUserError = true;
    return err;
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

/**
 * Recovers a stream id from the folder's own `.mnemonad` manifest when `--manifest` was
 * passed and no id was given on the command line — the whole point of writing the manifest
 * is that the id doesn't have to be remembered or re-typed for every later command on the
 * same folder. Mutates `args.streamId` in place (every call site reads it back off `args`
 * afterward) and is a no-op whenever an id was already given or `--manifest` wasn't passed —
 * so it's safe to call unconditionally right after resolving the folder path.
 *
 * Silent when there's nothing to find (no `.mnemonad` yet, e.g. a folder's very first push,
 * or a manifest with no `streamId`) — the caller's own "stream-id is required" error covers
 * that case with the wording appropriate to its command.
 *
 * @param {Object} args - parsed CLI args, mutated in place
 * @param {string} destPath - resolved folder path to look for `.mnemonad` in
 * @returns {Promise<?string>} the resolved stream id, or whatever `args.streamId` already was
 */
export async function discoverStreamId(args, destPath) {
    if (args.streamId || !args.manifest) return args.streamId;
    const manifest = await readManifest(destPath);
    if (manifest?.streamId) {
        console.log('  using stream id from .mnemonad manifest:', formatStreamId(manifest.streamId));
        args.streamId = manifest.streamId;
    }
    return args.streamId;
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
