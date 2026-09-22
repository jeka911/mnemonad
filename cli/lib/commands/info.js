import Mnemonad, { kekMethodOf } from 'mnemonad';
import { MonadSync } from 'monadsync';
import { makeChainClient } from '../chainClient.js';
import {
    resolvePath,
    formatBytes,
    localTreeHash,
    unlockStream,
    formatStreamId,
} from './shared.js';

export async function info(args) {
    const client = makeChainClient(args);

    console.log('  chain:          ', args.chain);
    console.log('  your wallet:    ', client.account?.address || '(none)');

    if (!args.streamId) {
        return;
    }

    // No `password` passed to the constructor — see shared.js's unlockStream() for why:
    // this instance doesn't yet know whether the stream is even encrypted, let alone its
    // published salt, so it's unlocked explicitly below once isEncrypted() is known.
    const mn = new Mnemonad({
        publicClient: client.publicClient,
        walletClient: client.walletClient,
        contractAddress: client.contractAddress,
        id: args.streamId,
        gatewayUrl: args.gatewayUrl,
    });

    await mn.initialize();

    const totalVersions = mn.length;

    console.log('\nstream:', formatStreamId(args.streamId));

    const owner = await mn.owner().catch(() => null) || '(unknown)';
    const isOwner = client.account && owner !== '(unknown)' && client.account.address.toLowerCase() === owner.toLowerCase();

    const isEncrypted = await mn.isEncrypted();
    const kekMethod = kekMethodOf({ kek: mn.streamMeta.kek, encrypted: isEncrypted });
    // Unlike pull/diff (which have nothing useful to do at all without decrypting), info
    // still has metadata worth showing on a stream it can't open — so this unlocks when the
    // right credential happens to be at hand and otherwise just notes it, rather than
    // throwing. `unlocked` then gates the local-version comparison further down.
    let unlocked = false;
    if (isEncrypted) {
        try {
            unlocked = await unlockStream(mn, { password: args.password, signer: client.walletClient });
        } catch {
            // Missing or wrong credential — reported below, not fatal for `info`.
        }
    }
    console.log('  owner:          ', isOwner ? owner + ' (you)' : owner);
    console.log(
        '  encrypted:      ',
        isEncrypted ? (kekMethod === 'password' ? 'yes (password)' : 'yes (owner wallet)') : 'no'
    );
    console.log('  versions:       ', totalVersions);
    console.log('  binary size:    ', formatBytes(mn.binaryLength));
    if (mn.firstAvailableIndex > 0) {
        console.log('  history starts: ', 'index', mn.firstAvailableIndex, '(earlier history truncated — see `compact`)');
    }

    const destPath = resolvePath(args.path);
    const localHash = await localTreeHash(destPath);

    if (!localHash) {
        console.log('\n  local folder:    empty (run pull to fetch)');
        return;
    }

    // Same reasoning as pull.js/diff.js: an un-unlocked stream decrypts to nothing useful,
    // so the tree-hash detection loop below would only ever compare garbage against garbage
    // — better to say what's missing up front and stop.
    if (isEncrypted && !unlocked) {
        console.log(
            kekMethod === 'password'
                ? '\n  (encrypted — provide --password to compare against the local folder)'
                : '\n  (encrypted to the owner\'s wallet — provide their --key / --phrase to\n' +
                  '   compare against the local folder)'
        );
        return;
    }

    const localHex = Buffer.from(localHash).toString('hex').slice(0, 12);
    console.log('\n  local tree hash: ', localHex + '...');
    console.log('  detecting local version...');

    const monadSync = new MonadSync({ mnemonad: mn });
    let matchedVersion = null;

    for (let v = totalVersions; v >= Math.max(mn.firstAvailableIndex, 1); v--) {
        process.stdout.write('  checking version ' + v + '/' + totalVersions + '...          \r');
        let remoteHash;
        try {
            remoteHash = await monadSync.getTreeHash(v);
        } catch (err) {
            if (err.code === 'KEK_MISMATCH' || err.message?.includes('decrypt') || err.message?.includes('invalid tag')) {
                throw new Error('Could not decrypt this stream: ' + err.message);
            }
            throw err;
        }
        if (localHash.length === remoteHash.length && localHash.every((b, i) => b === remoteHash[i])) {
            matchedVersion = v;
            break;
        }
    }

    process.stdout.write('                                                \r');
    if (matchedVersion !== null) {
        console.log('  local matches:   version', matchedVersion, 'of', totalVersions);
        if (matchedVersion < totalVersions) {
            console.log('  behind by:      ', totalVersions - matchedVersion, 'version(s)');
        } else {
            console.log('  status:          up to date');
        }
    } else {
        console.log('  local matches:   no known version (local modifications?)');
        console.log('  latest remote:   version', totalVersions);
    }
}
