import { existsSync, rmSync } from 'node:fs';
import VectorIndex from './VectorIndex.js';
import TextWindowChunkingStrategy from './chunking/TextWindowChunkingStrategy.js';

/** First N bytes checked for a null byte — the standard, cheap heuristic (same one git and
 *  most diff tools use) for "this is almost certainly binary, don't try to embed it as text". */
const BINARY_SNIFF_BYTES = 8000;

function looksLikeText(bytes) {
	const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < n; i++) {
		if (bytes[i] === 0) return false;
	}
	return true;
}

function toHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds/updates a `VectorIndex` from a folder — anything shaped like
 * `@fizzyflow/doublesync`'s `DoubleSyncFolder` (has an async `walk()` generator), which
 * covers the CLI's real-disk `FSFolder` and any in-memory folder the same way. Incremental by
 * construction: a file whose content hash already matches what's stored is skipped entirely,
 * no re-embedding, no re-chunking, not even a read past the hash check.
 */
export default class Indexer {
	/**
	 * @param {Object} [params]
	 * @param {?import('./embeddings/EmbeddingProvider.js').default} [params.embeddingProvider] -
	 *   required by `index()`; `status()` never embeds, so it can go without one (see
	 *   providers.js's createProvider for the usual way to get one).
	 * @param {import('./chunking/ChunkingStrategy.js').default} [params.chunkingStrategy]
	 */
	constructor({ embeddingProvider = null, chunkingStrategy } = {}) {
		this.embeddingProvider = embeddingProvider;
		this.chunkingStrategy = chunkingStrategy || new TextWindowChunkingStrategy();
	}

	/**
	 * What `index()` would do to `dbPath`, without doing it: no embedding, no model load, and
	 * the database opened read-only. Uses the same walk and the same rules as `index()` (see
	 * `_scan`), so it agrees exactly on which files count — a binary or empty file, which
	 * `index()` never records, isn't reported as missing from the index.
	 *
	 * @param {import('@fizzyflow/doublesync').DoubleSyncFolder} folder
	 * @param {string} dbPath
	 * @returns {Promise<?{changed: string[], added: string[], removed: string[]}>} null when
	 *   there's no index at `dbPath` at all.
	 */
	async status(folder, dbPath) {
		if (!existsSync(dbPath)) return null;
		const index = new VectorIndex(dbPath, { readonly: true });
		try {
			const indexed = new Set(index.listFiles());
			const changed = [];
			const added = [];
			const seen = new Set();
			for await (const entry of this._scan(folder, index)) {
				// An emptied file is left out of `seen`, so it comes out as removed below —
				// exactly what index() would do to it.
				if (!entry.unchanged && !entry.chunks) continue;
				seen.add(entry.relPath);
				if (entry.unchanged) continue;
				(indexed.has(entry.relPath) ? changed : added).push(entry.relPath);
			}
			const removed = [...indexed].filter((p) => !seen.has(p));
			return { changed, added, removed };
		} finally {
			index.close();
		}
	}

	/**
	 * The walk both `index()` and `status()` run. Yields one entry per text file:
	 * `{relPath, unchanged: true}` when the index already has it at this content hash, or
	 * `{relPath, hash, chunks}` otherwise (`chunks` null for a file with no text to embed).
	 */
	async *_scan(folder, index) {
		for await (const { path, file } of folder.walk()) {
			const relPath = path.join('/');
			const bytes = await file.getContent();
			if (!looksLikeText(bytes)) continue;

			const hash = toHex(await file.getFingerprint());
			if (index.getFileHash(relPath) === hash) {
				yield { relPath, unchanged: true };
				continue;
			}

			const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
			const chunks = this.chunkingStrategy.chunk(text);
			yield { relPath, hash, chunks: chunks.length > 0 ? chunks : null };
		}
	}

