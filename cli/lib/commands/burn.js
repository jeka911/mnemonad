import Mnemonad from 'mnemonad';
import { makeChainClient, requireWalletClient } from '../chainClient.js';
import { assertStreamOwner, formatStreamId, formatBytes, requireStreamId } from './shared.js';

/**
 * Destroys a stream permanently: burns the ERC-721 token and clears its metadata and
 * wrapped encryption key (`contracts/src/Mnemonad.sol`'s own `burn()`). Irreversible, and
 * re-creating a stream with the same id afterward does NOT resurrect the old data — ids are
 * deterministic, so the contract deliberately marks a burned id as permanently used rather
 * than letting a fresh `create()` silently inherit old item records.
 *
 * Deployed CODE-tier item bytes physically survive on-chain regardless of burn — this
 * removes the stream as a usable, readable thing, not necessarily every trace of its bytes.
 *
 * Requires `--yes`: the one command here that destroys something with no way back, so it
 * refuses to run without an explicit, unambiguous opt-in rather than an interactive prompt
 * a script could accidentally click through.
 */
export async function burn(args) {
	// Never inferred from a folder's .mnemonad: an irreversible command only ever acts on an
	// id that was typed out for it.
	requireStreamId(args, 'burn', { folder: false });

	const client = await makeChainClient(args);
	requireWalletClient(client);

	const mn = new Mnemonad({
		publicClient: client.publicClient,
		walletClient: client.walletClient,
		contractAddress: client.contractAddress,
		id: args.streamId,
	});

	// Ownership checked before printing anything about the stream's contents — same
	// reasoning as every other write command's own assertStreamOwner call.
	await assertStreamOwner(mn, client.account.address);
	await mn.initialize();

	console.log('stream:      ', formatStreamId(mn.id));
	console.log('chain:       ', args.chain);
	console.log('versions:    ', mn.length);
	console.log('binary size: ', formatBytes(mn.binaryLength));

	if (!args.yes) {
		const err = new Error(
			'This permanently destroys the stream above: the ERC-721 token and its metadata\n' +
			'  are gone, and re-creating a stream with this id afterward does NOT recover the\n' +
			'  old data — there is no undo. (Deployed CODE-tier chunks physically survive on\n' +
			'  chain regardless; this only removes the stream as a usable, readable thing.)\n' +
			'  Re-run with --yes to actually burn it.'
		);
		err._isUserError = true;
		throw err;
	}

	console.log('burning...');
	await mn.burn();
	console.log('  done —', formatStreamId(mn.id), 'is burned.');
}
