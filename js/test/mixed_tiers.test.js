import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { Store } from '../MnemonadItem.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * Items of every storage tier coexisting in one stream.
 *
 * Three tiers: SLOT (one packed storage slot), CODE (bytes deployed as contract code,
 * possibly spanning chunks or packed alongside other items) and EXTERNAL (an off-chain
 * pointer).
 *
 * Worth its own file because almost every code path branches on tier — `at`, `readRange`,
 * `getItemRefs`, `concat`, `binaryLength` accounting — and a dispatch mistake would only
 * show up when tiers are interleaved, not when a stream holds one kind of item.
 */

let node;
let clients;
let contractAddress;

/** Small ceiling so the staged multi-chunk path is reachable with modest payloads. */
const MAX_CHUNK = 2_000;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
}, 180_000);

afterAll(async () => {
	await node?.stop();
});

function baseParams(extra = {}) {
	return {
		publicClient: clients.publicClient,
		walletClient: clients.walletClient,
		contractAddress,
		...extra,
	};
}

function expectSameBytes(actual, expected) {
	expect(actual.length).toBe(expected.length);
	expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

/** Payload sizes that land in each tier, given MAX_CHUNK and the routing rules. */
const SLOT_SIZE = 20; // <= 31
const CODE_SIZE = 500; // 32..MAX_CHUNK
const BIG_SIZE = MAX_CHUNK * 2 + 300; // > MAX_CHUNK: staged on-chain, or external

describe('all three tiers in one stream', () => {
	let ev;
	let ipfsClient;
	let expected;

	beforeAll(async () => {
		ipfsClient = makeMockIpfs();
		ev = await Mnemonad.create(baseParams({ ipfsClient }));

		// Interleaved deliberately, so a tier boundary never coincides with an index
		// boundary in a way that could mask an off-by-one.
		expected = [
			{ tier: 'slot', data: makeBytes(SLOT_SIZE, 1) },
			{ tier: 'code', data: makeBytes(CODE_SIZE, 2) },
			{ tier: 'external', data: makeBytes(BIG_SIZE, 3) },
			{ tier: 'slot', data: makeBytes(31, 4) }, // exactly the SLOT ceiling
			{ tier: 'code', data: makeBytes(32, 5) }, // exactly one past it
			{ tier: 'code', data: makeBytes(BIG_SIZE, 6), onChain: true }, // multi-chunk
			{ tier: 'external', data: makeBytes(MAX_CHUNK * 5, 7) },
			{ tier: 'code', data: makeBytes(MAX_CHUNK, 8) }, // largest single chunk
			{ tier: 'slot', data: makeBytes(1, 9) },
		];

		for (const item of expected) {
			await ev.push(item.data, item.onChain ? { onChain: true } : {});
		}
	}, 300_000);

	it('routes each item to the intended tier', async () => {
		for (let i = 0; i < expected.length; i += 1) {
			const item = await ev.itemAt(i);
			expect(item.storeName).toBe(expected[i].tier);
		}
	}, 120_000);

	it('reads every item back byte-exactly regardless of tier', async () => {
		await ev.initialize();
		expect(ev.length).toBe(expected.length);

		for (let i = 0; i < expected.length; i += 1) {
			expectSameBytes(new Uint8Array(await ev.at(i)), expected[i].data);
		}
	}, 300_000);

	it('sums binaryLength across every tier', async () => {
		await ev.initialize();
		// External items count their off-chain payload even though only a pointer is stored,
		// so the total is payload bytes, not on-chain bytes.
		const total = expected.reduce((sum, e) => sum + e.data.length, 0);
		expect(ev.binaryLength).toBe(total);
	}, 60_000);

	it('reports per-tier layout through getItemRefs', async () => {
		for (let i = 0; i < expected.length; i += 1) {
			const refs = await ev.getItemRefs(i);
			expect(refs.size).toBe(expected[i].data.length);

			if (expected[i].tier === 'code') {
				// Only CODE items have chunk addresses — the migration primitive.
				expect(refs.chunks.length).toBeGreaterThan(0);
				for (const addr of refs.chunks) expect(addr).not.toBe(
					'0x0000000000000000000000000000000000000000'
				);
			} else {
				expect(refs.chunks.length).toBe(0);
			}
		}
	}, 120_000);

	it('serves ranges from every tier', async () => {
		for (let i = 0; i < expected.length; i += 1) {
			const { data } = expected[i];
			if (data.length < 4) continue; // too short to slice meaningfully

			const start = Math.floor(data.length / 3);
			const len = Math.min(50, data.length - start);
			expectSameBytes(
				await ev.readRange(i, start, len),
				data.subarray(start, start + len)
			);
		}
	}, 300_000);

	it('rejects at() on an external item and pointerAt() on an on-chain one', async () => {
		const externalIdx = expected.findIndex((e) => e.tier === 'external');
		const onChainIdx = expected.findIndex((e) => e.tier === 'code');

		// An external item has no on-chain payload; a plain SDK read fetches from IPFS, but
		// the raw contract call must refuse rather than return junk.
		const { mnemonadAbi } = await import('../abi.js');
		await expect(
			clients.publicClient.readContract({
				address: contractAddress,
				abi: mnemonadAbi,
				functionName: 'at',
				args: [ev.id, BigInt(externalIdx)],
			})
		).rejects.toThrow();

		await expect(ev.pointerAt(onChainIdx)).rejects.toThrow();
		// ...and the reverse direction resolves fine.
		expect((await ev.pointerAt(externalIdx)).locator).toBeTruthy();
	}, 120_000);

	it('keeps only external payloads off-chain', async () => {
		// Two external items were pushed; nothing else should have reached IPFS.
		const externals = expected.filter((e) => e.tier === 'external');
		expect(ipfsClient.store.size).toBe(externals.length);
	}, 60_000);
});

describe('packing alongside other tiers', () => {
	it('mixes a packed batch with slot, staged and external items', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));

		const batch = [makeBytes(100, 1), makeBytes(150, 2), makeBytes(90, 3)];
		const slot = makeBytes(15, 4);
		const staged = makeBytes(MAX_CHUNK * 2, 5);
		const external = makeBytes(MAX_CHUNK * 4, 6);

		await ev.push(slot);
		await ev.pushMany(batch);
		await ev.push(staged, { onChain: true });
		await ev.push(external);

		await ev.initialize();
		expect(ev.length).toBe(1 + batch.length + 2);

		expectSameBytes(new Uint8Array(await ev.at(0)), slot);
		for (let i = 0; i < batch.length; i += 1) {
			expectSameBytes(new Uint8Array(await ev.at(1 + i)), batch[i]);
		}
		expectSameBytes(new Uint8Array(await ev.at(4)), staged);
		expectSameBytes(new Uint8Array(await ev.at(5)), external);

		// The batch shares one chunk; the staged item owns several of its own.
		const r1 = await ev.getItemRefs(1);
		const r3 = await ev.getItemRefs(3);
		expect(r3.chunks[0]).toBe(r1.chunks[0]);
		expect((await ev.getItemRefs(4)).chunks.length).toBeGreaterThan(1);
		expect((await ev.getItemRefs(5)).chunks.length).toBe(0);
	}, 300_000);

	it('slices a packed item without bleeding into its neighbours', async () => {
		const ev = await Mnemonad.create(baseParams());
		const batch = [makeBytes(200, 1), makeBytes(200, 2), makeBytes(200, 3)];
		await ev.pushMany(batch);

		// Items 0..2 share one chunk at offsets 0/200/400. A range must be relative to the
		// item, and must not run past its end into the next one.
		expectSameBytes(await ev.readRange(1, 0, 200), batch[1]);
		expectSameBytes(await ev.readRange(1, 190, 10), batch[1].subarray(190));
		await expect(ev.readRange(1, 190, 20)).rejects.toThrow();
	}, 120_000);
});