	/**
	 * @param {import('@fizzyflow/doublesync').DoubleSyncFolder} folder
	 * @param {string} dbPath
	 * @param {Object} [opts]
	 * @param {boolean} [opts.rebuild] - start from an empty index instead of updating this one:
	 *   every file is embedded again. The one way to switch an index to a different model — and,
	 *   since it rewrites the whole file, the next push carries the full index again.
	 * @returns {Promise<{filesChanged: number, filesSkipped: number, filesRemoved: number, chunksAdded: number}>}
	 */
	async index(folder, dbPath, { rebuild = false } = {}) {
		if (!this.embeddingProvider) throw new Error('Indexer.index: no embeddingProvider configured');
		if (rebuild) {
			rmSync(dbPath, { force: true });
			rmSync(`${dbPath}-journal`, { force: true });
		} else {
			assertSameModel(VectorIndex.readMeta(dbPath), this.embeddingProvider, dbPath);
		}
		const index = new VectorIndex(dbPath);
		try {
			const seenPaths = new Set();
			// One entry per changed/new file, chunked but not yet embedded — embedding happens
			// in one batched call across every changed file below, rather than one call per
			// file, since a single call amortizes the model's own fixed per-call overhead.
			const pending = [];
			let filesSkipped = 0;

			for await (const entry of this._scan(folder, index)) {
				// A file with no text to embed (emptied since last time) is deliberately left out
				// of seenPaths, so the removal pass below drops its old chunks like a deleted file's.
				if (entry.unchanged) {
					seenPaths.add(entry.relPath);
					filesSkipped++;
				} else if (entry.chunks) {
					seenPaths.add(entry.relPath);
					pending.push(entry);
				}
			}

			let chunksAdded = 0;
			if (pending.length > 0) {
				const allTexts = pending.flatMap((p) => p.chunks.map((c) => c.text));
				const allVectors = await this.embeddingProvider.embed(allTexts);
				index.initVectorColumn(this.embeddingProvider.dimension);

				let cursor = 0;
				for (const p of pending) {
					const vectors = allVectors.slice(cursor, cursor + p.chunks.length);
					cursor += p.chunks.length;
					index.replaceFileChunks(p.relPath, p.hash, p.chunks.map((c, i) => ({
						startOffset: c.startOffset,
						endOffset: c.endOffset,
						embedding: vectors[i],
					})));
					chunksAdded += p.chunks.length;
				}

				index.setMeta('model', this.embeddingProvider.modelId);
				if (this.embeddingProvider.embedder) index.setMeta('embedder', this.embeddingProvider.embedder);
				index.setMeta('dimension', String(this.embeddingProvider.dimension));
				if (this.embeddingProvider.dtype) index.setMeta('dtype', this.embeddingProvider.dtype);
				index.setMeta('chunk_size', String(this.chunkingStrategy.size ?? ''));
				index.setMeta('chunk_overlap', String(this.chunkingStrategy.overlap ?? ''));
			} else {
				// Nothing changed this run — if the index already has content from a previous
				// run, the vector column still needs registering on this fresh connection (see
				// VectorIndex.initVectorColumn's own doc) before removeFile()'s bookkeeping below
				// touches the same tables. Not required for a genuinely empty/new index — there's
				// no dimension to know yet, and nothing to query either.
				const existingDim = index.getMeta('dimension');
				if (existingDim) index.initVectorColumn(Number(existingDim));
			}

			let filesRemoved = 0;
			for (const indexedPath of index.listFiles()) {
				if (!seenPaths.has(indexedPath)) {
					index.removeFile(indexedPath);
					filesRemoved++;
				}
			}

			return { filesChanged: pending.length, filesSkipped, filesRemoved, chunksAdded };
		} finally {
			index.close();
		}
	}
}

/**
 * Thrown when `index()` would add one model's vectors to an index built with another — two
 * models' vectors aren't comparable (and usually aren't even the same length), so mixing them
 * would quietly break every search. `rebuild` is the way through.
 */
export class ModelMismatchError extends Error {
	constructor(dbPath, indexModel, providerModel) {
		super(
			`${dbPath} was built with ${indexModel}, not ${providerModel} — one index can't mix two models.`
		);
		this.name = 'ModelMismatchError';
		this.indexModel = indexModel;
		this.providerModel = providerModel;
	}
}

function assertSameModel(meta, provider, dbPath) {
	if (!meta?.model) return;
	if (meta.model !== provider.modelId) throw new ModelMismatchError(dbPath, meta.model, provider.modelId);
}
