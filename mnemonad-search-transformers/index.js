/**
 * Optional neural embedding models for `mnemonad index` / `search` — MiniLM by default, or any
 * other transformers.js feature-extraction model — run locally on ONNX Runtime through
 * `@huggingface/transformers`.
 *
 * Kept out of mnemonad-cli on purpose: ONNX Runtime is ~450 MB installed, for search quality
 * most folders don't need (the CLI's built-in static model is ~31 MB and plain JS). Install it
 * next to the CLI and the CLI finds it on its own:
 *
 *     npm install -g mnemonad-search-transformers
 *     mnemonad index ~/my-data --model minilm
 *
 * The CLI talks to this package only through `apiVersion` and `createProvider()` below, and this
 * package imports nothing from the CLI — so neither pins the other's version.
 */

/** The interface version mnemonad-cli checks before using this package. */
export const apiVersion = 1;

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * Pinned explicitly rather than left to transformers.js, whose own default differs by runtime
 * (fp32 under Node, q8 under browser WASM) — an index built in one and queried in the other
 * would otherwise embed the query with different weights than the corpus. q8 rather than fp32
 * because the browser has to download it: ~23 MB versus ~90 MB, for a quality difference that
 * is negligible for this model.
 */
export const DEFAULT_DTYPE = 'q8';

/**
 * A provider in the shape mnemonad-cli expects: `load()`, `embed(texts)` → Float32Array[],
 * `dimension`, `modelId`, `dtype`, `embedder`, `isLoaded`.
 *
 * `@huggingface/transformers` is imported lazily, on first load: the import alone pulls in
 * ONNX Runtime's native (or WASM) backend. Works in the browser too — the explorer uses this
 * same class for indexes built with MiniLM.
 */
export class TransformersEmbeddingProvider {
	/** @param {Object} [params]
	 *  @param {string} [params.model='Xenova/all-MiniLM-L6-v2']
	 *  @param {string} [params.dtype='q8'] - weight precision (see DEFAULT_DTYPE)
	 *  @param {(event: Object) => void} [params.onProgress] - transformers.js's own
	 *    `progress_callback` events while the model downloads/loads (`{status, file, loaded,
	 *    total, ...}`) — what a browser shows during the one-time first-use download. */
	constructor({ model = DEFAULT_MODEL, dtype = DEFAULT_DTYPE, onProgress = null } = {}) {
		this._model = model;
		this._dtype = dtype;
		this._onProgress = onProgress;
		this._dim = null;
		this._extractor = null;
		this._loading = null;
	}

	get dimension() {
		if (this._dim === null) {
			throw new Error('TransformersEmbeddingProvider: call embed() at least once (or load()) before reading dimension');
		}
		return this._dim;
	}

	get modelId() {
		return this._model;
	}

	get dtype() {
		return this._dtype;
	}

	get embedder() {
		return 'transformers';
	}

	get isLoaded() {
		return this._extractor !== null;
	}

	/** Loads the model now instead of on first embed(). Safe to call more than once, and
	 *  concurrently: two callers racing the first load share one pipeline. */
	async load() {
		if (this._extractor) return;
		if (!this._loading) {
			this._loading = (async () => {
				const { pipeline } = await import('@huggingface/transformers');
				this._extractor = await pipeline('feature-extraction', this._model, {
					dtype: this._dtype,
					...(this._onProgress ? { progress_callback: this._onProgress } : {}),
				});
			})();
			// A failed load (offline, blocked) must stay retryable.
			this._loading.catch(() => {}).finally(() => { this._loading = null; });
		}
		await this._loading;
	}

	async embed(texts) {
		await this.load();
		const output = await this._extractor(texts, { pooling: 'mean', normalize: true });
		const dim = output.dims[output.dims.length - 1];
		this._dim = dim;
		const vectors = [];
		for (let i = 0; i < texts.length; i++) {
			vectors.push(Float32Array.from(output.data.subarray(i * dim, (i + 1) * dim)));
		}
		return vectors;
	}
}

/**
 * @param {Object} [opts] - see TransformersEmbeddingProvider's constructor
 * @returns {TransformersEmbeddingProvider}
 */
export function createProvider(opts = {}) {
	return new TransformersEmbeddingProvider(opts);
}
