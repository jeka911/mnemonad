/**
 * Caches item payload bytes — on-chain or off-chain, whichever a stream fetched — so
 * re-reading the same item doesn't re-fetch it. See `Mnemonad._readItemBytes` and
 * `MnemonadIpfs.readPointerBytes` for where this actually gets consulted; this file only
 * implements the store itself.
 *
 * **The one rule this cache exists under, and never violates: it stores bytes exactly as
 * fetched from chain or IPFS, before any decryption.** Both call sites above hand it
 * pre-decryption bytes — ciphertext for an encrypted stream, plaintext for an unencrypted
 * one — and `Mnemonad.at()` decrypts one layer above either. Caching post-decryption
 * plaintext would mean decrypted content sitting in local storage indefinitely, which is
 * exactly the exposure encrypting a stream is meant to avoid; caching the as-stored bytes
 * changes nothing, since those are already public on-chain or on IPFS regardless of who
 * caches them.
 *
 * A cache miss, or any failure of the cache itself (quota, private-browsing restrictions,
 * whatever), must never surface as a read failure — it only ever means "fetch for real",
 * exactly as if this class didn't exist. Every public method below reflects that: `get`
 * resolves to `undefined` rather than rejecting, `set` swallows its own errors.
 *
 * Backend is auto-detected and shared, not per-instance: IndexedDB when available (a
 * browser), otherwise a plain in-memory `Map` — same eviction rules, just not durable
 * across a reload. IndexedDB durability is the whole reason this exists, so a cache scoped
 * to one `Mnemonad` instance (dying with it) would defeat the point; see
 * `Mnemonad.js`'s `_getSharedChunkCache` for the sharing.
 */

/** @type {Required<Omit<ChunkCacheOptions, 'backend' | 'indexedDB'>>} */
export const DEFAULT_CHUNK_CACHE_OPTIONS = {
	maxEntries: 300,
	maxTotalBytes: 50 * 1024 * 1024, // 50 MB
	// Matches the 8 MB figure `Mnemonad.readPageBytes`'s own comment already cites (Monad's
	// per-transaction memory cap) — reused here rather than inventing an unrelated number,
	// since it's already this codebase's working notion of "one realistically-sized item".
	maxEntryBytes: 8 * 1024 * 1024,
	// Lets an app deliberately share one cache across independent `Mnemonad` configurations,
	// or isolate them (e.g. per-test, per-tenant) by giving each its own namespace instead.
	namespace: 'default',
};

/**
 * @typedef {Object} ChunkCacheOptions
 * @property {number} [maxEntries]
 * @property {number} [maxTotalBytes]
 * @property {number} [maxEntryBytes] - an entry larger than this is never cached at all,
 *   rather than being cached and immediately evicting everything else to make room for it.
 * @property {string} [namespace]
 * @property {Object} [backend] - an explicit backend (mainly for tests); skips auto-detection.
 * @property {Object} [indexedDB] - an explicit `IDBFactory` (e.g. `fake-indexeddb`'s, in
 *   tests) rather than the ambient global — lets a test get a real, isolated IndexedDB
 *   backend without polluting `globalThis`.
 */

export default class MnemonadChunkCache {
	/** @param {ChunkCacheOptions} [options={}] */
	constructor(options = {}) {
		this.maxEntries = options.maxEntries ?? DEFAULT_CHUNK_CACHE_OPTIONS.maxEntries;
		this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_CHUNK_CACHE_OPTIONS.maxTotalBytes;
		this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_CHUNK_CACHE_OPTIONS.maxEntryBytes;
		this.namespace = options.namespace ?? DEFAULT_CHUNK_CACHE_OPTIONS.namespace;

		if (options.backend) {
			this._backend = options.backend;
		} else {
			const idbFactory = options.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : null);
			this._backend = idbFactory
				? new IndexedDbChunkCacheBackend(this.namespace, idbFactory)
				: new MemoryChunkCacheBackend();
		}
	}

	/**
	 * @param {string} key
	 * @returns {Promise<?Uint8Array>} undefined on a miss, or on any cache failure — never
	 *   throws.
	 */
	async get(key) {
		try {
			const entry = await this._backend.getEntry(key);
			if (!entry) return undefined;
			// Fire-and-forget: bumping the LRU timestamp must never slow down a read that
			// already has its bytes in hand.
			this._backend.touchEntry(key, _now()).catch(() => {});
			return entry.bytes;
		} catch {
			return undefined;
		}
	}

	/**
	 * @param {string} key
	 * @param {Uint8Array} bytes
	 * @returns {Promise<void>} resolves either way — a caching failure is never the caller's
	 *   problem, so this is safe to call without awaiting.
	 */
	async set(key, bytes) {
		if (bytes.length > this.maxEntryBytes) return; // too large for the cache, on its own
		try {
			await this._backend.putEntry(key, { bytes, size: bytes.length, lastAccess: _now() });
			await this._evictIfNeeded();
		} catch {
			// Best-effort. A write that fails just means the next read fetches for real,
			// same as if this entry were never cached at all.
		}
	}

	/** Drops every cache entry. For a "clear cache" UI action, or between tests. */
	async clear() {
		try {
			await this._backend.clear();
		} catch {
			// Nothing meaningful to do with a failure to clear a best-effort cache.
		}
	}

	/** @returns {Promise<{entryCount: number, totalBytes: number}>} */
	async stats() {
		const entries = await this._backend.listEntriesByAccess();
		return {
			entryCount: entries.length,
			totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
		};
	}

	/**
	 * Evicts oldest-by-`lastAccess` entries until back under both limits.
	 *
	 * No separate running total is kept anywhere — `stats()` and this both recompute it by
	 * listing every entry. Deliberately: keeping an incremental counter in sync across
	 * concurrent, interleaved `set()`/evict calls (worse, across two IndexedDB object stores)
	 * is real complexity this cache doesn't need at the scale `maxEntries` is meant for — a
	 * few hundred entries. A full scan at that size costs nothing worth avoiding. Revisit
	 * only if `maxEntries` is ever configured far larger than this was designed around.
	 */
	async _evictIfNeeded() {
		const entries = await this._backend.listEntriesByAccess(); // ascending: oldest first
		let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
		let count = entries.length;
		let i = 0;
		while ((count > this.maxEntries || totalBytes > this.maxTotalBytes) && i < entries.length) {
			const evicted = entries[i++];
			await this._backend.deleteEntry(evicted.key);
			totalBytes -= evicted.size;
			count -= 1;
		}
	}
}

