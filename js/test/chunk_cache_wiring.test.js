import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadChunkCache from '../MnemonadChunkCache.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * Verifies the cache is actually consulted end to end — not just that the cache class works
 * in isolation (see chunk_cache.test.js), but that a real stream's reads genuinely skip the
 * network on a hit. Each test uses its own `cacheOptions.namespace` so caches never leak
 * between tests despite the shared-by-options instance (`_getSharedChunkCache`).
 */

let node;
let clients;
let contractAddress;

const MAX_CHUNK = 2_000;
let namespaceCounter = 0;
const freshNamespace = () => `wiring-test-${++namespaceCounter}`;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
}, 120_000);

afterAll(async () => {
	await node?.stop();
});

function baseParams(extra = {}) {
	return { publicClient: clients.publicClient, walletClient: clients.walletClient, contractAddress, ...extra };
}

async function countReadContractCalls(fn) {
	let calls = 0;
	const original = clients.publicClient.readContract.bind(clients.publicClient);
	clients.publicClient.readContract = async (args) => {
		calls++;
		return original(args);
	};
	try {
		await fn();
	} finally {
		clients.publicClient.readContract = original;
	}
	return calls;
}

describe('on-chain items', () => {
	it('a second .bytes() call for the same item makes no new RPC call', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions }));
		await ev.push(makeBytes(500, 1));

		const item = await ev.itemAt(0);
		const first = await item.bytes(); // populates MnemonadItem's own in-memory _bytes...

		// A fresh instance, so this exercises the durable cache rather than MnemonadItem's
		// own per-call _bytes memoization (which would trivially skip a repeat call anyway).
		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id });
		const freshItem = await fresh.itemAt(0);

		const calls = await countReadContractCalls(async () => {
			const second = await freshItem.bytes();
			expect(second).toEqual(first);
		});
		expect(calls).toBe(0);
	});

	it('two different indices do not collide in the cache', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions }));
		await ev.push(makeBytes(30, 1));
		await ev.push(makeBytes(30, 2));

		const a = await (await ev.itemAt(0)).bytes();
		const b = await (await ev.itemAt(1)).bytes();
		expect(a).not.toEqual(b);

		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id });
		expect(await (await fresh.itemAt(0)).bytes()).toEqual(a);
		expect(await (await fresh.itemAt(1)).bytes()).toEqual(b);
	});

	it('two different streams on the same registry do not collide', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const evA = await Mnemonad.create(baseParams({ cacheOptions }));
		await evA.push(makeBytes(30, 5));
		const evB = await Mnemonad.create(baseParams({ cacheOptions, salt: `0x${'22'.repeat(32)}` }));
		await evB.push(makeBytes(30, 6));

		const a = await (await evA.itemAt(0)).bytes();
		const b = await (await evB.itemAt(0)).bytes();
		expect(a).not.toEqual(b);

		const freshA = new Mnemonad({ ...baseParams({ cacheOptions }), id: evA.id });
		expect(await (await freshA.itemAt(0)).bytes()).toEqual(a);
	});

	it('params.cache: false disables caching — every read hits the chain', async () => {
		const ev = await Mnemonad.create(baseParams({ cache: false }));
		await ev.push(makeBytes(30, 1));
		expect(ev._chunkCache).toBeNull();

		await (await ev.itemAt(0)).bytes();
		const fresh = new Mnemonad({ ...baseParams({ cache: false }), id: ev.id });
		const calls = await countReadContractCalls(async () => {
			await (await fresh.itemAt(0)).bytes();
		});
		expect(calls).toBeGreaterThan(0); // no cache to have served it from
	});

	it('a custom cache object is used verbatim, not the shared default', async () => {
		const seen = { get: [], set: [] };
		const customCache = {
			async get(key) {
				seen.get.push(key);
				return undefined;
			},
			async set(key, bytes) {
				seen.set.push(key);
			},
		};
		const ev = await Mnemonad.create(baseParams({ cache: customCache }));
		expect(ev._chunkCache).toBe(customCache);

		await ev.push(makeBytes(30, 1));
		await (await ev.itemAt(0)).bytes();

		// Two distinct cache entries for one item: refs (consulted by itemAt, via
		// getItemRefs) and payload bytes (consulted by .bytes(), via _readItemBytes) —
		// different keys, so a hit on one never masks a miss on the other.
		expect(seen.get).toHaveLength(2);
		expect(seen.set).toHaveLength(2);
		expect(new Set(seen.get)).toEqual(new Set(seen.set)); // same two keys, read and written
		expect(new Set(seen.get).size).toBe(2); // genuinely two distinct keys, not one repeated
	});
});

