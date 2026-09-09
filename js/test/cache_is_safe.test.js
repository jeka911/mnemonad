import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * The one invariant that matters most about the chunk cache: it must never hold decrypted
 * plaintext for an encrypted stream — only ciphertext, exactly as fetched from chain or
 * IPFS before `Mnemonad.at()` decrypts it one layer above (see `docs/caching.md`'s own
 * design rule). Every other cache test either proves the cache is *consulted* (a hit skips
 * the network — `chunk_cache_wiring.test.js`) or that the *cache class* itself works in
 * isolation (`chunk_cache.test.js`). This file proves neither of those on their own would
 * catch a plaintext leak: it reaches directly into the cache backend after real reads and
 * scans every entry, byte-for-byte, against every plaintext that went in.
 */

let node;
let clients;
let contractAddress;

const MAX_CHUNK = 2_000;
let namespaceCounter = 0;
const freshNamespace = () => `cache-is-safe-${++namespaceCounter}`;

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

function createEncrypted(extra = {}) {
	return Mnemonad.create(baseParams({ encrypt: true, signer: clients.walletClient, ...extra }));
}

/** Ciphertext size for a plaintext of `n` bytes under the framed format. */
function cipherLen(n) {
	return MnemonadCrypto.ciphertextLengthFor(n);
}

/**
 * Every entry currently sitting in a stream's chunk cache, reaching past
 * `MnemonadChunkCache`'s public `get`/`set`/`stats` (none of which can list contents) into
 * the backend it wraps. Deliberate, narrow internals access for this one audit — the same
 * kind `chunk_cache_wiring.test.js`'s tamper test already reaches for via `_chunkCache.set`.
 *
 * `listEntriesByAccess()` deliberately omits `bytes` (it exists for cheap LRU-order eviction
 * scans, not for reading payloads back out) — so this re-fetches each key's full entry via
 * `getEntry`, which does include it.
 * @param {Mnemonad} ev
 * @returns {Promise<{key: string, bytes: Uint8Array}[]>}
 */
async function allCacheEntries(ev) {
	const backend = ev._chunkCache._backend;
	const summaries = await backend.listEntriesByAccess();
	return await Promise.all(
		summaries.map(async ({ key }) => {
			const entry = await backend.getEntry(key);
			return { key, bytes: entry.bytes };
		})
	);
}

/**
 * @param {{key: string, bytes: Uint8Array}[]} entries
 * @param {Uint8Array[]} plaintexts
 * @returns {?{key: string, plaintextIndex: number}} the first match found, or null
 */
function findPlaintextLeak(entries, plaintexts) {
	for (const entry of entries) {
		for (let i = 0; i < plaintexts.length; i += 1) {
			if (Buffer.from(entry.bytes).equals(Buffer.from(plaintexts[i]))) {
				return { key: entry.key, plaintextIndex: i };
			}
		}
	}
	return null;
}

