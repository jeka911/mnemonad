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
		// getItemRefs) and payload bytes (consulted by .bytes() — which delegates to
		// at()/_atRaw, reusing the refs itemAt() already fetched rather than asking again,
		// then reaching _readItemBytes for the payload itself) — different keys, so a hit
		// on one never masks a miss on the other, and the refs lookup itself only ever
		// happens once per item regardless of how many times .bytes() is called.
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

describe('encrypted items via at()', () => {
	/**
	 * `at()` is the only method that actually decrypts (see Mnemonad.js's own comment on
	 * `_readItemBytes`) — `itemAt().bytes()` never does. Before this, `at()`'s encrypted
	 * branch read on-chain ciphertext through `stream()`'s frame-by-frame walk, which never
	 * touched `_chunkCache` at all — every call re-fetched from chain, cache or no cache.
	 * These prove that gap is closed for on-chain items specifically (EXTERNAL items always
	 * had the equivalent benefit already, via `readPointerBytes`'s own cache — see below).
	 */
	it('a second at() call for the same on-chain encrypted item makes no new RPC call', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions, encrypt: true, signer: clients.walletClient }));
		await ev.push(makeBytes(500, 1));

		const first = await ev.at(0); // populates the durable on-chain cache with ciphertext

		// A fresh instance, so this exercises the durable cache rather than any
		// per-instance memoization (_layouts, _externalCache) that would trivially skip a
		// repeat call on the SAME instance regardless of whether this fix existed.
		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id, signer: clients.walletClient });
		await fresh.initialize(); // this call's own reads must not count below
		const calls = await countReadContractCalls(async () => {
			const second = await fresh.at(0);
			expect(second).toEqual(first);
		});
		expect(calls).toBe(0);
	});

	it('shares the cache entry with itemAt().bytes() — both decrypt, from one cached ciphertext', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions, encrypt: true, signer: clients.walletClient }));
		const data = makeBytes(200, 2);
		await ev.push(data);

		// Populate the cache via itemAt().bytes() first — MnemonadItem.bytes() delegates
		// to at() (see MnemonadItem.js's own doc), so this decrypts correctly too, not
		// just at() itself.
		const viaItem = await (await ev.itemAt(0)).bytes();
		expect(new Uint8Array(viaItem)).toEqual(data);

		// at(), from a fresh instance, must be served from that SAME durable ciphertext
		// cache entry — zero RPC calls — and still decrypt correctly, proving the two
		// call sites really do share one entry rather than each keeping their own copy.
		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id, signer: clients.walletClient });
		await fresh.initialize(); // this call's own reads must not count below
		const calls = await countReadContractCalls(async () => {
			expect(await fresh.at(0)).toEqual(data);
		});
		expect(calls).toBe(0);
	});

	it('a warm refs cache means at() costs zero RPC calls even from a stream that never itemAt()-ed first', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions, encrypt: true, signer: clients.walletClient }));
		const data = makeBytes(300, 3);
		await ev.push(data);
		await ev.at(0); // warms both the refs cache (getItemRefs) and the payload cache

		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id, signer: clients.walletClient });
		await fresh.initialize(); // this call's own reads must not count below
		const calls = await countReadContractCalls(async () => {
			expect(await fresh.at(0)).toEqual(data);
		});
		// Confirms at() looks up store via the cached getItemRefs, not an uncached raw
		// itemStore read — otherwise this would show exactly 1 call, not 0.
		expect(calls).toBe(0);
	});

	it('a genuinely partial readRange() is still NOT cached — that scope boundary is unchanged', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions, encrypt: true, signer: clients.walletClient }));
		const data = makeBytes(500, 4);
		await ev.push(data);

		await ev.readRange(0, 0, 100); // a genuine sub-range, not the whole item

		const fresh = new Mnemonad({ ...baseParams({ cacheOptions }), id: ev.id, signer: clients.walletClient });
		const calls = await countReadContractCalls(async () => {
			await fresh.readRange(0, 0, 100);
		});
		// docs/caching.md documents ranged reads as out of scope for caching — this is the
		// "still true after this change" regression check, not a new guarantee.
		expect(calls).toBeGreaterThan(0);
	});

	it('an on-chain item bigger than readPageBytes is not routed through the single-shot cache', async () => {
		// A cheap stand-in for encrypted_huge.test.js's much slower (4 MB, ~175-tx) coverage
		// of the same routing decision — this only needs to prove at() picks the paged path
		// once ciphertext size crosses readPageBytes, not that paging itself works at scale.
		const cacheOptions = { namespace: freshNamespace() };
		const readPageBytes = 128; // smaller than this item's ciphertext, on purpose
		const ev = await Mnemonad.create(
			baseParams({ cacheOptions, encrypt: true, signer: clients.walletClient, readPageBytes })
		);
		const data = makeBytes(500, 5); // ciphertext > 128 bytes, well under maxChunkBytes
		await ev.push(data);
		expect(await ev.at(0)).toEqual(data);

		// If this had gone through the single-shot cached path, a second at() from a fresh
		// instance would cost zero RPC calls, same as the earlier tests in this describe
		// block. It must not: that path is reserved for items within readPageBytes.
		const fresh = new Mnemonad({ ...baseParams({ cacheOptions, readPageBytes }), id: ev.id, signer: clients.walletClient });
		await fresh.initialize();
		const calls = await countReadContractCalls(async () => {
			expect(await fresh.at(0)).toEqual(data);
		});
		expect(calls).toBeGreaterThan(0);
	});

	it('EXTERNAL encrypted items are unaffected — still decrypt correctly via at(), still IPFS-cached', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ cacheOptions, ipfsClient, encrypt: true, signer: clients.walletClient })
		);
		const data = makeBytes(MAX_CHUNK * 2, 5);
		await ev.pushExternal(data);

		const fresh = new Mnemonad({
			publicClient: clients.publicClient,
			contractAddress,
			id: ev.id,
			ipfsClient,
			cacheOptions,
			signer: clients.walletClient,
		});
		expect(await fresh.at(0)).toEqual(data);
		// Its own pre-existing cache path, unrelated to this change — proven not to have
		// regressed by the single whole-payload fetch this expects.
		expect(ipfsClient.stats.wholeReads).toBe(1);
	});

	/**
	 * The actual motivation for MnemonadItem.bytes() delegating to at() (see its own doc):
	 * before, isItemLoaded — driven entirely by MnemonadItem.isLoaded, i.e. whether
	 * .bytes() has ever been called on it — could only ever be true for an item read
	 * through itemAt().bytes(), which never decrypted. An encrypted item read through
	 * at() instead (the only path that actually decrypts) left the SDK's own tracking
	 * permanently false, forcing a caller to track "loaded" separately per encryption
	 * status. Proven here for both on-chain and external, since the delegation applies to
	 * both branches of MnemonadItem.bytes() identically.
	 */
	it('isItemLoaded reflects an encrypted on-chain item the same way as an unencrypted one', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions, encrypt: true, signer: clients.walletClient }));
		const data = makeBytes(200, 30);
		await ev.push(data);

		const item = await ev.itemAt(0);
		expect(item.isLoaded).toBe(false);
		expect(ev.isItemLoaded(0)).toBe(false);

		const decrypted = await item.bytes();
		expect(new Uint8Array(decrypted)).toEqual(data);
		expect(item.isLoaded).toBe(true);
		expect(ev.isItemLoaded(0)).toBe(true); // the SDK's own tracking — no caller-side workaround
	});

	it('isItemLoaded reflects an encrypted EXTERNAL item the same way too', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ cacheOptions, ipfsClient, encrypt: true, signer: clients.walletClient })
		);
		const data = makeBytes(MAX_CHUNK * 2, 31);
		await ev.pushExternal(data);

		const item = await ev.itemAt(0);
		expect(item.isLoaded).toBe(false);
		expect(ev.isItemLoaded(0)).toBe(false);

		const decrypted = await item.bytes();
		expect(new Uint8Array(decrypted)).toEqual(data);
		expect(item.isLoaded).toBe(true);
		expect(ev.isItemLoaded(0)).toBe(true);
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