describe('item metadata (refs/pointer caching)', () => {
	it('a second itemAt() from a fresh instance makes zero RPC calls once refs are cached', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions }));
		await ev.push(makeBytes(500, 1));
		const first = await ev.itemAt(0); // populates the durable refs cache

		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id });
		await fresh.initialize(); // this call's own reads must not count below
		const calls = await countReadContractCalls(async () => {
			const second = await fresh.itemAt(0);
			expect(second.storeName).toBe(first.storeName);
			expect(second.size).toBe(first.size);
		});
		expect(calls).toBe(0);
	});

	it('getItemRefsBatch only fetches indices missing from the cache', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions }));
		for (let i = 0; i < 4; i++) await ev.push(makeBytes(20 + i, i));

		// Pre-warm 1 and 3 only, from a fresh instance so it's genuinely the durable cache.
		const warm = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id });
		await warm.getItemRefs(1);
		await warm.getItemRefs(3);

		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id });
		let seenIndices = null;
		const original = clients.publicClient.readContract.bind(clients.publicClient);
		clients.publicClient.readContract = async (args) => {
			if (args.functionName === 'getItemRefsBatch') seenIndices = args.args[1];
			return original(args);
		};
		let results;
		try {
			results = await fresh.getItemRefsBatch([0, 1, 2, 3]);
		} finally {
			clients.publicClient.readContract = original;
		}

		expect(seenIndices).toEqual([0n, 2n]); // only the two NOT pre-warmed
		expect(results.map((r) => r.size)).toEqual([20, 21, 22, 23]); // all four still correct
	});

	it('getItemRefsBatch makes zero RPC calls when every index is already cached', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions }));
		for (let i = 0; i < 3; i++) await ev.push(makeBytes(20 + i, i));
		await ev.getItemRefsBatch([0, 1, 2]); // populates the cache for all three

		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id });
		await fresh.initialize();
		const calls = await countReadContractCalls(async () => {
			const results = await fresh.getItemRefsBatch([0, 1, 2]);
			expect(results.map((r) => r.size)).toEqual([20, 21, 22]);
		});
		expect(calls).toBe(0);
	});

	it('pointerAt is cached too, so a fully-cached EXTERNAL itemAt costs zero RPC calls', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient, cacheOptions }));
		await ev.push(makeBytes(MAX_CHUNK * 2, 4));

		// Populate refs, pointer, AND payload caches.
		const item = await ev.itemAt(0);
		await item.bytes();

		const fresh = new Mnemonad({
			publicClient: clients.publicClient,
			contractAddress,
			id: ev.id,
			ipfsClient,
			cacheOptions,
		});
		await fresh.initialize();
		const calls = await countReadContractCalls(async () => {
			const freshItem = await fresh.itemAt(0); // refs + pointer, both cached
			const bytes = await freshItem.bytes(); // payload, also cached
			expect(bytes).toEqual(await item.bytes());
		});
		expect(calls).toBe(0);
		expect(ipfsClient.stats.wholeReads).toBe(1); // only from the original populate above
	});
});

describe('off-chain (IPFS) items', () => {
	it('a second read of the same external item does not hit the transport again', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient, cacheOptions }));
		await ev.push(makeBytes(MAX_CHUNK * 2, 9));

		const first = await (await ev.itemAt(0)).bytes();
		expect(ipfsClient.stats.wholeReads).toBe(1);

		const fresh = new Mnemonad({
			publicClient: clients.publicClient,
			contractAddress,
			id: ev.id,
			ipfsClient,
			cacheOptions,
		});
		const second = await (await fresh.itemAt(0)).bytes();
		expect(second).toEqual(first);
		expect(ipfsClient.stats.wholeReads).toBe(1); // unchanged — served from cache
	});

	it('verifyAvailability({ verify: true }) always re-fetches, ignoring the cache', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient, cacheOptions }));
		await ev.push(makeBytes(MAX_CHUNK * 2, 11));

		// Populate the cache first.
		await (await ev.itemAt(0)).bytes();
		expect(ipfsClient.stats.wholeReads).toBe(1);

		// A cache hit would report "available" regardless of what verifyAvailability is
		// actually trying to determine — it must bypass the cache to mean anything.
		await ev.offloadingProvider.verifyAvailability({ verify: true });
		expect(ipfsClient.stats.wholeReads).toBe(2);

		// And it correctly reports unavailable once the remote copy is actually gone, even
		// though the cache still has it.
		ipfsClient.store.clear();
		const report = await ev.offloadingProvider.verifyAvailability({ verify: true });
		expect(report[0].available).toBe(false);
	});

	it('a tampered cache entry is still caught by hash verification', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient, cacheOptions }));
		await ev.push(makeBytes(MAX_CHUNK * 2, 13));
		await (await ev.itemAt(0)).bytes(); // populate the cache

		const pointer = await ev.pointerAt(0);
		const key = `ipfs:${pointer.hash}`;
		await ev._chunkCache.set(key, makeBytes(MAX_CHUNK * 2, 99)); // corrupt the cached copy

		const fresh = new Mnemonad({
			publicClient: clients.publicClient,
			contractAddress,
			id: ev.id,
			ipfsClient,
			cacheOptions,
		});
		await expect((await fresh.itemAt(0)).bytes()).rejects.toThrow(/hash mismatch/);
	});
});

describe('the shared instance', () => {
	it('two Mnemonads with identical cacheOptions share one cache instance', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const a = await Mnemonad.create(baseParams({ cacheOptions }));
		const b = new Mnemonad({ ...baseParams({ cacheOptions }), id: a.id });
		expect(a._chunkCache).toBeInstanceOf(MnemonadChunkCache);
		expect(a._chunkCache).toBe(b._chunkCache);
	});

	it('different namespaces get different cache instances', async () => {
		const a = await Mnemonad.create(baseParams({ cacheOptions: { namespace: freshNamespace() } }));
		const b = new Mnemonad({ ...baseParams({ cacheOptions: { namespace: freshNamespace() } }), id: a.id });
		expect(a._chunkCache).not.toBe(b._chunkCache);
	});
});