describe('concat preserves tiers', () => {
	it('merges two mixed-tier streams and keeps every item readable', async () => {
		const ipfsClient = makeMockIpfs();
		const dst = await Mnemonad.create(baseParams({ ipfsClient }));
		const src = await Mnemonad.create(baseParams({ ipfsClient }));

		const dstItems = [makeBytes(20, 1), makeBytes(400, 2)];
		const srcItems = [
			{ data: makeBytes(25, 3) }, // slot
			{ data: makeBytes(600, 4) }, // code
			{ data: makeBytes(MAX_CHUNK * 3, 5) }, // external
			{ data: makeBytes(MAX_CHUNK * 2, 6), onChain: true }, // multi-chunk code
		];

		for (const d of dstItems) await dst.push(d);
		for (const s of srcItems) await src.push(s.data, s.onChain ? { onChain: true } : {});

		const srcChunk1 = await src.getItemRefs(1);
		await dst.concat(src);

		await dst.initialize();
		expect(dst.length).toBe(dstItems.length + srcItems.length);

		for (let i = 0; i < dstItems.length; i += 1) {
			expectSameBytes(new Uint8Array(await dst.at(i)), dstItems[i]);
		}
		// concat has a per-tier branch — slot data copied, pointers copied, extra chunks
		// re-linked — so every tier needs checking on the far side of the merge.
		for (let i = 0; i < srcItems.length; i += 1) {
			const idx = dstItems.length + i;
			expectSameBytes(new Uint8Array(await dst.at(idx)), srcItems[i].data);
		}

		expect((await dst.itemAt(2)).storeName).toBe('slot');
		expect((await dst.itemAt(3)).storeName).toBe('code');
		expect((await dst.itemAt(4)).storeName).toBe('external');
		expect((await dst.itemAt(5)).storeName).toBe('code');
		expect((await dst.getItemRefs(5)).chunks.length).toBeGreaterThan(1);

		// A relinked CODE item points at the same deployed chunk — no bytes copied.
		expect((await dst.getItemRefs(3)).chunks[0]).toBe(srcChunk1.chunks[0]);

		const total =
			dstItems.reduce((s, d) => s + d.length, 0) +
			srcItems.reduce((s, i) => s + i.data.length, 0);
		expect(dst.binaryLength).toBe(total);
	}, 300_000);
});

