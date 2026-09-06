// URL builders for the connected chain's block explorer. Built from
// `chain.blockExplorers` (viem's chain definitions) rather than hardcoded, so testnet vs
// mainnet resolve correctly on their own.
//
// Only `address` is built for now: Mnemonad's vector ids are ERC-721 token ids, and the two
// explorers in play (Monadscan, testnet.monadexplorer.com) don't share one token-page URL
// shape — emitting a guessed one risks a 404. Linking to the registry contract's own address
// page is always correct, just less specific; add a `token` builder once that shape is
// confirmed per explorer.

/**
 * @param {Object} chain - a viem chain, e.g. from `getActiveNetwork().chain`
 * @param {string} address
 * @returns {?string} null if the chain has no known explorer
 */
export function addressUrl(chain, address) {
	const base = chain?.blockExplorers?.default?.url;
	return base ? `${base}/address/${address}` : null;
}
