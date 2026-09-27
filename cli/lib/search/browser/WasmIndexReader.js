import {
	TABLE_FILES, TABLE_META, VECTOR_INIT_SQL, SEARCH_SQL,
	vectorInitOptions, overfetchFor, mapSearchRow,
} from '../schema.js';

/**
 * Read-only view of a `search_index.db` held in memory — the browser counterpart to
 * `VectorIndex`, for a page that already has the file's bytes (the explorer does: after a
 * restore, the whole folder, index included, lives in memory) and no filesystem to open it from.
 *
 * Runs on @sqliteai/sqlite-wasm, which ships the same sqlite-vector build the Node side loads
 * as a native extension, so it answers with the same `vector_full_scan` query (shared through
 * schema.js) and returns the same distances — not a second, JS-side scoring that could drift.
 *
 * The sqlite3 module is passed in rather than imported here: it's a ~3 MB WASM payload the
 * caller decides when (and whether) to load, and it keeps this package free of a hard browser-
 * only dependency: `(await import('@sqliteai/sqlite-wasm')).default()` is the usual way to get one.
 */
export default class WasmIndexReader {
	/**
	 * @param {any} sqlite3 - an initialized module from `@sqliteai/sqlite-wasm`'s default export.
	 * @param {Uint8Array} bytes - the whole database file.
	 */
	constructor(sqlite3, bytes) {
		this._sqlite3 = sqlite3;
		this._db = new sqlite3.oo1.DB(':memory:');
		// sqlite3_deserialize takes ownership of a WASM-heap copy (FREEONCLOSE), so the caller's
		// buffer is never referenced again — safe to hand over bytes that later get replaced by a
		// live poll. READONLY: nothing here should ever write, and a stray write would otherwise
		// silently diverge this copy from the file actually in the stream.
		const ptr = sqlite3.wasm.allocFromTypedArray(bytes);
		const { capi } = sqlite3;
		const rc = capi.sqlite3_deserialize(
			this._db.pointer, 'main', ptr, bytes.byteLength, bytes.byteLength,
			capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_READONLY,
		);
		if (rc !== 0) {
			this._db.close();
			throw new Error(`WasmIndexReader: couldn't open the index (sqlite3_deserialize rc=${rc})`);
		}
		this._dim = null;
	}

	/** @returns {?string} */
	getMeta(key) {
		const value = this._db.selectValue(`SELECT value FROM ${TABLE_META} WHERE key = ?`, [key]);
		return value ?? null;
	}

	/** @returns {Map<string, string>} every currently-indexed path → the content hash it was
	 *  indexed at — what a caller compares against the live files to spot stale hits. */
	getFileHashes() {
		const rows = this._db.exec({
			sql: `SELECT path, content_hash FROM ${TABLE_FILES}`,
			rowMode: 'object',
			returnValue: 'resultRows',
		});
		return new Map(rows.map((r) => [r.path, r.content_hash]));
	}

	/** Same role as `VectorIndex.initVectorColumn` — required once per connection before search. */
	initVectorColumn(dim, type = 'FLOAT32') {
		this._db.exec({ sql: VECTOR_INIT_SQL, bind: [vectorInitOptions(dim, type)] });
		this._dim = dim;
	}

	/**
	 * @param {Float32Array} queryEmbedding
	 * @param {number} k
	 * @returns {{path: string, chunkIndex: number, startOffset: number, endOffset: number, distance: number}[]}
	 */
	search(queryEmbedding, k) {
		if (this._dim === null) {
			const dim = Number(this.getMeta('dimension'));
			if (!dim) throw new Error('WasmIndexReader: index has no dimension recorded — is it empty?');
			this.initVectorColumn(dim);
		}
		const queryBlob = new Uint8Array(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
		// Plain numbers are fine here, unlike better-sqlite3 (see VectorIndex.search): the WASM
		// binding binds whole JS numbers as INTEGER, which vector_full_scan requires.
		const rows = this._db.exec({
			sql: SEARCH_SQL,
			bind: [queryBlob, overfetchFor(k), k],
			rowMode: 'object',
			returnValue: 'resultRows',
		});
		return rows.map(mapSearchRow);
	}

	close() {
		this._db.close();
	}
}
