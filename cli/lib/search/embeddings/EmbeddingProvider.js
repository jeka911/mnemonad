/**
 * Base class for turning text into vectors. A subclass fills in `embed()`/`dimension`;
 * everything downstream (`VectorIndex`, `Indexer`, `Searcher`) only ever talks to this
 * interface, never to a specific model or runtime — swapping the default local model for an
 * API-based one later needs no change outside a new subclass.
 */
export default class EmbeddingProvider {
	/** @returns {number} vector length this provider produces — fixed for its lifetime. */
	get dimension() {
		throw new Error(`${this.constructor.name}: dimension getter not implemented`);
	}

	/** @returns {string} identifies this provider + model in `search_index_meta`, so a later
	 *  `search` (possibly a different process entirely) knows what it's matching against. */
	get modelId() {
		throw new Error(`${this.constructor.name}: modelId getter not implemented`);
	}

	/** @returns {?string} which kind of embedder this is ('model2vec', 'transformers'), recorded
	 *  in the index so a later search builds the same kind (see schema.js). */
	get embedder() {
		return null;
	}

	/** @returns {?string} weight precision (e.g. 'q8', 'fp32') when the model comes in more than
	 *  one, recorded alongside `modelId` so a searcher loads the same weights. Null when the
	 *  provider has no such choice. */
	get dtype() {
		return null;
	}

	/**
	 * @param {string[]} texts
	 * @returns {Promise<Float32Array[]>} one vector per input text, same order, each of length
	 *   `this.dimension`.
	 */
	async embed(_texts) {
		throw new Error(`${this.constructor.name}: embed() not implemented`);
	}
}