describe('mixed tiers under encryption', () => {
	it('encrypts and round-trips items across all three tiers', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ ipfsClient, encrypt: true, signer: clients.walletClient })
		);

		// Sizes chosen against the CIPHERTEXT thresholds: framing adds 26 bytes for a
		// single-frame item, so 5 bytes of plaintext is the largest that still fits a slot.
		const items = [
			{ data: makeBytes(5, 1), tier: 'slot' },
			{ data: makeBytes(400, 2), tier: 'code' },
			{ data: makeBytes(MAX_CHUNK * 3, 3), tier: 'external' },
			{ data: makeBytes(MAX_CHUNK, 4), onChain: true, tier: 'code' },
		];

		for (const item of items) {
			await ev.push(item.data, item.onChain ? { onChain: true } : {});
		}

		await ev.initialize();
		expect(ev.length).toBe(items.length);

		for (let i = 0; i < items.length; i += 1) {
			expect((await ev.itemAt(i)).storeName).toBe(items[i].tier);
			expectSameBytes(new Uint8Array(await ev.at(i)), items[i].data);
		}

		// binaryLength counts ciphertext, which is what is actually stored.
		const total = items.reduce(
			(sum, i) => sum + MnemonadCrypto.ciphertextLengthFor(i.data.length),
			0
		);
		expect(ev.binaryLength).toBe(total);
	}, 300_000);

	it('serves ranges from every tier of an encrypted stream', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ ipfsClient, encrypt: true, signer: clients.walletClient })
		);

		const code = makeBytes(1_000, 1);
		const external = makeBytes(MAX_CHUNK * 3, 2);
		await ev.push(code);
		await ev.push(external);

		// Frames make partial decryption possible for both on-chain and off-chain payloads.
		expectSameBytes(await ev.readRange(0, 100, 200), code.subarray(100, 300));
		expectSameBytes(await ev.readRange(1, 2_000, 500), external.subarray(2_000, 2_500));

		// And plaintext length is reported per tier, not the stored ciphertext length.
		expect(await ev.plaintextLengthAt(0)).toBe(code.length);
		expect(await ev.plaintextLengthAt(1)).toBe(external.length);
	}, 300_000);

	it('stores ciphertext in every tier, never plaintext', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ ipfsClient, encrypt: true, signer: clients.walletClient })
		);

		const slot = makeBytes(5, 1);
		const code = makeBytes(300, 2);
		const external = makeBytes(MAX_CHUNK * 3, 3);
		await ev.push(slot);
		await ev.push(code);
		await ev.push(external);

		// SLOT and CODE hold ciphertext on-chain...
		for (const [i, data] of [[0, slot], [1, code]]) {
			const raw = await ev._atRaw(i);
			expect(raw.length).toBe(MnemonadCrypto.ciphertextLengthFor(data.length));
			expect(Buffer.from(raw).equals(Buffer.from(data))).toBe(false);
		}

		// ...and IPFS holds ciphertext too.
		const pointer = await ev.pointerAt(2);
		const stored = ipfsClient.store.get(pointer.locator);
		expect(stored.length).toBe(MnemonadCrypto.ciphertextLengthFor(external.length));
		expect(Buffer.from(stored).equals(Buffer.from(external))).toBe(false);
	}, 300_000);
});

describe('tier boundaries', () => {
	it('places items exactly at each threshold in the right tier', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));

		const cases = [
			{ size: 1, tier: 'slot' },
			{ size: 31, tier: 'slot' }, // SLOT_MAX_BYTES
			{ size: 32, tier: 'code' }, // one past it
			{ size: MAX_CHUNK - 1, tier: 'code' },
			{ size: MAX_CHUNK, tier: 'code' }, // largest single chunk
			{ size: MAX_CHUNK + 1, tier: 'external' }, // one past: offloaded
		];

		for (const c of cases) {
			const data = makeBytes(c.size, 1);
			await ev.push(data);
			const idx = (await ev.initialize(), ev.length - 1);
			expect((await ev.itemAt(idx)).storeName).toBe(c.tier);
			expectSameBytes(new Uint8Array(await ev.at(idx)), data);
		}

		expect(Number(await ev._read('SLOT_MAX_BYTES', []))).toBe(31);
	}, 300_000);

	it('exposes the tier as both an enum value and a name', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(20, 1));
		await ev.push(makeBytes(200, 2));

		expect((await ev.itemAt(0)).store).toBe(Store.SLOT);
		expect((await ev.itemAt(1)).store).toBe(Store.CODE);
		expect((await ev.itemAt(0)).isBytes).toBe(true);
		expect((await ev.itemAt(1)).isExternal).toBe(false);
	}, 120_000);
});
