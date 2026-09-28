import Mnemonad from 'mnemonad';
import { MonadSync } from 'monadsync';
import { FSFolder } from '../FSFolder.js';
import { makeChainClient } from '../chainClient.js';
import {
    resolvePath,
    makeExcludes,
    formatPath,
    hashLocalTree,
    unlockStream,
    formatStreamId,
    folderExists,
    discoverStreamId,
} from './shared.js';

export function compareFileMaps(localFiles, remoteFiles) {
    const added = [];
    const modified = [];
    const deleted = [];

    for (const path of Object.keys(localFiles)) {
        if (!(path in remoteFiles)) {
            added.push(path);
        } else if (localFiles[path] !== remoteFiles[path]) {
            modified.push(path);
        }
    }
    for (const path of Object.keys(remoteFiles)) {
        if (!(path in localFiles)) {
            deleted.push(path);
        }
    }

    added.sort();
    modified.sort();
    deleted.sort();

    return { added, modified, deleted };
}

export async function diff(args) {
    // Resolved up front (throws if missing) so a missing path fails fast, before any chain
    // work — see resolvePath()'s own comment for why this is never defaulted to cwd.
    //
    // Deliberately NOT `{ mustExist: true }`, unlike push/compact/watch: diffing a stream
    // against a folder you haven't pulled yet is a legitimate question ("what would I get?"),
    // and this command writes nothing either way. It is called out explicitly below though —
    // "everything deleted" for a folder that never existed reads as data loss rather than as
    // a wrong path.
    const destPath = resolvePath(args.path);

    // With --manifest and no id, a folder pulled/pushed before already has one recorded —
    // no need to require it again.
    await discoverStreamId(args, destPath);
    if (!args.streamId) {
        throw new Error('stream-id is required for diff');
    }

    const client = await makeChainClient(args);

    const mn = new Mnemonad({
        publicClient: client.publicClient,
        walletClient: client.walletClient,
        contractAddress: client.contractAddress,
        id: args.streamId,
        gatewayUrl: args.gatewayUrl,
    });
    const monadSync = new MonadSync({ mnemonad: mn });

    // See shared.js's unlockStream() for why `password` isn't passed to the constructor
    // above — this fetches the stream's own already-published salt instead of deriving a
    // key from a fresh one.
    await unlockStream(mn, { password: args.password, signer: client.walletClient });
    const totalVersions = mn.length;

    if (totalVersions === 0) {
        console.log('stream', formatStreamId(args.streamId), 'has no versions yet — nothing to diff');
        return;
    }

    const version = args.version != null ? Number(args.version) : totalVersions;
    if (!Number.isInteger(version) || version < 1 || version > totalVersions) {
        throw new Error('version must be between 1 and ' + totalVersions);
    }

    console.log('diff:', formatPath(destPath), 'vs', formatStreamId(args.streamId), '(version ' + version + ' of ' + totalVersions + ')');
    // Said up front, before the file list: without it, a mistyped path produces a list of
    // every file in the stream marked "deleted", which reads as data loss rather than as
    // a folder that was never there.
    if (!folderExists(destPath)) {
        console.log('  note: local folder does not exist — everything below is listed as deleted');
    }
    console.log('  restoring chain version...');

    let remoteFolder;
    try {
        remoteFolder = await monadSync.restore(version === totalVersions ? undefined : version);
    } catch (err) {
        if (err.code === 'KEK_MISMATCH' || err.message?.includes('decrypt') || err.message?.includes('invalid tag')) {
            throw new Error('Could not decrypt this stream: ' + err.message);
        }
        throw err;
    }

    const remoteFiles = await hashLocalTree(remoteFolder);
    const fsFolder = new FSFolder(destPath, makeExcludes(args));
    let localFiles = {};
    try {
        localFiles = await hashLocalTree(fsFolder);
    } catch {
        // local folder missing or unreadable — treat as empty
    }

    const { added, modified, deleted } = compareFileMaps(localFiles, remoteFiles);
    const total = added.length + modified.length + deleted.length;

    if (total === 0) {
        console.log('  no changes — local folder matches version', version);
        return;
    }

    console.log('\nlocal changes vs chain (what push would apply):');
    for (const path of added) console.log('  added:     ', path);
    for (const path of modified) console.log('  modified:  ', path);
    for (const path of deleted) console.log('  deleted:   ', path);

    console.log('\n  ' + total + ' change(s): ' +
        added.length + ' added, ' +
        modified.length + ' modified, ' +
        deleted.length + ' deleted');
}
