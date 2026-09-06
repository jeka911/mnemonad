/**
 * Known Mnemonad deployments, keyed by network then contract version.
 *
 * Deliberately keyed by `(network, version)` rather than network alone. The contract is
 * immutable and testnet deployments are disposable proving grounds, so several versions
 * will exist over time; an SDK pinned only by network would happily talk to a stale
 * deployment and misdecode structs whose layout has moved.
 */
export default {
	monadTestnet: {
		chainId: 10143,
		version: 2,
		contractAddress: '0xbea34c1500832dc0dbf1402d8c15c1cf720d0ad2',
	},
	monadMainnet: {
		chainId: 143,
		version: null,
		contractAddress: null,
	},
};
