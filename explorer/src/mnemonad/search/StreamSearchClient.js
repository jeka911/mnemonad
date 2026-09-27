/**
 * Main-thread handle on searchWorker.js — request/response over postMessage, plus the
 * worker's unsolicited status/progress events. The worker itself is only spawned on the
 * first request, so constructing one of these costs nothing.
 */
export default class StreamSearchClient {
	/**
	 * @param {Object} [params]
	 * @param {(status: 'loading-model'|'model-ready') => void} [params.onStatus]
	 * @param {(loaded: number, total: number) => void} [params.onProgress]
	 */
	constructor({ onStatus, onProgress } = {}) {
		this._onStatus = onStatus || (() => {});
		this._onProgress = onProgress || (() => {});
		this._worker = null;
		this._pending = new Map();
		this._nextId = 1;
	}

	/**
	 * Opens (or keeps) the index. The bytes are structured-cloned, never transferred:
	 * transferring would detach the buffer the file browser's own copy of the file still uses.
	 *
	 * @param {string} key - the db file's content hash; the worker skips re-opening a repeat.
	 * @param {Uint8Array} bytes
	 * @returns {Promise<{info: {model: ?string, dtype: string, dimension: number}, fileHashes: Object<string, string>}>}
	 */
	open(key, bytes) {
		return this._call('open', { key, bytes });
	}

	/**
	 * @param {string} query
	 * @param {number} k
	 * @returns {Promise<{path: string, chunkIndex: number, startOffset: number, endOffset: number, distance: number}[]>}
	 */
	search(query, k) {
		return this._call('search', { query, k });
	}

	dispose() {
		if (this._worker) {
			this._worker.terminate();
			this._worker = null;
		}
		this._rejectAll(new Error('Search was closed'));
	}

	_call(type, payload) {
		const worker = this._ensureWorker();
		const id = this._nextId++;
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			worker.postMessage({ id, type, ...payload });
		});
	}

	_ensureWorker() {
		if (this._worker) return this._worker;
		const worker = new Worker(new URL('./searchWorker.js', import.meta.url), { type: 'module' });
		worker.onmessage = (event) => {
			const msg = event.data;
			if (msg.type === 'status') return this._onStatus(msg.status);
			if (msg.type === 'progress') return this._onProgress(msg.loaded, msg.total);
			const pending = this._pending.get(msg.id);
			if (!pending) return;
			this._pending.delete(msg.id);
			if ('error' in msg) pending.reject(new Error(msg.error));
			else pending.resolve(msg.result);
		};
		// A worker that fails to even load its module (a bad chunk URL, a CSP block) never
		// answers anything — without this every pending call would hang forever. Dropped so the
		// next call spawns a fresh one.
		worker.onerror = (event) => {
			event.preventDefault?.();
			this._rejectAll(new Error(event.message || 'Search worker failed to start'));
			worker.terminate();
			if (this._worker === worker) this._worker = null;
		};
		this._worker = worker;
		return worker;
	}

	_rejectAll(err) {
		for (const { reject } of this._pending.values()) reject(err);
		this._pending.clear();
	}
}
