import Mnemonad from 'mnemonad';
import { MonadSync } from 'monadsync';
import { FSFolder } from '../FSFolder.js';
import { makeChainClient, requireWalletClient } from '../chainClient.js';
import {
    resolvePath,
    makeExcludes,
    formatBytes,
    countTree,
    assertStreamOwner,
    unlockStream,
    resolveOffloadParams,
} from './shared.js';

/**
 * Monad has no rebate/refund concept — truncating a stream's history here gives back no
 * gas, only a shorter replay for future `restore()`/`initialize()` calls. This drops old
 * history, then forces a full snapshot, without pretending there's a cost refund attached
 * to it.
 */
export async function compact(args) {
    if (!args.streamId) {
        throw new Error('stream-id is required for compact');
    }

    const destPath = resolvePath(args.path, { mustExist: true });
    const fsFolder = new FSFolder(destPath, makeExcludes(args));

    const counts = await countTree(fsFolder);
    console.log('  scanning...', counts.files, 'files,', counts.folders, 'folders');

    const client = makeChainClient(args);
    requireWalletClient(client);

    // No `password` at construction — see shared.js's unlockStream() for why.
    const mn = new Mnemonad({
        publicClient: client.publicClient,
        walletClient: client.walletClient,
        contractAddress: client.contractAddress,
        id: args.streamId,
        ...resolveOffloadParams(args, client.account),
    });

    await assertStreamOwner(mn, client.account.address);
    await unlockStream(mn, { password: args.password, signer: client.walletClient });

    console.log('step 1: truncating existing history...');
    const droppedCount = mn.length - mn.firstAvailableIndex;
    if (droppedCount > 0) {
        // Drops everything up to (not including) the stream's current length — the
        // upcoming full-snapshot push becomes the new sole baseline for restore/replay.
        await mn.truncateFrom(mn.length);
        console.log('  dropped', droppedCount, 'history entries');
    } else {
        console.log('  nothing to drop (stream is empty)');
    }

    console.log('step 2: pushing local state as fresh snapshot...');

    const monadSync = new MonadSync({ mnemonad: mn, compress: args.compress || 'gzip' });

    // Skip monadSync's own replay entirely: compact always pushes a full snapshot, so
    // there's nothing to replay against. Same escape hatch monadsync/README.md's
    // "Repairing a corrupt chain" section documents.
    mn.reInitialize();
    await mn.initialize();
    monadSync._isInitialized = true;
    monadSync._lastSnapshot = null;
    monadSync._replayedCount = mn.length;

    const result = await monadSync.push(fsFolder);

    mn.reInitialize();
    await mn.initialize();

    console.log('  pushed version', result.version);

    console.log('\ncompact complete:');
    console.log('  new version:      ', result.version);
    console.log('  new on-chain size:', formatBytes(mn.binaryLength));
    if (droppedCount > 0) {
        console.log('  future restore()/initialize() no longer replay the', droppedCount, 'dropped entries —',
            'faster reads, not a cost refund.');
    }
}