describe('on-chain items (SLOT and CODE)', () => {
	it('the cached entry for a SLOT-tier item is ciphertext, never the plaintext', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await createEncrypted({ cacheOptions });
		const plaintext = makeBytes(5, 1); // 5 + 26 framing = 31 bytes -> still SLOT
		await ev.push(plaintext);

		expect((await ev.itemAt(0)).storeName).toBe('slot');
		await ev.at(0); // populates the on-chain payload cache with ciphertext

		const entries = await allCacheEntries(ev);
		const onchain = entries.find((e) => e.key.startsWith('onchain:'));
		expect(onchain).toBeTruthy();
		expect(onchain.bytes.length).toBe(cipherLen(plaintext.length));
		expect(Buffer.from(onchain.bytes)).not.toEqual(Buffer.from(plaintext));
		// Not just "different bytes" — genuinely valid ciphertext for THIS item.
		expect(new Uint8Array(await ev.crypto.decryptItem(onchain.bytes))).toEqual(plaintext);
	});

	it('the cached entry for a CODE-tier item is ciphertext, never the plaintext', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await createEncrypted({ cacheOptions });
		const plaintext = makeBytes(300, 2);
		await ev.push(plaintext);

		expect((await ev.itemAt(0)).storeName).toBe('code');
		await ev.at(0);

		const entries = await allCacheEntries(ev);
		const onchain = entries.find((e) => e.key.startsWith('onchain:'));
		expect(onchain).toBeTruthy();
		expect(onchain.bytes.length).toBe(cipherLen(plaintext.length));
		expect(Buffer.from(onchain.bytes)).not.toEqual(Buffer.from(plaintext));
		expect(new Uint8Array(await ev.crypto.decryptItem(onchain.bytes))).toEqual(plaintext);
	});

	it('reading via the non-decrypting itemAt().bytes() path caches the same ciphertext', async () => {
		// The path that never decrypts (see Mnemonad.js's own comment on _readItemBytes)
		// caches too — worth its own check, since it's a different call site from at().
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await createEncrypted({ cacheOptions });
		const plaintext = makeBytes(120, 3);
		await ev.push(plaintext);

		const raw = await (await ev.itemAt(0)).bytes();
		expect(Buffer.from(raw)).not.toEqual(Buffer.from(plaintext));

		const entries = await allCacheEntries(ev);
		const onchain = entries.find((e) => e.key.startsWith('onchain:'));
		expect(Buffer.from(onchain.bytes)).toEqual(Buffer.from(raw)); // same ciphertext, one cache entry
		expect(Buffer.from(onchain.bytes)).not.toEqual(Buffer.from(plaintext));
	});

	it('a batch packed by pushMany is still all-ciphertext in the cache, per item', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await createEncrypted({ cacheOptions });
		const plaintexts = [makeBytes(80, 4), makeBytes(90, 5), makeBytes(70, 6)];
		await ev.pushMany(plaintexts);

		for (let i = 0; i < plaintexts.length; i += 1) await ev.at(i);

		const entries = await allCacheEntries(ev);
		const onchainEntries = entries.filter((e) => e.key.startsWith('onchain:'));
		expect(onchainEntries.length).toBe(plaintexts.length);
		const leak = findPlaintextLeak(onchainEntries, plaintexts);
		expect(leak).toBeNull();
	});
});

describe('off-chain (IPFS) items', () => {
	it('the cached entry for an EXTERNAL item is ciphertext, never the plaintext', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ cacheOptions, ipfsClient });
		const plaintext = makeBytes(MAX_CHUNK * 2, 7);
		await ev.pushExternal(plaintext);

		await ev.at(0); // populates the ipfs: cache entry via readPointerBytes

		const entries = await allCacheEntries(ev);
		const ipfsEntry = entries.find((e) => e.key.startsWith('ipfs:'));
		expect(ipfsEntry).toBeTruthy();
		expect(ipfsEntry.bytes.length).toBe(cipherLen(plaintext.length));
		expect(Buffer.from(ipfsEntry.bytes)).not.toEqual(Buffer.from(plaintext));
		expect(new Uint8Array(await ev.crypto.decryptItem(ipfsEntry.bytes))).toEqual(plaintext);
	});
});

describe('a full sweep across every tier at once', () => {
	it('scans every entry in the cache and finds no plaintext anywhere, for any item', async () => {
		const cacheOptions = { namespace: freshNamespace() };
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ cacheOptions, ipfsClient });

		const plaintexts = [
			makeBytes(5, 10), // SLOT
			makeBytes(300, 11), // CODE
			makeBytes(MAX_CHUNK * 2, 12), // EXTERNAL
		];
		await ev.push(plaintexts[0]);
		await ev.push(plaintexts[1]);
		await ev.pushExternal(plaintexts[2]);

		// Read every item back through both call sites that populate the cache, so a leak
		// specific to either one would still be caught.
		for (let i = 0; i < plaintexts.length; i += 1) {
			await ev.at(i);
			await (await ev.itemAt(i)).bytes();
		}

		const entries = await allCacheEntries(ev);
		// Sanity: there really is something to scan — refs (x3), payload/pointer entries.
		expect(entries.length).toBeGreaterThan(0);

		const leak = findPlaintextLeak(entries, plaintexts);
		expect(leak).toBeNull();
	});

	it('control: the same scan DOES find plaintext on an unencrypted stream', async () => {
		// Proves the scan technique itself is sound — it isn't vacuously passing above
		// because it could never match anything. On a plain stream, caching plaintext is
		// completely correct (there's no ciphertext at all), so this is expected to find a
		// match, not a bug.
		const cacheOptions = { namespace: freshNamespace() };
		const ev = await Mnemonad.create(baseParams({ cacheOptions }));
		const plaintext = makeBytes(200, 13);
		await ev.push(plaintext);
		await (await ev.itemAt(0)).bytes();

		const entries = await allCacheEntries(ev);
		const leak = findPlaintextLeak(entries, [plaintext]);
		expect(leak).not.toBeNull();
		expect(Buffer.from(
			entries.find((e) => e.key === leak.key).bytes
		)).toEqual(Buffer.from(plaintext));
	});
});
