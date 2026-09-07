// URL builders for the connected chain's block explorer. Built from
// `chain.blockExplorers` (viem's chain definitions) rather than hardcoded, so testnet vs
// mainnet resolve correctly on their own.

/**
 * @param {Object} chain - a viem chain, e.g. from `getActiveNetwork().chain`
 * @param {string} address
 * @returns {?string} null if the chain has no known explorer
 */
export function addressUrl(chain, address) {
	const base = chain?.blockExplorers?.default?.url;
	return base ? `${base}/address/${address}` : null;
}

/**
 * Links to a specific ERC-721 token's page — MonadVision's shape, confirmed on both
 * testnet.monadvision.com and monadvision.com: `/nft/{contract}/{tokenId}` (decimal, not
 * hex). Both of this app's networks resolve through MonadVision, so one shape covers both;
 * if a chain's `blockExplorers.default` ever points elsewhere, this would need revisiting.
 *
 * @param {Object} chain
 * @param {string} contractAddress
 * @param {string|bigint|number} tokenId
 * @returns {?string} null if the chain has no known explorer
 */
export function tokenUrl(chain, contractAddress, tokenId) {
	const base = chain?.blockExplorers?.default?.url;
	return base ? `${base}/nft/${contractAddress}/${tokenId.toString()}` : null;
}
