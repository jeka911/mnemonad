import ChunkingStrategy from './ChunkingStrategy.js';

/**
 * Default chunker: fixed-size character windows with overlap, breaking on the nearest
 * paragraph/sentence/word boundary before the target size rather than mid-word, when one is
 * available within a reasonable lookback. Character-based rather than token-based
 * deliberately — a token-accurate chunker needs a loaded tokenizer first, coupling chunking
 * to whichever embedding model happens to be configured; character windows chunk perfectly
 * well standalone, synchronously, with no model dependency, and 1000 characters is a
 * conservative-enough stand-in for typical embedding models' token limits (roughly 4
 * characters/token in English prose, so ~250 tokens — comfortably under the 256-512 token
 * budget most small embedding models expect). A token-aware `ChunkingStrategy` reusing the
 * configured `EmbeddingProvider`'s own tokenizer is a reasonable later swap-in — this stays
 * the default because it works content-agnostically with zero setup.
 */
export default class TextWindowChunkingStrategy extends ChunkingStrategy {
	/**
	 * @param {Object} [params]
	 * @param {number} [params.size=1000] - target chunk size, in characters
	 * @param {number} [params.overlap=150] - characters of overlap between consecutive chunks
	 */
	constructor({ size = 1000, overlap = 150 } = {}) {
		super();
		if (overlap >= size) {
			throw new Error('TextWindowChunkingStrategy: overlap must be smaller than size');
		}
		this.size = size;
		this.overlap = overlap;
	}

	chunk(text) {
		if (!text) return [];
		const chunks = [];
		const step = this.size - this.overlap;
		let start = 0;
		while (start < text.length) {
			let end = Math.min(start + this.size, text.length);
			// Prefer breaking at a paragraph/sentence/word boundary over a hard mid-word cut —
			// searched backward from `end`, but never past `start` (a very long unbroken run of
			// text, e.g. a minified file, just gets a hard cut, which is fine: it wasn't going to
			// chunk meaningfully either way).
			if (end < text.length) {
				const lookback = text.slice(start, end);
				const boundary = _lastBoundary(lookback);
				if (boundary > 0) end = start + boundary;
			}
			chunks.push({ startOffset: start, endOffset: end, text: text.slice(start, end) });
			if (end >= text.length) break;
			start = end - this.overlap;
		}
		return chunks;
	}
}

/**
 * Index just past the best break point found in `s` (paragraph > sentence > word), searched
 * from the end backward, or -1 if none exists worth preferring over a hard cut.
 * @param {string} s
 * @returns {number}
 */
function _lastBoundary(s) {
	const paragraph = s.lastIndexOf('\n\n');
	if (paragraph > s.length * 0.5) return paragraph + 2;
	const sentence = Math.max(s.lastIndexOf('. '), s.lastIndexOf('.\n'));
	if (sentence > s.length * 0.5) return sentence + 1;
	const word = s.lastIndexOf(' ');
	if (word > s.length * 0.5) return word + 1;
	return -1;
}
