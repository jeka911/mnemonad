/**
 * Base class for splitting one file's text content into embeddable chunks. A subclass fills
 * in `chunk()`; everything else here is just the shared shape `Indexer` depends on.
 *
 * Deliberately separate from Mnemonad's own content-defined chunking (`FastCDC`, used for
 * on-chain diffing): that one finds boundaries by content hash to maximize byte-level dedup
 * between versions, which has nothing to do with what makes a good *semantic* unit to embed.
 * The two chunkers operate on the same bytes for entirely unrelated reasons and should never
 * be conflated.
 */
export default class ChunkingStrategy {
	/**
	 * @param {string} text - decoded file content (chunking only ever runs on text files —
	 *   the caller is responsible for skipping binaries before this is reached).
	 * @returns {{startOffset: number, endOffset: number, text: string}[]} offsets are UTF-16
	 *   code-unit offsets into `text` (i.e. plain JS string indices — `text.slice(startOffset,
	 *   endOffset)` round-trips), not byte offsets — cheap to compute, and exact enough to
	 *   locate a snippet back in the source file at display time.
	 */
	chunk(_text) {
		throw new Error(`${this.constructor.name}: chunk() not implemented`);
	}
}
