import Mnemonad from 'mnemonad';
import { MonadSync } from 'monadsync';
import { FSFolder } from '../FSFolder.js';
import { makeChainClient, requireWalletClient } from '../chainClient.js';
import {
    resolvePath,
    makeExcludes,
    countTree,
    localTreeHash,
    readManifest,
    writeManifest,
    hashLocalTree,
    hashMapsEqual,
    assertStreamOwner,
    unlockStream,
    resolveEncryptMethod,
    resolveOffloadParams,
    formatStreamId,
    streamIdsEqual,
} from './shared.js';

export async function push(args) {
    let streamId = args.streamId;

    const destPath = resolvePath(args.path);
    const fsFolder = new FSFolder(destPath, makeExcludes(args));

    const counts = await countTree(fsFolder);
    console.log('  scanning...', counts.files, 'files,', counts.folders, 'folders');

    if (args.manifest) {
        const manifest = await readManifest(destPath);
        const localFiles = await hashLocalTree(fsFolder);
        if (streamId && manifest && streamIdsEqual(manifest.streamId, streamId) && manifest.files) {
            if (hashMapsEqual(localFiles, manifest.files)) {
                console.log('  no changes since last pull, nothing to push');
                return;
            }
        }
    }

    const client = makeChainClient(args);
    requireWalletClient(client);

    const baseParams = {
        publicClient: client.publicClient,
        walletClient: client.walletClient,
        contractAddress: client.contractAddress,
        ...resolveOffloadParams(args, client.account),
    };

    // Validated up front, so a bad flag combination fails before any chain work — including
    // on the push-to-existing path, where the encryption flags don't apply at all.
    const encryptMethod = resolveEncryptMethod(args);

    let mn;
    if (!streamId) {
        // The credential is only ever passed to the constructor *here*, on the instance
        // calling `create()` itself: it generates and publishes whatever a later reader needs
        // (a password salt, or the method marker), so there's nothing existing to fetch. See
        // unlockStream()'s own comment for why every other path must NOT do this.
        const createParams = { ...baseParams };
        if (encryptMethod === 'password') {
            createParams.encrypt = true;
            createParams.password = args.password;
        } else if (encryptMethod === 'wallet') {
            createParams.encrypt = true;
            // The same account that signs the create transaction also signs for the key —
            // so this asks the wallet twice, and only this account can ever decrypt it.
            createParams.signer = client.walletClient;
        }
        const how = encryptMethod === 'password' ? '(encrypted with a password)'
            : encryptMethod === 'wallet' ? '(encrypted to ' + client.account.address + ')'
            : '(public)';
        console.log('creating new stream on', args.chain, how, '...');
        mn = await Mnemonad.create(createParams);
        streamId = mn.id.toString();
        console.log('  created:', formatStreamId(streamId));
    } else {
        mn = new Mnemonad({ ...baseParams, id: streamId });
        await assertStreamOwner(mn, client.account.address);
        await unlockStream(mn, { password: args.password, signer: client.walletClient });
        if (args.encrypt) {
            console.log('  note: --encrypt only applies when creating a new stream; pushing to an existing stream keeps its current encryption');
        }
    }

    console.log('syncing ./ →', formatStreamId(streamId));

    const monadSync = new MonadSync({ mnemonad: mn, compress: args.compress || 'gzip' });

    let existingVersions = 0;
    if (args.forceSnapshot) {
        console.log('  skipping chain replay — pushing full snapshot...');
        await mn.initialize();
        // See monadsync/README.md's "Repairing a corrupt chain" section — this is the
        // documented escape hatch for forcing a full snapshot instead of a diff.
        monadSync._isInitialized = true;
        monadSync._lastSnapshot = null;
        monadSync._replayedCount = mn.length;
    } else {
        await monadSync.initialize();
        existingVersions = await monadSync.length();

        if (streamId && existingVersions > 0 && !args.manifest) {
            console.log('  comparing tree hashes...');
            const localHash = await localTreeHash(destPath);
            const remoteHash = await monadSync.getTreeHash(existingVersions);
            if (localHash && remoteHash.length === localHash.length &&
                localHash.every((b, i) => b === remoteHash[i])) {
                console.log('  no changes, nothing to push');
                return;
            }
        }
    }

    console.log('  building patch + pushing to chain...');
    const result = await monadSync.push(fsFolder);

    const patchType = args.forceSnapshot || existingVersions === 0 ? 'full snapshot' : 'diff';
    const compressedNote = args.compress !== false ? ', gzip compressed' : '';
    console.log('  version', result.version, 'pushed (' + patchType + compressedNote + ')');
    console.log('  stream:', formatStreamId(streamId));

    if (args.manifest) {
        const localFiles = await hashLocalTree(fsFolder);
        // Stored canonical (see formatStreamId) rather than whatever form the caller typed —
        // so a manifest written by a hex-id push and read back by a decimal-id one (or vice
        // versa) still matches; streamIdsEqual() above is the belt to this suspenders.
        await writeManifest(destPath, { streamId: formatStreamId(streamId), version: result.version, files: localFiles });
    }
}
