import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { VECTOR_INIT_SQL, SEARCH_SQL, vectorInitOptions, overfetchFor, mapSearchRow } from './schema.js';

// @sqliteai/sqlite-vector's own ESM build (dist/index.mjs) cannot find its platform binary
// package from a genuine ESM context — it tries a bare `require(packageName)` via a bundler-
// injected shim that only works when a real CJS `require` is already in scope, which never
// happens in native ESM (confirmed live: `import { getExtensionPath } from
// '@sqliteai/sqlite-vector'` throws `ExtensionNotFoundError` even when the platform package
// is correctly installed). `createRequire` is the standard Node workaround — it resolves the
// package's CJS build instead, where a real `require` exists and the same lookup works.
const require = createRequire(import.meta.url);
const { getExtensionPath } = require('@sqliteai/sqlite-vector');

/**
 * A single, diff-friendly SQLite file holding embeddings for one synced folder — meant to be
 * pushed alongside the folder's own content (a plain file, not dot-prefixed, so it rides
 * through `push`/`pull`/`diff` unmodified) so a pull is immediately searchable with no
 * re-embedding.
 *
 * The whole schema is designed around one constraint, verified empirically (not assumed):
 * inserting rows into a plain table with a monotonic rowid touches only new/near-full pages,
 * which content-defined chunking recognizes as mostly-unchanged on a re-push. A real
 * measurement (200 existing rows, 5 new ones) showed ~2.9x overhead versus the new data's
 * raw size — nowhere near a full-file rewrite, but *not* literally zero-touch either. What
 * actually breaks this property: `VACUUM` (copies and rewrites every byte — never call it
 * during routine reindexing) and `UPDATE`/`DELETE` on the (large, embedding-heavy)
 * `search_index` table. `search_index_files` is deliberately the one place this class *does*
 * mutate rows in place — it holds one row per file, so its churn is proportional to how many
 * files actually changed, not to corpus size, and paying that small cost is what makes
 * "which chunks are current" a correct query instead of a guess (see search_index_files' own
 * doc below).
 */
export default class VectorIndex {
	/**
	 * @param {string} dbPath - path to the SQLite file. Created if it doesn't exist yet
	 *   (unless `readonly`).
	 * @param {Object} [options]
	 * @param {boolean} [options.readonly=false] - open an existing index without writing
	 *   anything to it — not even the schema check below. For inspecting an index that's about
	 *   to be pushed (see Indexer.status()), where touching the file would change what's pushed.
	 */
	constructor(dbPath, { readonly = false } = {}) {
		this.path = dbPath;
		this._db = readonly
			? new Database(dbPath, { readonly: true, fileMustExist: true })
			: new Database(dbPath);
		// Deliberately not enabling WAL mode: WAL leaves a separate `-wal`/`-shm` file holding
		// uncommitted pages, which would need an explicit checkpoint before every push (a real
		// operational footgun for anyone forgetting it). Left at SQLite's own default rollback
		// journal instead — this class always closes the database (see close()) before anything
		// downstream would push it, so there's never a mid-transaction state to leave behind.
		this._db.loadExtension(getExtensionPath());
		if (!readonly) this._ensureSchema();
	}

