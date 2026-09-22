/**
 * Curated, publicly-readable streams to browse without connecting a wallet — the "here is
 * what this thing actually does" entry point, and the only content a first-time visitor can
 * see at all before they own anything.
 *
 * Keyed by the network id `settings.js` uses, because a stream id only means anything on the
 * chain it was created on: a testnet id points at nothing on mainnet, so listing it there
 * would be a dead link rather than a sample.
 *
 * This is the single source of truth for those ids — `scripts/update_dataset_testnet.js`
 * imports the same list to know which stream to push into, so re-creating a dataset means
 * editing one id here rather than keeping two copies in step by hand.
 */

/**
 * @typedef {Object} SampleStream
 * @property {string} id - decimal stream id, as a string (ids exceed Number's safe range)
 * @property {string} name - short label for the list row
 * @property {string} description - one line on what's inside
 * @property {string} [source] - repo path the contents are pushed from, if any
 */

/** @type {Record<string, SampleStream[]>} */
export const SAMPLE_STREAMS = {
	testnet: [
		{
			id: '45484115941227250607382990641581457040221840181861794550002146954186597022408',
			name: 'Text dataset',
			description: 'A small plain-text corpus — haiku and notes, pushed as a versioned folder.',
			source: 'sample_datasets/text',
		},
	],
	mainnet: [],
};

/**
 * @param {string} networkId - `getActiveNetworkId()`'s value
 * @returns {SampleStream[]} empty when this network has no samples, never undefined
 */
export function sampleStreamsFor(networkId) {
	return SAMPLE_STREAMS[networkId] || [];
}