describe('_readRangeRaw no longer re-fetches itemStore per frame', () => {
	/**
	 * `_readRangeRaw` used to call the raw, uncached `itemStore` contract function on
	 * every invocation — and `stream()` calls it once per frame for an encrypted item, so
	 * downloading one large external+encrypted item burned one `itemStore` RPC call per 64
	 * KiB frame (confirmed live: a ~100 KB item logged a couple dozen `itemStore` calls in
	 * the explorer's own RPC panel). An item's tier never changes once committed, so this
	 * now goes through the already-cached `getItemRefs` instead — proven here by counting
	 * the raw `itemStore` function specifically, not just any RPC call.
	 */
	it('a multi-frame external+encrypted item makes zero raw itemStore calls, and getItemRefs at most once', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ cacheOptions, ipfsClient, encrypt: true, signer: clients.walletClient })
		);
		const data = makeBytes(200_000, 20); // several 64 KiB frames' worth
		await ev.pushExternal(data);

		const fresh = new Mnemonad({
			publicClient: clients.publicClient,
			contractAddress,
			id: ev.id,
			ipfsClient,
			cacheOptions,
			signer: clients.walletClient,
		});

		let itemStoreCalls = 0;
		let getItemRefsCalls = 0;
		const original = clients.publicClient.readContract.bind(clients.publicClient);
		clients.publicClient.readContract = async (args) => {
			if (args.functionName === 'itemStore') itemStoreCalls++;
			if (args.functionName === 'getItemRefs') getItemRefsCalls++;
			return original(args);
		};
		let result;
		try {
			result = await fresh.at(0);
		} finally {
			clients.publicClient.readContract = original;
		}

		expect(result).toEqual(data);
		expect(itemStoreCalls).toBe(0);
		// The real regression this guards: refs threaded through explicitly (stream()'s own
		// single lookup, passed into every _readRangeRaw/_cipherLayout/_prefetchExternal
		// call for the whole generator) rather than each frame re-deriving it — even via
		// getItemRefs' own cache, whose write is fire-and-forget and can't be trusted to
		// have landed before the very next sequential call asks again (observed for real in
		// a browser's IndexedDB backend; this in-memory backend wouldn't reproduce that race
		// on its own, which is exactly why this asserts the call COUNT, not just correctness).
		expect(getItemRefsCalls).toBe(1);
	});

	it('a multi-page on-chain item (unencrypted) makes zero raw itemStore calls either', async () => {
		// _atRaw hits the same fixed function — worth covering the unencrypted path too,
		// since it's a different call site with the same fix applied.
		const cacheOptions = { namespace: freshNamespace() };
		const readPageBytes = 512; // force _atRaw's paged branch on a small item
		const ev = await Mnemonad.create(baseParams({ cacheOptions, readPageBytes }));
		const data = makeBytes(1500, 21);
		await ev.push(data);

		const fresh = new Mnemonad({ ...baseParams({ cacheOptions, readPageBytes }), id: ev.id });

		let itemStoreCalls = 0;
		const original = clients.publicClient.readContract.bind(clients.publicClient);
		clients.publicClient.readContract = async (args) => {
			if (args.functionName === 'itemStore') itemStoreCalls++;
			return original(args);
		};
		let result;
		try {
			result = await fresh.at(0);
		} finally {
			clients.publicClient.readContract = original;
		}

		expect(result).toEqual(data);
		expect(itemStoreCalls).toBe(0);
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
