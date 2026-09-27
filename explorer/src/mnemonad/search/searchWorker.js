// Stream search, off the main thread. Owns the two heavy pieces — sqlite-wasm (with
// sqlite-vector compiled in) and the embedding model the index was built with (the built-in
// static one, or MiniLM through transformers.js) — so neither loading them nor running a query
// ever blocks the page. Both load lazily, on the first request: a page that never searches
// never fetches either.
//
// Protocol (see StreamSearchClient.js, the only sender):
//   → { id, type: 'open', key, bytes }   open a search_index.db; `key` is its content hash,
//                                         a repeat key is a no-op
//   → { id, type: 'search', query, k }
//   ← { id, result } | { id, error }
//   ← { type: 'status', status }          'loading-model' | 'model-ready'
//   ← { type: 'progress', loaded, total } the model's one-time download
import wasmUrl from '@sqliteai/sqlite-wasm/sqlite3.wasm?url';
import {
	BrowserSearcher, StaticEmbeddingProvider, browserModelFiles, EMBEDDER_STATIC,
} from '@mnemonad-search';

let searcherPromise = null;
let openedKey = null;
let fileHashes = null;

// Both kinds of model report progress per file (config, tokenizer, weights, ...), in the same
// shape — summed here into one number, which is all the search UI shows.
const downloads = new Map();
function onModelProgress(event) {
	if (event.status !== 'progress' || !event.file) return;
	downloads.set(event.file, { loaded: event.loaded || 0, total: event.total || 0 });
	let loaded = 0;
	let total = 0;
	for (const d of downloads.values()) {
		loaded += d.loaded;
		total += d.total;
	}
	self.postMessage({ type: 'progress', loaded, total });
}

/**
 * The embedding model an index asks for. The built-in static model (potion) is plain JS and
 * ships with the page. MiniLM needs transformers.js and ONNX Runtime's WASM build, so that
 * import is dynamic: only a visitor searching an index built with MiniLM ever downloads it.
 */
async function createProvider({ model, embedder, dtype, onProgress }) {
	if (embedder === EMBEDDER_STATIC) {
		return new StaticEmbeddingProvider({ model, files: browserModelFiles(model, { onProgress }) });
	}
	const { createProvider: createTransformersProvider } = await import('@mnemonad-search-transformers');
	return createTransformersProvider({ model, ...(dtype ? { dtype } : {}), onProgress });
}

function getSearcher() {
	if (!searcherPromise) {
		searcherPromise = (async () => {
			const { default: sqlite3InitModule } = await import('@sqliteai/sqlite-wasm');
			const sqlite3 = await sqlite3InitModule({
				locateFile: () => wasmUrl,
				print: () => {},
				printErr: (...args) => console.warn('[sqlite-wasm]', ...args),
			});
			return new BrowserSearcher({ sqlite3, createProvider, onModelProgress });
		})();
		// A failed load (network, CSP) shouldn't wedge every later attempt behind the same
		// rejected promise.
		searcherPromise.catch(() => { searcherPromise = null; });
	}
	return searcherPromise;
}

async function open({ key, bytes }) {
	const searcher = await getSearcher();
	if (key !== openedKey || !searcher.isOpen) {
		searcher.open(bytes);
		openedKey = key;
		fileHashes = Object.fromEntries(searcher.getFileHashes());
	}
	return { info: searcher.info, fileHashes };
}

async function search({ query, k }) {
	const searcher = await getSearcher();
	if (!searcher.isModelLoaded) {
		self.postMessage({ type: 'status', status: 'loading-model' });
		await searcher.loadModel();
		self.postMessage({ type: 'status', status: 'model-ready' });
	}
	return searcher.search(query, k);
}

const HANDLERS = { open, search };

self.onmessage = async (event) => {
	const { id, type, ...payload } = event.data;
	const handler = HANDLERS[type];
	try {
		if (!handler) throw new Error(`searchWorker: unknown request "${type}"`);
		self.postMessage({ id, result: await handler(payload) });
	} catch (err) {
		self.postMessage({ id, error: err?.message || String(err) });
	}
};
