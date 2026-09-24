/**
 * Monad's auth model is just a viem account, so no client wrapper class is needed here,
 * only a couple of plain functions. Follows the exact pattern already established in
 * `scripts/deploy.js` and `js/test/fixture.js`'s `makeClients()`: `viem/chains`'
 * `monad`/`monadTestnet` + `privateKeyToAccount`/`mnemonicToAccount` +
 * `createPublicClient`/`createWalletClient` with an `http()` transport.
 */
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { monad, monadTestnet } from 'viem/chains';

/**
 * CLI `--chain` name -> { viem chain object, Mnemonad network shorthand for
 * `contractAddress` }. The two disagree on the mainnet name for the same reason
 * `scripts/deploy.js`'s own `IDS_KEY` map does: `monad` matches viem/chains, `monadMainnet`
 * is what `js/ids.js` already uses — reconciled here rather than renaming either side.
 */
const CHAINS = {
	testnet: { chain: monadTestnet, contractAddress: 'monadTestnet' },
	mainnet: { chain: monad, contractAddress: 'monadMainnet' },
};

/**
 * `--chain local` is not a real Mnemonad deployment — it's for running against a local
 * Hardhat node (`js/test/fixture.js`'s own `startNode()`, same chain id 31337 that node
 * defaults to), used by this package's own tests and by manual smoke-testing during
 * development. Unlike `testnet`/`mainnet`, its viem chain object depends on `--rpc-url`
 * (there's no fixed default endpoint for "some local node"), and it has no known
 * `contractAddress` shorthand — the caller must always pass `--contract-address` for a
 * freshly-deployed local registry, since `js/ids.js` only lists testnet/mainnet.
 */
function localChain(rpcUrl) {
	if (!rpcUrl) {
		throw new Error("--chain local requires --rpc-url pointing at the local node");
	}
	return defineChain({
		id: 31337,
		name: 'Hardhat',
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } },
	});
}

function normalizeKey(key) {
	return key.startsWith('0x') ? key : `0x${key}`;
}

function resolveAccount(args) {
	const key = args.key || process.env.MNEMONAD_KEY;
	if (key) return privateKeyToAccount(normalizeKey(key));
	if (args.phrase) return mnemonicToAccount(args.phrase);
	return null;
}

/**
 * Resolves `--chain`/`--rpc-url` into a viem chain + the Mnemonad network shorthand
 * `contractAddress` accepts directly, and `--key`/`--phrase`/`MNEMONAD_KEY` into an
 * optional signing account. Never throws for a missing key — read-only commands (`pull`,
 * `info`, `diff`) are fine without one; commands that need to sign call
 * `requireWalletClient` themselves, so the "no key" error only surfaces where it's
 * actually required.
 *
 * @param {Object} args - parsed CLI args: `chain`, `rpcUrl`, `key`, `phrase`, `contractAddress`
 * @returns {{
 *   publicClient: Object,
 *   walletClient: ?Object,
 *   account: ?Object,
 *   contractAddress: string,
 *   chain: Object,
 * }}
 */
export function makeChainClient(args) {
	let chain, contractAddress;
	if (args.chain === 'local') {
		// Dev/test only — see localChain() above.
		chain = localChain(args.rpcUrl);
		contractAddress = args.contractAddress;
		if (!contractAddress) {
			throw new Error('--chain local requires --contract-address (no known deployment to default to)');
		}
	} else {
		const known = CHAINS[args.chain];
		if (!known) {
			throw new Error(`unknown --chain '${args.chain}', expected one of ${[...Object.keys(CHAINS), 'local'].join(', ')}`);
		}
		chain = known.chain;
		// --contract-address overrides the network's own known deployment — mainly useful
		// for pointing at a different/newer registry without needing a code change to
		// js/ids.js first.
		contractAddress = args.contractAddress || known.contractAddress;
	}

	// http(undefined) falls back to the chain's own default RPC URL — no need to clone or
	// mutate the chain object just to point at a different endpoint.
	const transport = http(args.rpcUrl);
	const publicClient = createPublicClient({ chain, transport });

	const account = resolveAccount(args);
	const walletClient = account ? createWalletClient({ chain, transport, account }) : null;

	return { publicClient, walletClient, account, contractAddress, chain };
}

/**
 * Fails fast with an actionable message when a command needs to sign (push, watch with
 * push enabled, compact) but no key was configured.
 */
export function requireWalletClient(client) {
	if (!client.walletClient) {
		// Marked as a user error so the CLI boundary prints the message alone: this is the
		// first thing anyone hits before configuring a key, and a stack trace through
		// chainClient makes an actionable one-liner look like a crash.
		const err = new Error(
			'No signing key. Set the MNEMONAD_KEY env var to a private key, or pass --key / --phrase.'
		);
		err._isUserError = true;
		throw err;
	}
}