	_ensureSchema() {
		this._db.exec(`
			CREATE TABLE IF NOT EXISTS search_index (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				content_hash TEXT NOT NULL,
				start_offset INTEGER NOT NULL,
				end_offset INTEGER NOT NULL,
				embedding BLOB NOT NULL
			)
		`);
		// One row per file, deliberately mutable (see class doc) — "content_hash" here is what
		// decides which rows in the (append-only) search_index table above actually count as
		// current: a chunk only counts if its own content_hash matches this table's row for the
		// same path. That's what lets a stale reindex's chunks keep existing physically (pure
		// insert, never deleted) while still being correctly excluded from search results —
		// see search()'s own join.
		this._db.exec(`
			CREATE TABLE IF NOT EXISTS search_index_files (
				path TEXT PRIMARY KEY,
				content_hash TEXT NOT NULL,
				chunk_count INTEGER NOT NULL
			)
		`);
		this._db.exec(`
			CREATE TABLE IF NOT EXISTS search_index_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
	}

	/**
	 * Registers `search_index`/`embedding` as a vector column with sqlite-vector — required on
	 * every fresh connection before `vector_full_scan` etc. work (confirmed live: omitting this
	 * fails with "vector_full_scan: unable to retrieve context", not a clearer error). Safe to
	 * call more than once; last call wins.
	 *
	 * @param {number} dim
	 * @param {'FLOAT32'|'INT8'} [type='FLOAT32']
	 */
	initVectorColumn(dim, type = 'FLOAT32') {
		this._dim = dim;
		this._vectorType = type;
		this._db.prepare(VECTOR_INIT_SQL).run(vectorInitOptions(dim, type));
	}

	/** @returns {?string} the file's currently-indexed content hash, or null if never indexed. */
	getFileHash(path) {
		const row = this._db.prepare('SELECT content_hash FROM search_index_files WHERE path = ?').get(path);
		return row?.content_hash ?? null;
	}

	/** @returns {string[]} every path currently recorded in the index (indexed, not necessarily still on disk). */
	listFiles() {
		return this._db.prepare('SELECT path FROM search_index_files').all().map((r) => r.path);
	}

	/**
	 * Replaces one file's chunks. Never touches the file's *old* rows in `search_index` — it
	 * only ever inserts new ones (see class doc for why) — and upserts the single
	 * `search_index_files` row that makes the old ones stop counting as current.
	 *
	 * @param {string} path
	 * @param {string} contentHash - the file's new content hash (same hashing this package's
	 *   caller already uses to detect the file changed in the first place).
	 * @param {{startOffset: number, endOffset: number, embedding: Float32Array}[]} chunks
	 */
	replaceFileChunks(path, contentHash, chunks) {
		const insert = this._db.prepare(`
			INSERT INTO search_index (path, chunk_index, content_hash, start_offset, end_offset, embedding)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
		const upsertFile = this._db.prepare(`
			INSERT INTO search_index_files (path, content_hash, chunk_count) VALUES (?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, chunk_count = excluded.chunk_count
		`);
		const tx = this._db.transaction(() => {
			chunks.forEach((chunk, index) => {
				insert.run(path, index, contentHash, chunk.startOffset, chunk.endOffset, Buffer.from(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength));
			});
			upsertFile.run(path, contentHash, chunks.length);
		});
		tx();
	}

	/** A file no longer exists in the tree — stop counting its (still physically present) chunks as current. */
	removeFile(path) {
		this._db.prepare('DELETE FROM search_index_files WHERE path = ?').run(path);
	}

	setMeta(key, value) {
		this._db.prepare(`
			INSERT INTO search_index_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run(key, String(value));
	}

	/**
	 * An existing index's metadata, read without writing anything — or null when there's no
	 * index at `dbPath` (or it has no metadata yet).
	 * @returns {?Object<string, string>}
	 */
	static readMeta(dbPath) {
		if (!existsSync(dbPath)) return null;
		const index = new VectorIndex(dbPath, { readonly: true });
		try {
			const rows = index._db.prepare('SELECT key, value FROM search_index_meta').all();
			return rows.length ? Object.fromEntries(rows.map((r) => [r.key, r.value])) : null;
		} catch {
			// No meta table: not an index this package built.
			return null;
		} finally {
			index.close();
		}
	}

	/** @returns {?string} */
	getMeta(key) {
		return this._db.prepare('SELECT value FROM search_index_meta WHERE key = ?').get(key)?.value ?? null;
	}

	/**
	 * Nearest-neighbor search, current chunks only. Over-fetches from `vector_full_scan` (exact,
	 * brute-force — appropriate for the corpus sizes a synced folder actually has; no ANN/
	 * partitioning index, which would break the diffability this whole design depends on) since
	 * some of its top candidates may turn out to be stale once joined against
	 * `search_index_files`, and stops short of the caller's requested `k` otherwise.
	 *
	 * @param {Float32Array} queryEmbedding
	 * @param {number} k
	 * @returns {{path: string, chunkIndex: number, startOffset: number, endOffset: number, distance: number}[]}
	 */
	search(queryEmbedding, k) {
		const queryBuf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
		// BigInt, not a plain number: better-sqlite3 binds every JS `number` parameter as SQLite
		// REAL (confirmed live — even a whole number like 64), but vector_full_scan's own count
		// argument strictly requires INTEGER and rejects REAL outright rather than coercing it.
		// (The WASM build binds whole numbers as INTEGER on its own — see WasmIndexReader.)
		return this._db
			.prepare(SEARCH_SQL)
			.all(queryBuf, BigInt(overfetchFor(k)), BigInt(k))
			.map(mapSearchRow);
	}

	/**
	 * The deliberate, rare, full-rewrite operation — drops every chunk that isn't current
	 * (superseded by a later reindex of the same file, or belonging to a file removed from the
	 * index entirely) and reclaims the space. Costs a CDC-diff equivalent to a full snapshot —
	 * same trade routine reindexing exists specifically to avoid — so this is opt-in, not run
	 * automatically. Mirrors the CLI's own `compact` command for stream history.
	 */
	compact() {
		this._db.exec(`
			DELETE FROM search_index
			WHERE NOT EXISTS (
				SELECT 1 FROM search_index_files f
				WHERE f.path = search_index.path AND f.content_hash = search_index.content_hash
			)
		`);
		this._db.exec('VACUUM');
	}

	close() {
		this._db.close();
	}
}
