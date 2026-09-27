import VectorIndex from './VectorIndex.js';
import { LEGACY_DTYPE, EMBEDDER_TRANSFORMERS, embedderOfIndex } from './schema.js';

/**
 * Queries an already-built `VectorIndex`. Deliberately the only piece that needs an embedding
 * model loaded on the *searcher's* machine — and only to embed the query string itself, never
 * the corpus, which is the entire point of pushing the index alongside the content: whoever
 * pulls it gets every embedding for free, already paid for by whoever ran `Indexer` first.
 */
export default class Searcher {
	/**
	 * @param {Object} params
	 * @param {(opts: {model: string, embedder: string, dtype: ?string}) => Promise<any>} [params.createProvider] -
	 *   builds the provider the index's own metadata asks for (see providers.js) — the common
	 *   case, opening someone else's index.
	 * @param {any} [params.embeddingProvider] - use this one instead, whatever the index recorded
	 *   (tests; a custom provider). Its vectors must still match the index's dimension.
	 */
	constructor({ createProvider = null, embeddingProvider = null } = {}) {
		if (!createProvider && !embeddingProvider) {
			throw new Error('Searcher: pass createProvider or embeddingProvider');
		}
		this._createProvider = createProvider;
		this._embeddingProvider = embeddingProvider;
	}

	/**
	 * @param {string} dbPath
	 * @param {string} query
	 * @param {number} [k=5]
	 * @returns {Promise<{path: string, chunkIndex: number, startOffset: number, endOffset: number, distance: number}[]>}
	 */
	async search(dbPath, query, k = 5) {
		// Read-only: the index is a file that gets pushed, and searching it must not change it.
		const index = new VectorIndex(dbPath, { readonly: true });
		try {
			const dim = Number(index.getMeta('dimension'));
			if (!dim) {
				throw new Error(`${dbPath}: no index metadata found — run \`mnemonad index\` first`);
			}
			index.initVectorColumn(dim);

			const provider = this._embeddingProvider || await this._createProvider(describeIndexModel(index));
			const [queryVector] = await provider.embed([query]);
			if (queryVector.length !== dim) {
				throw new Error(
					`Query embedding is ${queryVector.length}-dimensional but this index is ${dim}-dimensional — ` +
					`the embedding model must match the one used to build it (recorded model: ${index.getMeta('model')})`
				);
			}

			return index.search(queryVector, k);
		} finally {
			index.close();
		}
	}
}

/** The model an index says it was built with, in the shape createProvider takes. */
export function describeIndexModel(index) {
	const meta = { model: index.getMeta('model'), embedder: index.getMeta('embedder') };
	const embedder = embedderOfIndex(meta);
	return {
		model: meta.model,
		embedder,
		dtype: embedder === EMBEDDER_TRANSFORMERS ? (index.getMeta('dtype') || LEGACY_DTYPE) : null,
	};
}
