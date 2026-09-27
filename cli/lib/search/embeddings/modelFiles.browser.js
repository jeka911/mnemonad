import { downloadWithProgress, hubUrl } from './modelFiles.shared.js';

/**
 * A model's files for StaticEmbeddingProvider in a browser (or a worker): fetched from the
 * Hugging Face hub once, then served from the Cache API, so revisits don't download again.
 * Falls back to plain fetching where the Cache API isn't available (an insecure context, say).
 *
 * @param {string} model - e.g. 'minishlab/potion-base-8M'
 * @param {Object} [opts]
 * @param {(event: Object) => void} [opts.onProgress] - `{status: 'progress', file, loaded, total}`
 */
export function browserModelFiles(model, { onProgress = null, cacheName = 'mnemonad-models' } = {}) {
	return {
		async get(name) {
			const url = hubUrl(model, name);
			const cache = typeof caches !== 'undefined' ? await caches.open(cacheName).catch(() => null) : null;
			const hit = cache && await cache.match(url);
			if (hit) return new Uint8Array(await hit.arrayBuffer());

			const bytes = await downloadWithProgress(url, name, onProgress);
			if (cache) {
				// Best effort: a full quota just means downloading again next time.
				await cache.put(url, new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })).catch(() => {});
			}
			return bytes;
		},
	};
}
