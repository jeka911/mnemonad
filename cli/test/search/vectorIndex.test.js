import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import VectorIndex from '../../lib/search/VectorIndex.js';

let dir;
let dbPath;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'mnemonad-search-vi-'));
	dbPath = join(dir, 'search_index.db');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function vec(dim, ...values) {
	const v = new Float32Array(dim);
	values.forEach((val, i) => { v[i] = val; });
	return v;
}

describe('VectorIndex', () => {
	it('creates its schema on first open and is reopenable', () => {
		const index = new VectorIndex(dbPath);
		index.close();
		const reopened = new VectorIndex(dbPath);
		expect(reopened.listFiles()).toEqual([]);
		reopened.close();
	});

	it('getFileHash is null for a file never indexed', () => {
		const index = new VectorIndex(dbPath);
		expect(index.getFileHash('a.txt')).toBe(null);
		index.close();
	});

	it('replaceFileChunks records the file and its chunks, findable by search', () => {
		const index = new VectorIndex(dbPath);
		index.initVectorColumn(4);
		index.replaceFileChunks('a.txt', 'hash1', [
			{ startOffset: 0, endOffset: 10, embedding: vec(4, 1, 0, 0, 0) },
		]);
		expect(index.getFileHash('a.txt')).toBe('hash1');
		expect(index.listFiles()).toEqual(['a.txt']);

		const hits = index.search(vec(4, 1, 0, 0, 0), 5);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ path: 'a.txt', chunkIndex: 0, startOffset: 0, endOffset: 10 });
		expect(hits[0].distance).toBeCloseTo(0, 5);
		index.close();
	});

	it('a stale reindex of the same file is excluded from search, even though its rows are never deleted', () => {
		const index = new VectorIndex(dbPath);
		index.initVectorColumn(4);
		index.replaceFileChunks('a.txt', 'hash1', [
			{ startOffset: 0, endOffset: 10, embedding: vec(4, 1, 0, 0, 0) },
		]);
		index.replaceFileChunks('a.txt', 'hash2', [
			{ startOffset: 0, endOffset: 12, embedding: vec(4, 0, 1, 0, 0) },
		]);

		// The old row (content_hash='hash1') is still physically there...
		const rawCount = index._db.prepare('SELECT COUNT(*) c FROM search_index WHERE path = ?').get('a.txt').c;
		expect(rawCount).toBe(2);

		// ...but only the current one is ever returned by search.
		const hits = index.search(vec(4, 1, 0, 0, 0), 5);
		expect(hits).toHaveLength(1);
		expect(hits[0].startOffset).toBe(0);
		expect(hits[0].endOffset).toBe(12); // the NEW chunk's offsets, not the old one's
		index.close();
	});

	it('removeFile excludes a deleted file from search without touching search_index rows', () => {
		const index = new VectorIndex(dbPath);
		index.initVectorColumn(4);
		index.replaceFileChunks('a.txt', 'hash1', [{ startOffset: 0, endOffset: 10, embedding: vec(4, 1, 0, 0, 0) }]);
		index.replaceFileChunks('b.txt', 'hash2', [{ startOffset: 0, endOffset: 10, embedding: vec(4, 0, 1, 0, 0) }]);

		index.removeFile('a.txt');
		expect(index.listFiles()).toEqual(['b.txt']);

		const rawCount = index._db.prepare('SELECT COUNT(*) c FROM search_index').get().c;
		expect(rawCount).toBe(2); // both chunks still physically present

		const hits = index.search(vec(4, 1, 0, 0, 0), 5);
		expect(hits.map((h) => h.path)).toEqual(['b.txt']); // a.txt's chunk never surfaces
		index.close();
	});

	it('meta round-trips', () => {
		const index = new VectorIndex(dbPath);
		expect(index.getMeta('model')).toBe(null);
		index.setMeta('model', 'test-model');
		expect(index.getMeta('model')).toBe('test-model');
		index.setMeta('model', 'updated-model');
		expect(index.getMeta('model')).toBe('updated-model');
		index.close();
	});

	it('compact physically removes stale/orphaned rows', () => {
		const index = new VectorIndex(dbPath);
		index.initVectorColumn(4);
		index.replaceFileChunks('a.txt', 'hash1', [{ startOffset: 0, endOffset: 10, embedding: vec(4, 1, 0, 0, 0) }]);
		index.replaceFileChunks('a.txt', 'hash2', [{ startOffset: 0, endOffset: 12, embedding: vec(4, 0, 1, 0, 0) }]);
		index.replaceFileChunks('b.txt', 'hash3', [{ startOffset: 0, endOffset: 10, embedding: vec(4, 0, 0, 1, 0) }]);
		index.removeFile('b.txt');

		expect(index._db.prepare('SELECT COUNT(*) c FROM search_index').get().c).toBe(3);
		index.compact();
		expect(index._db.prepare('SELECT COUNT(*) c FROM search_index').get().c).toBe(1); // only a.txt's current chunk survives

		const hits = index.search(vec(4, 0, 1, 0, 0), 5);
		expect(hits).toHaveLength(1);
		expect(hits[0].path).toBe('a.txt');
		index.close();
	});
});
