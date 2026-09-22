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
} from './shared.js';

export async function pull(args) {
    if (!args.streamId) {
        throw new Error('stream-id is required for pull');
    }
    // Resolved up front (throws if missing) so a missing path fails fast, before any chain
    // work — see resolvePath()'s own comment for why this is never defaulted to cwd.
    const destPath = resolvePath(args.path);

    const client = makeChainClient(args);

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
    console.log('restoring', args.streamId, version != null ? 'at version ' + version : '(latest)', '...');

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
        await writeManifest(destPath, { streamId: args.streamId, version: pulledVersion, files: newFiles });
    }

    console.log(' ', stats.written, 'written,', stats.skipped, 'unchanged,',
                stats.deleted, 'deleted', '(' + formatBytes(stats.bytes) + ')');
}
