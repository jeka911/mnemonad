import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3InitModule from '@sqliteai/sqlite-wasm';
import Indexer from '../../lib/search/Indexer.js';
import VectorIndex from '../../lib/search/VectorIndex.js';
import TextWindowChunkingStrategy from '../../lib/search/chunking/TextWindowChunkingStrategy.js';
import { WasmIndexReader, BrowserSearcher } from '../../lib/search/browser.js';
import { FakeEmbeddingProvider, makeInMemoryFolder } from './fixture.js';

// The browser reader's whole point is to rank exactly like the Node one on the same file —
// these build an index through the real Node path (better-sqlite3 + native sqlite-vector),
// then read the resulting bytes through the WASM build and compare.

let sqlite3;
let dir;
let dbPath;

beforeAll(async () => {
	sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'mnemonad-search-wasm-'));
	dbPath = join(dir, 'search_index.db');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const FILES = {
	'hare.txt': 'The hare and the tortoise agreed to a race. Slow and steady wins the race, said the tortoise.',
	'fox.txt': 'A fox saw grapes on a high vine and, unable to reach them, declared they were sour anyway.',
	'ant.txt': 'The ant worked all summer storing grain while the grasshopper sang and played.',
};

function makeIndexer(embedder) {
	return new Indexer({
		embeddingProvider: embedder,
		chunkingStrategy: new TextWindowChunkingStrategy({ size: 200, overlap: 20 }),
	});
}

describe('WasmIndexReader', () => {
	it('returns the same hits, in the same order, as VectorIndex on the same file', async () => {
		const embedder = new FakeEmbeddingProvider({ dim: 16 });
		await makeIndexer(embedder).index(makeInMemoryFolder(FILES), dbPath);
		const [query] = await embedder.embed(['slow steady race tortoise']);

		const nodeIndex = new VectorIndex(dbPath);
		nodeIndex.initVectorColumn(16);
		const nodeHits = nodeIndex.search(query, 3);
		nodeIndex.close();

		const reader = new WasmIndexReader(sqlite3, new Uint8Array(await readFile(dbPath)));
		const wasmHits = reader.search(query, 3);
		reader.close();

		expect(nodeHits[0].path).toBe('hare.txt');
		const strip = ({ distance, ...rest }) => rest;
		expect(wasmHits.map(strip)).toEqual(nodeHits.map(strip));
		// Not bit-identical: the native build and the WASM build accumulate float32 differently
		// (measured: last ~1e-7), which is below anything that could reorder real results.
		wasmHits.forEach((hit, i) => expect(hit.distance).toBeCloseTo(nodeHits[i].distance, 6));
	});

	it('excludes chunks superseded by a reindex, same as the Node join', async () => {
		const embedder = new FakeEmbeddingProvider({ dim: 16 });
		await makeIndexer(embedder).index(makeInMemoryFolder(FILES), dbPath);
		await makeIndexer(embedder).index(makeInMemoryFolder({ ...FILES, 'hare.txt': 'Completely different text about banking.' }), dbPath);
		const [query] = await embedder.embed(['slow steady race tortoise']);

		const reader = new WasmIndexReader(sqlite3, new Uint8Array(await readFile(dbPath)));
		const hits = reader.search(query, 10);
		reader.close();

		// hare.txt now has exactly one current chunk (the banking text) — its old chunk still
		// exists physically, but mustn't come back.
		expect(hits.filter((h) => h.path === 'hare.txt')).toHaveLength(1);
		expect(hits).toHaveLength(3);
	});

	it('reads metadata and per-file hashes', async () => {
		await makeIndexer(new FakeEmbeddingProvider({ dim: 16 })).index(makeInMemoryFolder(FILES), dbPath);
		const reader = new WasmIndexReader(sqlite3, new Uint8Array(await readFile(dbPath)));
		expect(reader.getMeta('model')).toBe('fake-test-embedder');
		expect(reader.getMeta('dimension')).toBe('16');
		expect(reader.getMeta('missing')).toBe(null);
		const hashes = reader.getFileHashes();
		expect([...hashes.keys()].sort()).toEqual(['ant.txt', 'fox.txt', 'hare.txt']);
		expect(hashes.get('hare.txt')).toMatch(/^[0-9a-f]{64}$/);
		reader.close();
	});

	it('rejects bytes that are not a database', () => {
		const reader = new WasmIndexReader(sqlite3, new TextEncoder().encode('not a sqlite file at all, just text'));
		expect(() => reader.getMeta('model')).toThrow();
		reader.close();
	});
});

describe('BrowserSearcher', () => {
	it('embeds the query and searches the opened bytes', async () => {
		const embedder = new FakeEmbeddingProvider({ dim: 16 });
		await makeIndexer(embedder).index(makeInMemoryFolder(FILES), dbPath);

		const searcher = new BrowserSearcher({ sqlite3, embeddingProvider: embedder });
		searcher.open(new Uint8Array(await readFile(dbPath)));
		// The fake records no embedder, so — like any pre-embedder index — it reads as transformers-built.
		expect(searcher.info).toEqual({ model: 'fake-test-embedder', embedder: 'transformers', dtype: 'fp32', dimension: 16 });
		const hits = await searcher.search('grapes sour vine', 2);
		expect(hits[0].path).toBe('fox.txt');
		searcher.close();
		expect(searcher.isOpen).toBe(false);
	});

	it('refuses a query embedded with a different dimension', async () => {
		await makeIndexer(new FakeEmbeddingProvider({ dim: 16 })).index(makeInMemoryFolder(FILES), dbPath);
		const searcher = new BrowserSearcher({ sqlite3, embeddingProvider: new FakeEmbeddingProvider({ dim: 8 }) });
		searcher.open(new Uint8Array(await readFile(dbPath)));
		await expect(searcher.search('anything')).rejects.toThrow(/dimensional/);
		searcher.close();
	});
});
