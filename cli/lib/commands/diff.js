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
    if (!args.streamId) {
        throw new Error('stream-id is required for diff');
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

    // See shared.js's unlockStream() for why `password` isn't passed to the constructor
    // above — this fetches the stream's own already-published salt instead of deriving a
    // key from a fresh one.
    await unlockStream(mn, args.password);
    const totalVersions = mn.length;

    if (totalVersions === 0) {
        console.log('stream', args.streamId, 'has no versions yet — nothing to diff');
        return;
    }

    const version = args.version != null ? Number(args.version) : totalVersions;
    if (!Number.isInteger(version) || version < 1 || version > totalVersions) {
        throw new Error('version must be between 1 and ' + totalVersions);
    }

    console.log('diff:', formatPath(destPath), 'vs', args.streamId, '(version ' + version + ' of ' + totalVersions + ')');
    console.log('  restoring chain version...');

    let remoteFolder;
    try {
        remoteFolder = await monadSync.restore(version === totalVersions ? undefined : version);
    } catch (err) {
        if (err.message?.includes('decrypt') || err.message?.includes('invalid tag')) {
            throw new Error('This stream is encrypted. Provide --password to decrypt.');
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
