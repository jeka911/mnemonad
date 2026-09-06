import { createPublicClient, http, defineChain } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import Mnemonad, { MnemonadUploadGateway } from 'mnemonad';

/**
 * Read-only chain access.
 *
 * Deliberately has no signer and no way to acquire one. This service never sends a
 * transaction: escrow is settled by the *user's* own `pushExternal`, so the server needs
 * nothing but reads. Keeping it keyless means a compromise here leaks upload capacity on
 * the Pinata account, never funds.
 */
export function createChain(config) {
	const chain = resolveChain(config);
	const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });

	// `id` is irrelevant for the registry-level reads this uses (`uploadGateway`), which is
	// why no vector is required — but the SDK wants one, so it gets a placeholder.
	const registry = new Mnemonad({
		publicClient,
		contractAddress: config.registryAddress,
		id: 0n,
		// Monad's public RPC caps at 15 req/sec and answers a burst with an error, not a
		// queue. One request here is a couple of eth_calls, so a handful of concurrent
		// clients trips it — and the failure surfaced as a 500, making an infrastructure
		// limit look like a server bug. The SDK shares one budget across every instance for
		// the same (chain, rate), so this covers the gateway client too.
		maxRPCRequestsPerSecond: config.maxRpcPerSecond,
	});

	let gatewayPromise = null;

	/**
	 * The gateway the registry actually honours, memoised.
	 *
	 * Discovered from `registry.uploadGateway()` rather than configured, so this can never
	 * hand out URLs against a gateway `pushExternal` would ignore — which would mean taking
	 * payment into escrow nothing will ever settle. Memoised because it changes only on an
	 * owner transaction; {resetGateway} exists for that case.
	 */
	async function getGateway() {
		if (!gatewayPromise) {
			gatewayPromise = MnemonadUploadGateway.fromMnemonad(registry).then((gw) => {
				if (!gw) {
					gatewayPromise = null; // don't cache "absent" — it may get wired at any time
					throw new Error(
						`No upload gateway is wired to the registry at ${config.registryAddress}`
					);
				}
				return gw;
			}).catch((err) => {
				gatewayPromise = null;
				throw err;
			});
		}
		return await gatewayPromise;
	}

	function resetGateway() {
		gatewayPromise = null;
	}

	/**
	 * Escrow state for a (payer, contentHash) pair, straight from the contract.
	 * @returns {Promise<{requestId: string, amount: bigint, maxSize: bigint, expiry: bigint, exists: boolean}>}
	 */
	async function getEscrow(payer, contentHash) {
		const gateway = await getGateway();
		return await gateway.requestFor(payer, contentHash);
	}

	return { chain, publicClient, registry, getGateway, resetGateway, getEscrow };
}

/**
 * Monad's own chains come from viem; anything else is described from config so this can
 * point at a local node without a viem/chains entry existing for it.
 */
function resolveChain(config) {
	if (config.chainId === monadTestnet.id) return monadTestnet;
	if (config.chainId === monad.id) return monad;
	return defineChain({
		id: config.chainId,
		name: `chain-${config.chainId}`,
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: { default: { http: [config.rpcUrl] } },
	});
}
