/**
 * Everything about the on-disk index format that more than one reader has to agree on — the
 * Node `VectorIndex` (better-sqlite3 + the native sqlite-vector extension) and the browser's
 * `WasmIndexReader` (@sqliteai/sqlite-wasm, same sqlite-vector compiled in). Kept in one place
 * so the two can't drift: a search from the explorer must rank exactly like `mnemonad search`
 * on the same file.
 *
 * Deliberately dependency-free (no `node:*`, no native modules) — the browser entry imports it.
 */

export const DEFAULT_DB_NAME = 'search_index.db';

/**
 * Two kinds of embedding model, recorded per index as `embedder` in its metadata:
 *
 *  - 'model2vec' — static embeddings (a token → vector lookup table, averaged). Built in: pure
 *    JS, no native code, runs the same in Node and the browser. The default.
 *  - 'transformers' — a neural model run by transformers.js on ONNX Runtime (MiniLM, say).
 *    Better on paraphrased queries, but ONNX Runtime is ~450 MB installed, so the CLI loads it
 *    only from the optional `mnemonad-search-transformers` package.
 */
export const EMBEDDER_STATIC = 'model2vec';
export const EMBEDDER_TRANSFORMERS = 'transformers';

export const DEFAULT_MODEL = 'minishlab/potion-base-8M';

/** Short names accepted wherever a model is (`--model minilm`). */
export const MODEL_ALIASES = {
	potion: 'minishlab/potion-base-8M',
	minilm: 'Xenova/all-MiniLM-L6-v2',
};

/** @returns {string} the full model id for an alias, or the name unchanged. */
export function resolveModelName(name) {
	return MODEL_ALIASES[name] || name;
}

/** Which embedder a model needs. model2vec models live under the `minishlab/` organisation
 *  on the Hugging Face hub; everything else is taken to be a transformers.js model. */
export function embedderForModel(model) {
	return /^minishlab\//.test(model) ? EMBEDDER_STATIC : EMBEDDER_TRANSFORMERS;
}

/**
 * Which embedder built an existing index. Indexes from before `embedder` was recorded were all
 * built with MiniLM through transformers.js — the only option at the time.
 *
 * @param {{embedder?: ?string, model?: ?string}} meta
 */
export function embedderOfIndex(meta) {
	if (meta.embedder) return meta.embedder;
	return meta.model ? embedderForModel(meta.model) : EMBEDDER_TRANSFORMERS;
}

/** What a transformers-built index recorded before `dtype` was written to its meta was built
 *  with — the Node default at the time, since the CLI was the only thing that could build one. */
export const LEGACY_DTYPE = 'fp32';

export const TABLE_CHUNKS = 'search_index';
export const TABLE_FILES = 'search_index_files';
export const TABLE_META = 'search_index_meta';
export const VECTOR_COLUMN = 'embedding';

/** @param {number} dim @param {'FLOAT32'|'INT8'} [type='FLOAT32'] */
export function vectorInitOptions(dim, type = 'FLOAT32') {
	return `type=${type},dimension=${dim},distance=COSINE`;
}

export const VECTOR_INIT_SQL = `SELECT vector_init('${TABLE_CHUNKS}', '${VECTOR_COLUMN}', ?)`;

/**
 * Nearest-neighbor search, current chunks only. Binds, in order: query vector (BLOB), overfetch
 * count, k. `vector_full_scan` is exact brute force — appropriate for the corpus sizes a synced
 * folder actually has, and an ANN/partitioning index would break the diffability the whole
 * format depends on. Some of its top candidates may be stale (superseded by a later reindex of
 * the same file, or belonging to a removed file), which the join against the files table drops
 * — hence the overfetch, see `overfetchFor`.
 */
export const SEARCH_SQL = `
	SELECT s.path, s.chunk_index, s.start_offset, s.end_offset, v.distance
	FROM vector_full_scan('${TABLE_CHUNKS}', '${VECTOR_COLUMN}', ?, ?) v
	JOIN ${TABLE_CHUNKS} s ON s.id = v.rowid
	JOIN ${TABLE_FILES} f ON f.path = s.path AND f.content_hash = s.content_hash
	ORDER BY v.distance ASC
	LIMIT ?
`;

/** A generous overfetch — cheap (still one exact scan) and simple, rather than looping with a
 *  growing k until enough candidates survive the staleness join. */
export function overfetchFor(k) {
	return Math.max(k * 8, 64);
}

/** @returns {{path: string, chunkIndex: number, startOffset: number, endOffset: number, distance: number}} */
export function mapSearchRow(r) {
	return {
		path: r.path,
		chunkIndex: r.chunk_index,
		startOffset: r.start_offset,
		endOffset: r.end_offset,
		distance: r.distance,
	};
}
