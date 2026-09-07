import { describe, it, expect } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import MnemonadChunkCache, { DEFAULT_CHUNK_CACHE_OPTIONS } from '../MnemonadChunkCache.js';

/**
 * Pure unit tests for the cache itself — no chain, no node. Run against both backends via
 * `withBothBackends`, since the eviction/key logic lives in the outer class and must behave
 * identically regardless of which one is underneath.
 */

let namespaceCounter = 0;
/** A fresh namespace per test, so fake-indexeddb databases from different tests never share
 *  state (IndexedDB persists for the life of the fake factory, not just one test). */
function freshOptions(overrides = {}) {
	return { namespace: `test-${++namespaceCounter}`, ...overrides };
}

/** Runs `fn(makeCache)` once per backend, so both get identical coverage. */
function withBothBackends(name, fn) {
	describe(`${name} (memory backend)`, () => {
		fn((overrides) => new MnemonadChunkCache({ ...freshOptions(overrides), indexedDB: null, backend: undefined }));
	});
	describe(`${name} (indexeddb backend, via fake-indexeddb)`, () => {
		fn((overrides) => new MnemonadChunkCache({ ...freshOptions(overrides), indexedDB }));
	});
}

function bytes(n, fill = 1) {
	return new Uint8Array(n).fill(fill);
}

withBothBackends('get/set', (makeCache) => {
	it('returns undefined on a miss', async () => {
		const cache = makeCache();
		expect(await cache.get('nope')).toBeUndefined();
	});

	it('returns exactly what was set', async () => {
		const cache = makeCache();
		const data = bytes(10, 7);
		await cache.set('k', data);
		expect(await cache.get('k')).toEqual(data);
	});

	it('overwrites an existing key rather than duplicating it', async () => {
		const cache = makeCache();
		await cache.set('k', bytes(10, 1));
		await cache.set('k', bytes(20, 2));
		expect(await cache.get('k')).toEqual(bytes(20, 2));
		expect((await cache.stats()).entryCount).toBe(1);
	});
});

withBothBackends('maxEntryBytes', (makeCache) => {
	it('skips caching an entry larger than maxEntryBytes entirely', async () => {
		const cache = makeCache({ maxEntryBytes: 100 });
		await cache.set('big', bytes(101));
		expect(await cache.get('big')).toBeUndefined();
		expect((await cache.stats()).entryCount).toBe(0);
	});

	it('does not evict anything else when skipping an oversized entry', async () => {
		const cache = makeCache({ maxEntryBytes: 100, maxEntries: 10 });
		await cache.set('small', bytes(10));
		await cache.set('big', bytes(101));
		expect(await cache.get('small')).toEqual(bytes(10));
		expect((await cache.stats()).entryCount).toBe(1);
	});
});

withBothBackends('maxEntries eviction', (makeCache) => {
	it('evicts the least-recently-used entry once over the count cap', async () => {
		const cache = makeCache({ maxEntries: 2, maxTotalBytes: 10_000 });
		await cache.set('a', bytes(1, 1));
		await cache.set('b', bytes(1, 2));
		await cache.set('c', bytes(1, 3)); // pushes past maxEntries: 2

		const stats = await cache.stats();
		expect(stats.entryCount).toBe(2);
		expect(await cache.get('a')).toBeUndefined(); // oldest, evicted
		expect(await cache.get('b')).toEqual(bytes(1, 2));
		expect(await cache.get('c')).toEqual(bytes(1, 3));
	});

	it('a get() bump saves an entry from being the next eviction', async () => {
		const cache = makeCache({ maxEntries: 2, maxTotalBytes: 10_000 });
		await cache.set('a', bytes(1, 1));
		await cache.set('b', bytes(1, 2));
		await cache.get('a'); // touch a — b is now the least-recently-used
		await cache.set('c', bytes(1, 3));

		expect(await cache.get('b')).toBeUndefined(); // evicted instead of a
		expect(await cache.get('a')).toEqual(bytes(1, 1));
		expect(await cache.get('c')).toEqual(bytes(1, 3));
	});
});

withBothBackends('maxTotalBytes eviction', (makeCache) => {
	it('evicts oldest entries until back under the byte budget', async () => {
		const cache = makeCache({ maxEntries: 100, maxTotalBytes: 25 });
		await cache.set('a', bytes(10, 1));
		await cache.set('b', bytes(10, 2));
		await cache.set('c', bytes(10, 3)); // 30 total > 25 — must evict at least one

		const stats = await cache.stats();
		expect(stats.totalBytes).toBeLessThanOrEqual(25);
		expect(await cache.get('a')).toBeUndefined(); // oldest goes first
		expect(await cache.get('c')).toEqual(bytes(10, 3));
	});
});

withBothBackends('clear', (makeCache) => {
	it('removes every entry', async () => {
		const cache = makeCache();
		await cache.set('a', bytes(1));
		await cache.set('b', bytes(1));
		await cache.clear();
		expect(await cache.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
	});
});

describe('defaults', () => {
	it('match the documented values', () => {
		expect(DEFAULT_CHUNK_CACHE_OPTIONS).toEqual({
			maxEntries: 300,
			maxTotalBytes: 50 * 1024 * 1024,
			maxEntryBytes: 8 * 1024 * 1024,
			namespace: 'default',
		});
	});

	it('a fresh cache with no overrides uses them', async () => {
		const cache = new MnemonadChunkCache(freshOptions());
		expect(cache.maxEntries).toBe(DEFAULT_CHUNK_CACHE_OPTIONS.maxEntries);
		expect(cache.maxTotalBytes).toBe(DEFAULT_CHUNK_CACHE_OPTIONS.maxTotalBytes);
		expect(cache.maxEntryBytes).toBe(DEFAULT_CHUNK_CACHE_OPTIONS.maxEntryBytes);
	});
});

describe('failure isolation', () => {
	it('set() never throws, even when the backend itself does', async () => {
		const cache = new MnemonadChunkCache({
			...freshOptions(),
			backend: {
				getEntry: async () => undefined,
				putEntry: async () => {
					throw new Error('backend exploded');
				},
				deleteEntry: async () => {},
				touchEntry: async () => {},
				listEntriesByAccess: async () => [],
				clear: async () => {},
			},
		});
		await expect(cache.set('k', bytes(1))).resolves.toBeUndefined();
	});

	it('get() resolves to undefined, never throws, when the backend itself does', async () => {
		const cache = new MnemonadChunkCache({
			...freshOptions(),
			backend: {
				getEntry: async () => {
					throw new Error('backend exploded');
				},
				putEntry: async () => {},
				deleteEntry: async () => {},
				touchEntry: async () => {},
				listEntriesByAccess: async () => [],
				clear: async () => {},
			},
		});
		await expect(cache.get('k')).resolves.toBeUndefined();
	});
});
