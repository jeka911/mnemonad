/**
 * The download half of a model file source, shared by Node (modelFiles.node.js) and the browser
 * (modelFiles.browser.js) — plain `fetch`, which both have.
 */

const HUB = 'https://huggingface.co';

/** @returns {string} where the hub serves `name` from `model`'s main branch. */
export function hubUrl(model, name) {
	return `${HUB}/${model}/resolve/main/${name}`;
}

/**
 * Fetches `url` into memory, reporting progress in the same shape transformers.js does
 * (`{status: 'progress', file, loaded, total}`), so one progress display works for either
 * kind of model.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function downloadWithProgress(url, name, onProgress) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`couldn't download ${name} (${res.status} ${res.statusText}) from ${url}`);
	const total = Number(res.headers.get('content-length')) || 0;
	if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());

	const reader = res.body.getReader();
	const parts = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		loaded += value.byteLength;
		onProgress({ status: 'progress', file: name, loaded, total: total || loaded });
	}
	const bytes = new Uint8Array(loaded);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	onProgress({ status: 'done', file: name, loaded, total: total || loaded });
	return bytes;
}
