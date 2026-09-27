import { Tokenizer } from '@huggingface/tokenizers';
import EmbeddingProvider from './EmbeddingProvider.js';
import { DEFAULT_MODEL, EMBEDDER_STATIC } from '../schema.js';

/**
 * The built-in embedder: static (model2vec) embeddings — `minishlab/potion-base-8M` by
 * default. A static model is a lookup table with one vector per token; a text's embedding is
 * the mean of its tokens' vectors, normalized. No neural network runs, so there's no ONNX
 * Runtime, no native code and no WASM: plain JS that behaves identically in Node and in the
 * browser, embedding a whole folder in milliseconds.
 *
 * The trade-off is quality on paraphrased queries — word order and context are invisible to
 * it. See docs/search.md for how it compares with MiniLM on this project's own corpora; MiniLM
 * stays available through the optional `mnemonad-search-transformers` package.
 *
 * Mirrors model2vec's own `StaticModel.encode` exactly: tokenize without special tokens, drop
 * the unknown token, cap at `MAX_TOKENS`, average the rows, normalize when the model's config
 * says so. Models with a separate weights vector or a token mapping (newer model2vec
 * features) aren't supported; potion-base-8M uses neither.
 *
 * The model's files come from a `files` source, so this class never touches a filesystem or a
 * cache itself — see modelFiles.node.js (disk cache) and modelFiles.browser.js (Cache API).
 */

/** model2vec's own default cap (StaticModel's max_length). */
const MAX_TOKENS = 512;

export const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors'];

export default class StaticEmbeddingProvider extends EmbeddingProvider {
	/**
	 * @param {Object} params
	 * @param {{get(name: string): Promise<Uint8Array>}} params.files - the model's files, by name
	 *   (see MODEL_FILES)
	 * @param {string} [params.model='minishlab/potion-base-8M']
	 */
	constructor({ files, model = DEFAULT_MODEL } = {}) {
		super();
		if (!files) throw new Error('StaticEmbeddingProvider: a `files` source is required');
		this._files = files;
		this._model = model;
		this._table = null;
		this._dim = null;
		this._loading = null;
	}

	get dimension() {
		if (this._dim === null) {
			throw new Error('StaticEmbeddingProvider: call load() or embed() before reading dimension');
		}
		return this._dim;
	}

	get modelId() {
		return this._model;
	}

	get embedder() {
		return EMBEDDER_STATIC;
	}

	get isLoaded() {
		return this._table !== null;
	}

	/** Safe to call more than once, and concurrently: one shared load. */
	async load() {
		if (this._table) return;
		if (!this._loading) {
			this._loading = this._load();
			this._loading.catch(() => {}).finally(() => { this._loading = null; });
		}
		await this._loading;
	}

	async _load() {
		const decoder = new TextDecoder();
		const [configBytes, tokenizerBytes, tokenizerConfigBytes, weights] = await Promise.all(
			MODEL_FILES.map((name) => this._files.get(name))
		);
		const config = JSON.parse(decoder.decode(configBytes));
		const tokenizerJson = JSON.parse(decoder.decode(tokenizerBytes));
		const tokenizerConfig = JSON.parse(decoder.decode(tokenizerConfigBytes));

		this._tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
		this._unkId = unknownTokenId(tokenizerJson);
		this._normalize = config.normalize !== false;
		const { table, rows, dim } = readEmbeddings(weights);
		this._rows = rows;
		this._dim = dim;
		this._table = table;
	}

	async embed(texts) {
		await this.load();
		return texts.map((text) => this._embedOne(text));
	}

	_embedOne(text) {
		const dim = this._dim;
		const out = new Float32Array(dim);
		// Truncated first, then the unknown token dropped — the same order as model2vec (its
		// tokenizer truncates, its tokenize() filters afterwards).
		const ids = this._tokenizer.encode(text, { add_special_tokens: false }).ids.slice(0, MAX_TOKENS);
		let count = 0;
		for (const id of ids) {
			if (id === this._unkId || id < 0 || id >= this._rows) continue;
			const base = id * dim;
			for (let j = 0; j < dim; j++) out[j] += this._table[base + j];
			count++;
		}
		if (count === 0) return out;
		let norm = 0;
		for (let j = 0; j < dim; j++) {
			out[j] /= count;
			norm += out[j] * out[j];
		}
		if (this._normalize && norm > 0) {
			norm = Math.sqrt(norm);
			for (let j = 0; j < dim; j++) out[j] /= norm;
		}
		return out;
	}
}

/** The vocabulary id of the tokenizer's unknown token, or null if it has none. */
function unknownTokenId(tokenizerJson) {
	const model = tokenizerJson.model || {};
	const unk = model.unk_token;
	if (unk == null) return null;
	const vocab = model.vocab;
	if (Array.isArray(vocab)) {
		// Unigram vocabularies are [token, score] pairs.
		const index = vocab.findIndex((entry) => entry[0] === unk);
		return index >= 0 ? index : null;
	}
	return vocab && Object.hasOwn(vocab, unk) ? vocab[unk] : null;
}

/**
 * Reads the `embeddings` tensor out of a safetensors file: an 8-byte little-endian header
 * length, a JSON header naming each tensor's dtype, shape and byte range, then the raw data.
 *
 * @param {Uint8Array} bytes
 * @returns {{table: Float32Array, rows: number, dim: number}}
 */
export function readEmbeddings(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerLength = Number(view.getBigUint64(0, true));
	const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
	const tensor = header.embeddings;
	if (!tensor) throw new Error('model.safetensors has no `embeddings` tensor — not a model2vec model?');
	const [rows, dim] = tensor.shape;
	const [start, end] = tensor.data_offsets;
	const data = bytes.subarray(8 + headerLength + start, 8 + headerLength + end);

	if (tensor.dtype === 'F32') {
		// Copied rather than viewed: a Float32Array needs 4-byte alignment, which the data
		// start (right after a variable-length header) doesn't guarantee.
		const table = new Float32Array(rows * dim);
		new Uint8Array(table.buffer).set(data);
		return { table, rows, dim };
	}
	if (tensor.dtype === 'F16') {
		const table = new Float32Array(rows * dim);
		const halves = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let i = 0; i < table.length; i++) table[i] = halfToFloat(halves.getUint16(i * 2, true));
		return { table, rows, dim };
	}
	throw new Error(`model.safetensors: unsupported dtype ${tensor.dtype} (expected F32 or F16)`);
}

function halfToFloat(h) {
	const sign = h & 0x8000 ? -1 : 1;
	const exp = (h >> 10) & 0x1f;
	const frac = h & 0x03ff;
	if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
	if (exp === 0x1f) return frac ? NaN : sign * Infinity;
	return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}
