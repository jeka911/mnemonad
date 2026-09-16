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
    resolveOffloadParams,
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
        if (streamId && manifest && manifest.streamId === streamId && manifest.files) {
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

    let mn;
    if (!streamId) {
        // Encryption is opt-in, password/signer-based. `password` is only ever passed to the
        // constructor here, on the instance that is itself calling `create()` — it generates
        // and publishes its own salt, so there's no existing salt to fetch. See
        // unlockStream()'s own comment for why every other path (including re-pushing to an
        // already-encrypted stream below) must NOT do this.
        const createParams = { ...baseParams };
        if (args.encrypt) createParams.encrypt = true;
        if (args.password) createParams.password = args.password;
        console.log('creating new stream on', args.chain, args.encrypt ? '(encrypted)' : '(public)', '...');
        mn = await Mnemonad.create(createParams);
        streamId = mn.id.toString();
        console.log('  created:', streamId);
    } else {
        mn = new Mnemonad({ ...baseParams, id: streamId });
        await assertStreamOwner(mn, client.account.address);
        await unlockStream(mn, args.password);
        if (args.encrypt) {
            console.log('  note: --encrypt only applies when creating a new stream; pushing to an existing stream keeps its current encryption');
        }
    }

    console.log('syncing ./ →', streamId);

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
    console.log('  stream:', streamId);

    if (args.manifest) {
        const localFiles = await hashLocalTree(fsFolder);
        await writeManifest(destPath, { streamId, version: result.version, files: localFiles });
    }
}
