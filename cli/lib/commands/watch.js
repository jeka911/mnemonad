import { watch as fsWatch } from 'node:fs';
import Mnemonad from 'mnemonad';
import { MonadSync } from 'monadsync';
import { FSFolder } from '../FSFolder.js';
import { makeChainClient, requireWalletClient } from '../chainClient.js';
import {
    resolvePath,
    makeExcludes,
    formatPath,
    localTreeHash,
    hashDiskTree,
    syncMemoryFolderToDisk,
    DISK_EXCLUDES,
    assertStreamOwner,
    unlockStream,
    resolveOffloadParams,
    formatStreamId,
    discoverStreamId,
} from './shared.js';

function timestamp() {
    return new Date().toTimeString().slice(0, 8);
}

function hashesEqual(a, b) {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export async function watch(args) {
    const cwd = resolvePath(args.path, { mustExist: true });

    // With --manifest and no id, a folder pulled/pushed before already has one recorded —
    // no need to require it again.
    await discoverStreamId(args, cwd);
    if (!args.streamId) throw new Error('stream-id is required for watch');
    const debounceMs = args.debounce ?? 5000;
    const pollIntervalMs = (args.pollInterval ?? 2) * 1000;
    const pushEnabled = !args.pullOnly;
    const pullEnabled = !args.pushOnly;

    const excludes = makeExcludes(args);

    const client = makeChainClient(args);
    if (pushEnabled) requireWalletClient(client);

    // Only a push-enabled session needs write-side offload capability (pinata-jwt or
    // presign) — a pull-only mirror only ever reads, so it gets just gatewayUrl.
    const offloadParams = pushEnabled ? resolveOffloadParams(args, client.account) : { gatewayUrl: args.gatewayUrl };

    // No `password` at construction — see shared.js's unlockStream() for why; unlocked
    // explicitly right below instead, once for the whole watch session.
    const mn = new Mnemonad({
        publicClient: client.publicClient,
        walletClient: pushEnabled ? client.walletClient : undefined,
        contractAddress: client.contractAddress,
        id: args.streamId,
        ...offloadParams,
    });

    await unlockStream(mn, { password: args.password, signer: client.walletClient });

    // Fail now rather than on the first local change, hours into a watch session.
    if (pushEnabled) {
        await assertStreamOwner(mn, client.account.address);
    }

    const monadSync = new MonadSync({ mnemonad: mn, compress: args.compress || 'gzip' });
    await monadSync.initialize();

    let remoteVersion = mn.length;
    let lastSyncedHash = await localTreeHash(cwd);
    let pushInFlight = false;
    let debounceTimer = null;

    console.log(`watching ${formatPath(cwd)}`);
    console.log(`  stream:        ${formatStreamId(args.streamId)}`);
    console.log(`  remote version: ${remoteVersion}`);
    console.log(`  push:          ${pushEnabled ? `enabled (debounce ${debounceMs}ms)` : 'disabled'}`);
    console.log(`  pull:          ${pullEnabled ? `enabled (poll every ${pollIntervalMs / 1000}s)` : 'disabled'}`);
    console.log('press Ctrl+C to stop\n');

    async function runPush() {
        if (!pushEnabled || pushInFlight) return;
        const newHash = await localTreeHash(cwd);
        if (hashesEqual(newHash, lastSyncedHash)) return;

        pushInFlight = true;
        try {
            // Best-effort race guard, not an atomic one. Mnemonad's contract *does* check an
            // `expectedLength` atomically (Mnemonad.sol's `_checkLength`/`LengthMismatch`) —
            // that closes the index race outright: two writers can never land at the same
            // position, one just reverts. What it can't check is content: it stores opaque
            // bytes, with no way to verify a diff patch is actually consistent with the real
            // previous item. Re-checking here narrows the separate window where a concurrent
            // push (another `watch` session, or a manual push) lands at the *correct* index
            // but MonadSync still builds its diff against a snapshot the chain has since
            // moved past — the same failure mode monadsync's own snapshot-recovery tests
            // exercise. Confirmed live as a real corruption, not just theoretical — see
            // monadsync/README.md's "Repairing a corrupt chain".
            mn.reInitialize();
            await mn.initialize();
            if (mn.length !== remoteVersion) {
                console.log(`[${timestamp()}] remote changed while preparing push — resyncing before pushing`);
                monadSync.reInitialize();
                await monadSync.initialize();
                remoteVersion = mn.length;
            }

            const fsFolder = new FSFolder(cwd, excludes);
            console.log(`[${timestamp()}] change detected — pushing...`);
            const result = await monadSync.push(fsFolder);
            lastSyncedHash = newHash;
            remoteVersion = result.version;
            console.log(`[${timestamp()}] pushed version ${result.version}`);
        } catch (err) {
            console.error(`[${timestamp()}] push error:`, err.message);
        } finally {
            pushInFlight = false;
        }
    }

    async function runPoll() {
        if (!pullEnabled || pushInFlight) return;
        try {
            mn.reInitialize();
            await mn.initialize();
            if (mn.length <= remoteVersion) return;

            const newRemoteVersion = mn.length;

            // Always resync monadSync when remote has advanced. Without this, its own
            // internal snapshot/replay state stays at the old version while mn.length has
            // moved on — the next push would build a diff against the wrong base,
            // corrupting the chain.
            monadSync.reInitialize();

            const localNow = await localTreeHash(cwd);

            if (!hashesEqual(localNow, lastSyncedHash)) {
                console.log(`[${timestamp()}] remote has ${newRemoteVersion - remoteVersion} new version(s) but local has unpushed changes — skipping pull`);
                return;
            }

            console.log(`[${timestamp()}] remote advanced to version ${newRemoteVersion} — pulling...`);
            let folder;
            try {
                folder = await monadSync.restore();
            } catch (err) {
                console.error(`[${timestamp()}] pull failed (${err.message}) — skipping to version ${newRemoteVersion}; run \`pull\` manually`);
                remoteVersion = newRemoteVersion;
                return;
            }
            const oldFiles = await hashDiskTree(cwd);
            const { stats } = await syncMemoryFolderToDisk(folder, cwd, oldFiles);
            lastSyncedHash = await localTreeHash(cwd);
            remoteVersion = newRemoteVersion;
            console.log(`[${timestamp()}] pulled version ${remoteVersion} (${stats.written} written, ${stats.skipped} unchanged, ${stats.deleted} deleted)`);
        } catch (err) {
            console.error(`[${timestamp()}] poll error:`, err.message);
        }
    }

    const watcher = fsWatch(cwd, { recursive: true }, (eventType, filename) => {
        if (!pushEnabled) return;
        if (!filename) return;
        const base = filename.split('/')[0];
        if (DISK_EXCLUDES.has(base) || base.startsWith('.')) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runPush, debounceMs);
    });

    const poller = setInterval(runPoll, pollIntervalMs);

    let shutdownResolve;
    const shutdownPromise = new Promise((resolve) => {
        shutdownResolve = resolve;
    });

    function shutdown() {
        console.log('\nstopping watch...');
        clearTimeout(debounceTimer);
        clearInterval(poller);
        watcher.close();
        shutdownResolve();
    }
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    await shutdownPromise;
}
