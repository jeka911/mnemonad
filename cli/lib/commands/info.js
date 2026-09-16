import Mnemonad from 'mnemonad';
import { MonadSync } from 'monadsync';
import { makeChainClient } from '../chainClient.js';
import {
    resolvePath,
    formatBytes,
    localTreeHash,
    unlockStream,
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

    console.log('\nstream:', args.streamId);

    const owner = await mn.owner().catch(() => null) || '(unknown)';
    const isOwner = client.account && owner !== '(unknown)' && client.account.address.toLowerCase() === owner.toLowerCase();

    const isEncrypted = await mn.isEncrypted();
    // Unlike pull/diff (which have nothing useful to do at all without decrypting), info
    // still has metadata worth showing on an encrypted stream with no password — so this
    // unlocks when it can and otherwise just notes it, rather than throwing.
    if (isEncrypted && args.password) {
        await mn.unlockWithPassword(args.password);
    }
    console.log('  owner:          ', isOwner ? owner + ' (you)' : owner);
    console.log('  encrypted:      ', isEncrypted ? 'yes' : 'no');
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

    // Same reasoning as pull.js/diff.js: with no password configured, Mnemonad skips
    // decryption silently instead of failing, so the tree-hash detection loop below would
    // only ever compare garbage against garbage — better to say why up front and stop.
    if (isEncrypted && !args.password) {
        console.log('\n  (stream is encrypted — provide --password to compare against the local folder)');
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
            if (err.message?.includes('decrypt') || err.message?.includes('invalid tag')) {
                throw new Error('This stream is encrypted. Provide --password to decrypt.');
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
