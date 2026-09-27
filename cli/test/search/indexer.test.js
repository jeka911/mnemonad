import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Indexer, { ModelMismatchError } from '../../lib/search/Indexer.js';
import VectorIndex from '../../lib/search/VectorIndex.js';
import Searcher from '../../lib/search/Searcher.js';
import TextWindowChunkingStrategy from '../../lib/search/chunking/TextWindowChunkingStrategy.js';
import { FakeEmbeddingProvider, makeInMemoryFolder } from './fixture.js';

let dir;
let dbPath;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'mnemonad-search-idx-'));
	dbPath = join(dir, 'search_index.db');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeIndexer() {
	return new Indexer({
		embeddingProvider: new FakeEmbeddingProvider({ dim: 16 }),
		chunkingStrategy: new TextWindowChunkingStrategy({ size: 200, overlap: 20 }),
	});
}

describe('Indexer', () => {
	it('indexes every text file on a first run', async () => {
		const folder = makeInMemoryFolder({
			'animals.txt': 'The quick brown fox jumps over the lazy dog. Foxes are agile.',
			'finance.txt': 'The stock market experienced volatility amid inflation concerns.',
		});
		const result = await makeIndexer().index(folder, dbPath);
		expect(result).toEqual({ filesChanged: 2, filesSkipped: 0, filesRemoved: 0, chunksAdded: 2 });
	});

	it('skips a file whose content is unchanged on a second run', async () => {
		const folder = makeInMemoryFolder({ 'a.txt': 'unchanging content' });
		const indexer = makeIndexer();
		await indexer.index(folder, dbPath);
		const second = await indexer.index(folder, dbPath);
		expect(second).toEqual({ filesChanged: 0, filesSkipped: 1, filesRemoved: 0, chunksAdded: 0 });
	});

	it('reindexes only the file that actually changed', async () => {
		const indexer = makeIndexer();
		await indexer.index(makeInMemoryFolder({
			'a.txt': 'first version of a',
			'b.txt': 'stays the same forever',
		}), dbPath);

		const second = await indexer.index(makeInMemoryFolder({
			'a.txt': 'second, different version of a',
			'b.txt': 'stays the same forever',
		}), dbPath);
		expect(second.filesChanged).toBe(1);
		expect(second.filesSkipped).toBe(1);
	});

	it('removes a file that disappeared from the tree, and it no longer surfaces in search', async () => {
		const indexer = makeIndexer();
		await indexer.index(makeInMemoryFolder({
			'animals.txt': 'foxes and dogs are animals',
			'finance.txt': 'stocks and the economy and money',
		}), dbPath);

		const second = await indexer.index(makeInMemoryFolder({
			'animals.txt': 'foxes and dogs are animals',
		}), dbPath);
		expect(second.filesRemoved).toBe(1);

		const hits = await new Searcher({ embeddingProvider: new FakeEmbeddingProvider({ dim: 16 }) })
			.search(dbPath, 'money and the economy', 5);
		expect(hits.map((h) => h.path)).not.toContain('finance.txt');
	});

	it('skips binary-looking content entirely', async () => {
		const folder = makeInMemoryFolder({
			'binary.dat': new Uint8Array([0, 1, 2, 3, 0, 255, 254]),
			'text.txt': 'this one is plain text',
		});
		const result = await makeIndexer().index(folder, dbPath);
		expect(result.filesChanged).toBe(1); // only text.txt
	});

	it('ranks a more topically-similar chunk above an unrelated one', async () => {
		const indexer = makeIndexer();
		await indexer.index(makeInMemoryFolder({
			'animals.txt': 'foxes dogs cats animals pets',
			'finance.txt': 'stocks money economy inflation banks',
		}), dbPath);

		const hits = await new Searcher({ embeddingProvider: new FakeEmbeddingProvider({ dim: 16 }) })
			.search(dbPath, 'pets and animals', 5);
		expect(hits[0].path).toBe('animals.txt');
	});

	it('records model/dimension metadata for a later Searcher to read back', async () => {
		await makeIndexer().index(makeInMemoryFolder({ 'a.txt': 'some content here' }), dbPath);
		// Reopen fresh, as a real second process would.
		const index = new VectorIndex(dbPath);
		expect(index.getMeta('model')).toBe('fake-test-embedder');
		expect(index.getMeta('dimension')).toBe('16');
		index.close();
	});
});

