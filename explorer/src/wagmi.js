import { createConfig, http } from '@wagmi/vue';
import { getActiveNetwork } from './settings.js';

// Single-chain config, built from whichever network is currently selected
// (see settings.js) — switching networks persists the choice and reloads the
// page, so this always reflects the active network fresh on every load.
const activeChain = getActiveNetwork().chain;

// No explicit connectors: installed wallets are discovered automatically via
// EIP-6963 (multiInjectedProviderDiscovery is on by default). This avoids the
// generic "Injected" fallback entry and gives us each wallet's name + icon.
export const config = createConfig({
	chains: [activeChain],
	transports: {
		// `batch` here is viem's JSON-RPC transport batching — many concurrent eth_calls
		// coalesced into one HTTP POST carrying a JSON-RPC batch array. Confirmed against
		// the real testnet RPC that it honors batch arrays correctly. Unrelated to (and
		// unaffected by) the Multicall3 contract-aggregation `batch` disabled below: that
		// one wraps calls through an on-chain contract, this one never touches a contract
		// at all, so it doesn't hit the same revert-on-expensive-wrapped-calls bug.
		[activeChain.id]: http(undefined, { batch: true }),
	},
	// wagmi defaults to batching reads through the chain's Multicall3 contract.
	// Monad testnet's Multicall3 reverts on expensive wrapped calls — reads that
	// do many internal storage or code lookups fail inside the multicall even
	// though the same call succeeds unwrapped. So disable batching entirely.
	batch: false,
});