/**
 * A monotonically increasing "logical timestamp" for LRU ordering — not `Date.now()`
 * directly, deliberately. Two accesses inside the same millisecond are routine (a fast
 * synchronous burst, or just a quick cache hit followed immediately by another), and
 * `Date.now()`'s millisecond resolution makes those indistinguishable — a `touchEntry` that
 * lands in the same millisecond as the original write is not recorded as "more recent" at
 * all, silently defeating the whole point of touching an entry on read. Seeding the counter
 * from `Date.now()` at module load, then only ever incrementing, keeps values meaningful
 * across a reload too: a fresh session's counter starts at *real* current time, which is
 * always at least as large as anything the last session ever produced.
 * @returns {number}
 */
let _accessCounter = Date.now();
function _now() {
	return ++_accessCounter;
}

/**
 * In-memory backend: what a Mnemonad gets when no IndexedDB is available (Node, mainly).
 * Not durable — dies with the process — but the same eviction rules still apply, and it's
 * a free win within one script or test run instead of caching nothing at all there.
 */
class MemoryChunkCacheBackend {
	constructor() {
		/** @type {Map<string, {bytes: Uint8Array, size: number, lastAccess: number}>} */
		this._map = new Map();
	}

	async getEntry(key) {
		return this._map.get(key);
	}

	async putEntry(key, entry) {
		this._map.set(key, entry);
	}

	async deleteEntry(key) {
		this._map.delete(key);
	}

	async touchEntry(key, lastAccess) {
		const entry = this._map.get(key);
		if (entry) entry.lastAccess = lastAccess;
	}

	async listEntriesByAccess() {
		return [...this._map.entries()]
			.map(([key, e]) => ({ key, size: e.size, lastAccess: e.lastAccess }))
			.sort((a, b) => a.lastAccess - b.lastAccess);
	}

	async clear() {
		this._map.clear();
	}
}

const IDB_VERSION = 1;
const IDB_STORE_NAME = 'chunks';

/**
 * IndexedDB-backed store. One object store, one record per cached entry — `{key, bytes,
 * size, lastAccess}` — keyed by `key` directly. `bytes` is stored as the `Uint8Array` it
 * already is; IndexedDB's structured-clone algorithm handles typed arrays natively, no
 * base64/JSON detour needed.
 */
class IndexedDbChunkCacheBackend {
	/**
	 * @param {string} namespace
	 * @param {IDBFactory} idbFactory
	 */
	constructor(namespace, idbFactory) {
		this._dbName = `mnemonad-chunk-cache:${namespace}`;
		this._idbFactory = idbFactory;
		/** @type {?Promise<IDBDatabase>} */
		this._dbPromise = null;
	}

	_open() {
		if (this._dbPromise) return this._dbPromise;
		this._dbPromise = new Promise((resolve, reject) => {
			const request = this._idbFactory.open(this._dbName, IDB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
					db.createObjectStore(IDB_STORE_NAME, { keyPath: 'key' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return this._dbPromise;
	}

	async _store(mode) {
		const db = await this._open();
		return db.transaction(IDB_STORE_NAME, mode).objectStore(IDB_STORE_NAME);
	}

	async getEntry(key) {
		const store = await this._store('readonly');
		return await _requestToPromise(store.get(key));
	}

	async putEntry(key, entry) {
		const store = await this._store('readwrite');
		await _requestToPromise(store.put({ key, ...entry }));
	}

	async deleteEntry(key) {
		const store = await this._store('readwrite');
		await _requestToPromise(store.delete(key));
	}

	async touchEntry(key, lastAccess) {
		const store = await this._store('readwrite');
		const existing = await _requestToPromise(store.get(key));
		if (!existing) return;
		existing.lastAccess = lastAccess;
		await _requestToPromise(store.put(existing));
	}

	async listEntriesByAccess() {
		const store = await this._store('readonly');
		const all = await _requestToPromise(store.getAll());
		return all
			.map(({ key, size, lastAccess }) => ({ key, size, lastAccess }))
			.sort((a, b) => a.lastAccess - b.lastAccess);
	}

	async clear() {
		const store = await this._store('readwrite');
		await _requestToPromise(store.clear());
	}
}

/** @param {IDBRequest} request */
function _requestToPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
