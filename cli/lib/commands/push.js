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
    discoverStreamId,
    userError,
    formatBytes,
    formatPath,
} from './shared.js';
import { updateIndex, checkIndex, indexDbName } from './buildIndex.js';
import { streamKey, waitForJobs, settleStreamJobs, startPushJob } from '../jobs.js';
import { formatEther } from 'viem';

export async function push(args) {
    const destPath = resolvePath(args.path, { mustExist: true });

    // With --manifest and no id, a folder pushed before already has one recorded — reuse it
    // rather than falling into the "no id" branch below and creating a second, unrelated
    // stream for the same folder.
    await discoverStreamId(args, destPath);
    let streamId = args.streamId;

    if (args.detach) {
        // Creating a stream prints the id the user has to keep, and needs signatures that have
        // to be seen to succeed — nothing worth handing off. --passkey's signer is a browser
        // tab that closes when this process exits.
        if (!streamId) {
            throw userError(
                '--detach only pushes to an existing stream. Pass its id, or --manifest on a folder\n' +
                '  that has a .mnemonad, or push once without --detach to create the stream first.'
            );
        }
        if (args.passkey) {
            throw userError('--detach can\'t be combined with --passkey: the browser tab signing for it closes when this command exits.');
        }
    }

    // A background push still sending to this stream means its next version isn't on chain
    // yet — building on top of the current tip now would only lose the race to it.
    await settleStreamJobs(args, { reason: 'before building the next version on top of it' });

    // Before anything is scanned or signed: the push below then picks the updated index up
    // like any other file. A failure stops the push outright — a push that silently went out
    // without the index asked for would leave the stream unsearchable with no sign of why.
    if (args.rebuild && !args.index) {
        throw userError('--rebuild only applies with --index (it starts the search index over)');
    }
    if (args.index) {
        console.log(args.rebuild ? '  rebuilding search index...' : '  updating search index...');
        try {
            await updateIndex(destPath, args, { quiet: true });
        } catch (err) {
            throw userError(`indexing failed, so nothing was pushed: ${err.message}`);
        }
    } else {
        await warnIfIndexStale(destPath, args);
    }

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

    const client = await makeChainClient(args);
    requireWalletClient(client);

    // Same wallet, different stream: two processes sending at once would race for one nonce.
    await waitForJobs(
        { signer: client.account.address, chain: args.chain },
        { reason: 'so the two pushes don\'t race for the same wallet nonce' },
    );

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

    if (args.detach) {
        await detachPush({ args, mn, monadSync, fsFolder, client, streamId, destPath, existingVersions });
        return;
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

/**
 * `push --detach`: everything up to a finished patch runs here, so every error a user can act
 * on still surfaces before this command exits. Only the sending — transactions, receipts, an
 * IPFS upload — goes to a detached child (see lib/jobs.js), and this process exits as soon
 * as it has started.
 *
 * The patch is frozen now: files edited after this command returns go into the next push,
 * not this one. The manifest's file hashes are taken at the same moment for the same reason.
 */
async function detachPush({ args, mn, monadSync, fsFolder, client, streamId, destPath, existingVersions }) {
    console.log('  building patch...');
    const prepared = await monadSync.preparePush(fsFolder);

    // A single-item patch is the common case and the only one estimatePushCost models; a
    // segmented one (over 8 MB) just goes without an estimate rather than a wrong one.
    let cost = null;
    if (prepared.itemCount === 1) {
        try {
            cost = await mn.estimatePushCost(prepared.patchBytes);
        } catch {
            // No estimate is not a reason to stop — the child surfaces any real send error.
        }
    }
    if (cost) {
        const balance = await client.publicClient.getBalance({ address: client.account.address });
        if (balance < cost.total) {
            throw userError(
                `not enough MON to push: about ${formatEther(cost.total)} needed, ` +
                `${formatEther(balance)} in ${client.account.address}. Nothing was sent.`
            );
        }
    }

    const files = args.manifest ? await hashLocalTree(fsFolder) : null;
    const job = await startPushJob(
        {
            streamId: formatStreamId(streamId),
            streamKey: streamKey({ chain: args.chain, contractAddress: args.contractAddress, streamId }),
            chain: args.chain,
            signer: client.account.address,
            folder: destPath,
            baseLength: prepared.baseLength,
            version: prepared.version,
            kind: prepared.kind,
            bytes: prepared.patchBytes.length,
            manifest: files ? { files } : null,
            // Everything the child needs to rebuild the same chain client — never a secret.
            args: {
                chain: args.chain,
                rpcUrl: args.rpcUrl,
                contractAddress: args.contractAddress,
                gatewayUrl: args.gatewayUrl,
                presignUrl: args.presignUrl,
            },
        },
        prepared.patchBytes,
        {
            key: args.key || process.env.MNEMONAD_KEY || null,
            phrase: args.phrase,
            password: args.password,
            pinataJwt: args.pinataJwt,
        },
    );

    const patchType = existingVersions === 0 || prepared.kind === 'patch' ? 'full snapshot' : 'diff';
    const compressedNote = args.compress !== false ? ', gzip compressed' : '';
    console.log('  version', prepared.version, 'prepared (' + patchType + compressedNote + ', ' + formatBytes(prepared.patchBytes.length) + ')');
    if (cost) console.log('  estimated cost:', formatEther(cost.total), 'MON');
    console.log('  stream:', formatStreamId(streamId));
    console.log('  sending in the background: job', job.id, '(pid ' + job.pid + ')');
    console.log('  log:  ', formatPath(job.dir + '/push.log'));
    console.log('  check: mnemonad info', formatPath(destPath) + (args.manifest ? ' --manifest' : ''));
}

/**
 * A folder that already carries an index, pushed without `--index` after its files changed,
 * would publish an index that no longer matches them — searches keep returning the old text's
 * offsets. Cheap to catch (a hash per file, no model load, the index opened read-only) and
 * worth a line; never a reason to fail the push itself.
 */
async function warnIfIndexStale(destPath, args) {
    let status;
    try {
        status = await checkIndex(destPath, args);
    } catch {
        return;
    }
    if (!status || status.total === 0) return;
    const parts = [];
    if (status.changed.length) parts.push(`${status.changed.length} changed`);
    if (status.added.length) parts.push(`${status.added.length} new`);
    if (status.removed.length) parts.push(`${status.removed.length} removed`);
    console.log(
        `  note: ${indexDbName(args)} is out of date (${parts.join(', ')} file(s) since it was built).\n` +
        '        Push with --index to update it first, or run `mnemonad index <path>`.'
    );
}
