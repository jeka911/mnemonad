import WasmIndexReader from './WasmIndexReader.js';
import { LEGACY_DTYPE, EMBEDDER_TRANSFORMERS, embedderOfIndex } from '../schema.js';

/**
 * The browser's `Searcher`: holds one open index (from bytes, not a path) and the embedding
 * model that matches it, so repeated queries pay for neither again. `open()` again with new
 * bytes when the index file changes; the model is only reloaded if the new index was built
 * with a different one.
 *
 * Which provider to build for which index is the caller's job (`createProvider`), so this
 * class — and the browser entry around it — never imports a model runtime itself: the
 * explorer builds the static provider from its own files source, and loads transformers.js
 * only for an index that needs it.
 */
export default class BrowserSearcher {
	/**
	 * @param {Object} params
	 * @param {any} params.sqlite3 - an initialized `@sqliteai/sqlite-wasm` module.
	 * @param {(opts: {model: string, embedder: string, dtype: ?string, onProgress: ?Function}) => (any|Promise<any>)} [params.createProvider] -
	 *   builds the provider an index's metadata asks for.
	 * @param {any} [params.embeddingProvider] - use this one for every index instead (tests).
	 * @param {(event: Object) => void} [params.onModelProgress] - passed to createProvider.
	 */
	constructor({ sqlite3, createProvider = null, embeddingProvider = null, onModelProgress = null } = {}) {
		if (!sqlite3) throw new Error('BrowserSearcher: sqlite3 module is required');
		if (!createProvider && !embeddingProvider) {
			throw new Error('BrowserSearcher: pass createProvider or embeddingProvider');
		}
		this._sqlite3 = sqlite3;
		this._createProvider = createProvider;
		this._onModelProgress = onModelProgress;
		this._fixedProvider = embeddingProvider;
		this._provider = embeddingProvider;
		this._providerKey = null;
		this._reader = null;
	}

	/** @param {Uint8Array} bytes - the whole search_index.db file. */
	open(bytes) {
		const reader = new WasmIndexReader(this._sqlite3, bytes);
		const dim = Number(reader.getMeta('dimension'));
		if (!dim) {
			reader.close();
			throw new Error('This search index has no metadata — it was never built, or is empty.');
		}
		reader.initVectorColumn(dim);
		this.close();
		this._reader = reader;
		this._dim = dim;
		this._model = reader.getMeta('model');
		this._embedder = embedderOfIndex({ model: this._model, embedder: reader.getMeta('embedder') });
		this._dtype = this._embedder === EMBEDDER_TRANSFORMERS ? (reader.getMeta('dtype') || LEGACY_DTYPE) : null;
	}

	get isOpen() {
		return this._reader !== null;
	}

	/** @returns {{model: ?string, embedder: string, dtype: ?string, dimension: number}} */
	get info() {
		return { model: this._model, embedder: this._embedder, dtype: this._dtype, dimension: this._dim };
	}

	/** @returns {Map<string, string>} see WasmIndexReader.getFileHashes */
	getFileHashes() {
		this._requireOpen();
		return this._reader.getFileHashes();
	}

	/** @returns {boolean} whether the model the open index needs is already loaded. */
	get isModelLoaded() {
		if (!this._reader) return false;
		if (this._fixedProvider) return true;
		return this._providerKey === this._key() && !!this._provider?.isLoaded;
	}

	/** Loads the embedding model now (the slow, one-time part — a download on first use) so a
	 *  caller can show that as its own step instead of as a slow first query. */
	async loadModel() {
		this._requireOpen();
		const provider = await this._providerForIndex();
		if (typeof provider.load === 'function') await provider.load();
	}

	/**
	 * @param {string} query
	 * @param {number} [k=5]
	 */
	async search(query, k = 5) {
		this._requireOpen();
		const provider = await this._providerForIndex();
		const [queryVector] = await provider.embed([query]);
		if (queryVector.length !== this._dim) {
			throw new Error(
				`Query embedding is ${queryVector.length}-dimensional but this index is ${this._dim}-dimensional — ` +
				`the embedding model must match the one used to build it (recorded model: ${this._model})`
			);
		}
		return this._reader.search(queryVector, k);
	}

	close() {
		if (this._reader) {
			this._reader.close();
			this._reader = null;
		}
	}

	_key() {
		return `${this._embedder}|${this._model}|${this._dtype}`;
	}

	async _providerForIndex() {
		if (this._fixedProvider) return this._fixedProvider;
		const key = this._key();
		if (this._providerKey !== key) {
			this._provider = await this._createProvider({
				model: this._model,
				embedder: this._embedder,
				dtype: this._dtype,
				onProgress: this._onModelProgress,
			});
			this._providerKey = key;
		}
		return this._provider;
	}

	_requireOpen() {
		if (!this._reader) throw new Error('BrowserSearcher: call open(bytes) first');
	}
}
