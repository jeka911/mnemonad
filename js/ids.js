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
		contractAddress: '0x51f0b9ec54f6c533ba3d9ecb78cca7c502104e05',
	},
	monadMainnet: {
		chainId: 143,
		version: null,
		contractAddress: null,
	},
};
