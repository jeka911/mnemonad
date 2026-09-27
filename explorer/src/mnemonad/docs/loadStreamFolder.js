import { createPublicClient, http } from 'viem';
import Mnemonad, { ids as mnemonadIds } from '@mnemonad';
import MonadSync from '@monadsync';
import { NETWORKS } from '../../settings.js';
import { MAX_RPC_REQUESTS_PER_SECOND, RPC_RETRY } from '../../stores/mnemonad.js';
import { useDebugStore } from '../../stores/debug.js';
import { createPresignProvider } from '../presignProvider.js';

/**
 * Restores a stream's latest folder from a specific chain, independent of the network the
 * app is currently running on.
 *
 * The rest of the explorer reads through wagmi's config, which only ever holds the active
 * network (switching reloads the page — see wagmi.js). Docs have to load wherever their stream
 * lives, whichever network the visitor last picked, so this builds its own read-only viem
 * client for the requested chain instead. Read-only is all docs need: no wallet, no writes.
 *
 * Results are kept per (network, id) for the page's lifetime, so moving between docs, or
 * leaving /docs and coming back, doesn't restore the stream again. Every underlying read also
 * goes through the SDK's IndexedDB cache, so even a reload costs almost no RPC calls.
 */

const loaded = new Map();

/**
 * @param {Object} params
 * @param {string} params.network - settings.js network id ('testnet' / 'mainnet')
 * @param {string|bigint} params.streamId
 * @returns {Promise<{folder: any, version: number, streamId: string, network: string}>}
 */
export function loadStreamFolder({ network, streamId }) {
	const key = `${network}:${BigInt(streamId).toString()}`;
	if (!loaded.has(key)) {
		const promise = restore({ network, streamId });
		// A failure (RPC hiccup) must stay retryable rather than cached forever.
		promise.catch(() => loaded.delete(key));
		loaded.set(key, promise);
	}
	return loaded.get(key);
}

async function restore({ network, streamId }) {
	const net = NETWORKS[network];
	if (!net) throw new Error(`Unknown network '${network}'.`);
	const entry = Object.values(mnemonadIds).find((e) => e.chainId === net.chain.id);
	if (!entry?.contractAddress) throw new Error(`Mnemonad isn't deployed on ${net.label}.`);

	const publicClient = createPublicClient({
		chain: net.chain,
		// JSON-RPC batching, same as the app's own transport (see wagmi.js for why this and
		// not Multicall3 batching).
		transport: http(undefined, { batch: true }),
	});
	const mn = new Mnemonad({
		publicClient,
		contractAddress: entry.contractAddress,
		id: BigInt(streamId),
		maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
		rpcRetry: RPC_RETRY,
		// Reads IPFS-offloaded items through the project's read gateway; never writes here.
		offloadingProvider: createPresignProvider({}),
		cache: useDebugStore().cachingDisabled ? false : undefined,
	});
	await mn.initialize();
	if (mn.encKeyWrapped && mn.encKeyWrapped.length) {
		throw new Error('This stream is encrypted — docs can only be loaded from a public stream.');
	}
	if (!mn.length) throw new Error('This stream is empty.');

	const folder = await new MonadSync({ mnemonad: mn }).restore();
	return { folder, version: mn.length, streamId: String(streamId), network };
}