describe('Indexer.status', () => {
	it('is null when the folder has no index yet — and creates no file', async () => {
		const { existsSync } = await import('node:fs');
		expect(await makeIndexer().status(makeInMemoryFolder({ 'a.txt': 'text' }), dbPath)).toBe(null);
		expect(existsSync(dbPath)).toBe(false);
	});

	it('reports nothing for an index that matches the folder', async () => {
		const files = { 'a.txt': 'alpha content', 'b.txt': 'beta content' };
		await makeIndexer().index(makeInMemoryFolder(files), dbPath);
		expect(await makeIndexer().status(makeInMemoryFolder(files), dbPath))
			.toEqual({ changed: [], added: [], removed: [] });
	});

	it('reports changed, added and removed files separately', async () => {
		await makeIndexer().index(makeInMemoryFolder({ 'a.txt': 'alpha', 'b.txt': 'beta', 'c.txt': 'gamma' }), dbPath);
		const status = await makeIndexer().status(makeInMemoryFolder({
			'a.txt': 'alpha, edited',
			'b.txt': 'beta',
			'd.txt': 'delta is new',
		}), dbPath);
		expect(status).toEqual({ changed: ['a.txt'], added: ['d.txt'], removed: ['c.txt'] });
	});

	it('agrees with index() on files it never records (binary, empty)', async () => {
		const files = {
			'text.txt': 'plain text',
			'binary.dat': new Uint8Array([0, 1, 2, 0]),
			'empty.txt': '',
		};
		await makeIndexer().index(makeInMemoryFolder(files), dbPath);
		expect(await makeIndexer().status(makeInMemoryFolder(files), dbPath))
			.toEqual({ changed: [], added: [], removed: [] });
	});

	it('never writes to the index it inspects', async () => {
		const { readFile } = await import('node:fs/promises');
		await makeIndexer().index(makeInMemoryFolder({ 'a.txt': 'alpha' }), dbPath);
		const before = await readFile(dbPath);
		await makeIndexer().status(makeInMemoryFolder({ 'a.txt': 'alpha, edited', 'b.txt': 'new' }), dbPath);
		expect(Buffer.compare(before, await readFile(dbPath))).toBe(0);
	});
});

describe('Indexer — emptied files', () => {
	it('drops a file emptied since the last run, so its old text stops matching', async () => {
		await makeIndexer().index(makeInMemoryFolder({ 'a.txt': 'foxes and dogs', 'b.txt': 'banks and money' }), dbPath);
		const result = await makeIndexer().index(makeInMemoryFolder({ 'a.txt': '', 'b.txt': 'banks and money' }), dbPath);
		expect(result.filesRemoved).toBe(1);

		const hits = await new Searcher({ embeddingProvider: new FakeEmbeddingProvider({ dim: 16 }) })
			.search(dbPath, 'foxes and dogs', 5);
		expect(hits.map((h) => h.path)).toEqual(['b.txt']);
	});
});

describe('Indexer — one model per index', () => {
	/** The fake embedder, under a different model name (and dimension). */
	class OtherFakeProvider extends FakeEmbeddingProvider {
		get modelId() { return 'another-fake-embedder'; }
	}

	it('refuses to add another model\'s vectors to an existing index', async () => {
		await makeIndexer().index(makeInMemoryFolder({ 'a.txt': 'alpha' }), dbPath);
		const other = new Indexer({ embeddingProvider: new OtherFakeProvider({ dim: 8 }) });
		const err = await other.index(makeInMemoryFolder({ 'a.txt': 'alpha', 'b.txt': 'new' }), dbPath).catch((e) => e);
		expect(err).toBeInstanceOf(ModelMismatchError);
		expect(err).toMatchObject({ indexModel: 'fake-test-embedder', providerModel: 'another-fake-embedder' });
	});

	it('switches models with rebuild, re-embedding every file', async () => {
		await makeIndexer().index(makeInMemoryFolder({ 'a.txt': 'alpha', 'b.txt': 'beta' }), dbPath);
		const other = new Indexer({ embeddingProvider: new OtherFakeProvider({ dim: 8 }) });
		const result = await other.index(makeInMemoryFolder({ 'a.txt': 'alpha', 'b.txt': 'beta' }), dbPath, { rebuild: true });
		expect(result).toMatchObject({ filesChanged: 2, filesSkipped: 0 });

		const index = new VectorIndex(dbPath, { readonly: true });
		expect(index.getMeta('model')).toBe('another-fake-embedder');
		expect(index.getMeta('dimension')).toBe('8');
		index.close();
	});

	it('records which kind of embedder built the index', async () => {
		class StaticFake extends FakeEmbeddingProvider {
			get embedder() { return 'model2vec'; }
		}
		await new Indexer({ embeddingProvider: new StaticFake({ dim: 16 }) }).index(makeInMemoryFolder({ 'a.txt': 'alpha' }), dbPath);
		expect(VectorIndex.readMeta(dbPath)).toMatchObject({ model: 'fake-test-embedder', embedder: 'model2vec' });
	});
});
