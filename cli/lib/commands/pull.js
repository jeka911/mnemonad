import Mnemonad from 'mnemonad';
import { MonadSync } from 'monadsync';
import { makeChainClient } from '../chainClient.js';
import {
    resolvePath,
    formatBytes,
    hashDiskTree,
    syncMemoryFolderToDisk,
    writeManifest,
    unlockStream,
    formatStreamId,
    discoverStreamId,
} from './shared.js';
import { settleStreamJobs } from '../jobs.js';

export async function pull(args) {
    // Resolved up front (throws if missing) so a missing path fails fast, before any chain
    // work — see resolvePath()'s own comment for why this is never defaulted to cwd.
    const destPath = resolvePath(args.path);

    // With --manifest and no id, a folder pulled/pushed before already has one recorded —
    // no need to require it again.
    await discoverStreamId(args, destPath);
    if (!args.streamId) {
        throw new Error('stream-id is required for pull');
    }

    // Pulling while a background push of this folder is still sending would restore the
    // version before it — and delete the very files that push is uploading.
    await settleStreamJobs(args, { reason: 'so the pull includes it' });

    const client = await makeChainClient(args);

    const mn = new Mnemonad({
        publicClient: client.publicClient,
        walletClient: client.walletClient,
        contractAddress: client.contractAddress,
        id: args.streamId,
        gatewayUrl: args.gatewayUrl,
    });
    const monadSync = new MonadSync({ mnemonad: mn });

    // See unlockStream()'s own comment for why `password` isn't passed to the constructor
    // above: reopening an existing encrypted stream needs its own already-published salt,
    // which only unlockWithPassword() (called inside unlockStream) fetches correctly.
    await unlockStream(mn, { password: args.password, signer: client.walletClient });

    const version = args.version != null ? Number(args.version) : undefined;
    console.log('restoring', formatStreamId(args.streamId), version != null ? 'at version ' + version : '(latest)', '...');

    let folder;
    try {
        folder = await monadSync.restore(version);
    } catch (err) {
        if (err.code === 'KEK_MISMATCH' || err.message?.includes('decrypt') || err.message?.includes('invalid tag')) {
            // unlockStream() above already demanded the right *kind* of credential, so
            // reaching here means the one supplied didn't actually open this stream.
            throw new Error('Could not decrypt this stream: ' + err.message);
        }
        throw err;
    }

    const oldFiles = await hashDiskTree(destPath);

    const { stats, newFiles } = await syncMemoryFolderToDisk(folder, destPath, oldFiles);

    if (args.manifest) {
        await mn.initialize();
        const pulledVersion = version ?? mn.length;
        // Canonical form stored — see push.js's own writeManifest call for why.
        await writeManifest(destPath, { streamId: formatStreamId(args.streamId), version: pulledVersion, files: newFiles });
    }

    console.log(' ', stats.written, 'written,', stats.skipped, 'unchanged,',
                stats.deleted, 'deleted', '(' + formatBytes(stats.bytes) + ')');
}
