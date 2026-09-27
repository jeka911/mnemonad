import { DEFAULT_DB_NAME } from '@mnemonad-search';
import StreamSearchClient from './StreamSearchClient.js';

/**
 * The non-UI half of searching a restored stream folder — shared by the file browser's header
 * box (StreamSearchBox.vue) and the docs page (docs/StreamDocs.vue), which differ only in how
 * they present hits.
 *
 * Works on anything shaped like a DoubleSyncFolder (async `list()`, files with `getContent()`/
 * `getFingerprint()`): the file browser's FileManagerDoubleSyncFolder and MonadSync.restore()'s
 * plain in-memory folder alike.
 */

const SNIPPET_CHARS = 360;

function toHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A chunk's text as a reader should see it. Chunks overlap by design (see the CLI search engine's
 * TextWindowChunkingStrategy), so every chunk after a file's first starts wherever the overlap
 * put it — usually mid-word ("ption key…"). The partial word is dropped and replaced with an
 * ellipsis. Offsets are untouched: this is display text only.
 */
export function readableChunk(fileText, startOffset, chunkText) {
	if (startOffset === 0 || /\s/.test(fileText[startOffset - 1] || '')) return chunkText;
	const space = chunkText.search(/\s/);
	if (space < 0) return chunkText;
	return '…' + chunkText.slice(space).replace(/^\s+/, '');
}

/** @returns {Promise<any|null>} the file or folder at `path` ('a/b/c.txt') under `root`. */
export async function findEntry(root, path) {
	let node = root;
	for (const part of path.split('/')) {
		if (!node || typeof node.list !== 'function') return null;
		const children = await node.list();
		node = children.find((c) => c.name === part) || null;
	}
	return node;
}

/** A child entry is a folder if it can be listed. Checked this way, rather than via an
 *  `isFolder` getter, because MonadSync's plain in-memory folder has no such getter. */
export function isFolderEntry(entry) {
	return !!entry && typeof entry.list === 'function';
}

/** @returns {Promise<boolean>} whether `folder` carries a search index at its root. */
export async function folderHasIndex(folder) {
	const entry = folder ? await findEntry(folder, DEFAULT_DB_NAME) : null;
	return !!entry && !isFolderEntry(entry);
}

export default class FolderSearch {
	/**
	 * @param {Object} [params]
	 * @param {(status: 'loading-model'|'model-ready') => void} [params.onStatus]
	 * @param {(loaded: number, total: number) => void} [params.onProgress]
	 */
	constructor({ onStatus, onProgress } = {}) {
		this._client = new StreamSearchClient({ onStatus, onProgress });
		// file → { content, hex }: a fingerprint is a hash of the whole file, so it's only
		// recomputed when the file's content array actually changes (an edit replaces it).
		this._fingerprints = new WeakMap();
	}

	/**
	 * Searches `folder`'s own index. Hits are joined back onto the live folder: files that are
	 * gone are dropped, the snippet is read out of the file itself (the index stores offsets,
	 * not text — same as the CLI), and files edited since indexing are flagged `stale`, since
	 * their offsets can no longer be trusted.
	 *
	 * @param {any} folder
	 * @param {string} query
	 * @param {number} k
	 * @returns {Promise<Array<{path: string, chunkIndex: number, startOffset: number,
	 *   endOffset: number, distance: number, score: number, stale: boolean,
	 *   chunkText: string, displayText: string, snippet: string, fileText: string}>>}
	 *   `chunkText` is the exact indexed slice; `displayText` is the same passage tidied for
	 *   reading (see readableChunk), and `snippet` its collapsed, shortened form.
	 */
	async search(folder, query, k) {
		const dbFile = await findEntry(folder, DEFAULT_DB_NAME);
		if (!dbFile || isFolderEntry(dbFile)) throw new Error('This stream has no search index.');
		const { fileHashes } = await this._client.open(await this._fingerprint(dbFile), await dbFile.getContent());
		const raw = await this._client.search(query, k);

		const decoder = new TextDecoder('utf-8', { fatal: false });
		const texts = new Map();
		const hits = [];
		for (const hit of raw) {
			const file = await findEntry(folder, hit.path);
			if (!file || isFolderEntry(file)) continue;
			if (!texts.has(file)) texts.set(file, decoder.decode(await file.getContent()));
			const fileText = texts.get(file);
			const chunkText = fileText.slice(hit.startOffset, hit.endOffset);
			const displayText = readableChunk(fileText, hit.startOffset, chunkText);
			hits.push({
				...hit,
				stale: (await this._fingerprint(file)) !== fileHashes[hit.path],
				score: Math.max(0, Math.round((1 - hit.distance) * 100)),
				chunkText,
				displayText,
				snippet: displayText.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
				fileText,
			});
		}
		return hits;
	}

	dispose() {
		this._client.dispose();
	}

	async _fingerprint(file) {
		const content = await file.getContent();
		const cached = this._fingerprints.get(file);
		if (cached && cached.content === content) return cached.hex;
		const hex = toHex(await file.getFingerprint());
		this._fingerprints.set(file, { content, hex });
		return hex;
	}
}
