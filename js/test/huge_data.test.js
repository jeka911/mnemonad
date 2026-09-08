import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import { startNode, makeClients, deployRegistry, makeBytes } from './fixture.js';

/**
 * Huge on-chain items — the case that only works because of paged reads.
 *
 * A single `at()` allocates the whole item and the ABI return copies it, so it needs
 * roughly 2× the item size in memory. Against Monad's 8 MB per-transaction cap that puts a
 * hard ceiling near 3–4 MB; locally, where EDR prices memory expansion quadratically the
 * Ethereum way, a one-shot read gives up even earlier (measured: 1 MB costs 9.2M gas,
 * 3 MB fails outright).
 *
 * Without `readRange`, an item past that point would be writable but permanently
 * unreadable. These tests exist to prove it is not.
 *
 * Kept separate from `large_data.test.js` because pushing multi-megabyte items takes
 * hundreds of transactions and this file is slow by nature.
 */

let node;
let clients;
let contractAddress;

/** Just under the local EIP-170 code limit. Monad would allow ~120 KB. */
const MAX_CHUNK = 24_000;
const KB = 1024;
const MB = 1024 * KB;

/** Deliberately larger than any one-shot read can serve, locally or on Monad. */
const HUGE = 4 * MB;

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

/** One huge item, pushed once and reused — each push here costs ~175 transactions. */
let hugeStream;
let hugeData;

beforeAll(async () => {
	hugeData = makeBytes(HUGE, 42);
	hugeStream = await Mnemonad.create(baseParams());
	await hugeStream.push(hugeData, { onChain: true });
}, 600_000);

describe('a one-shot read cannot serve a huge item', () => {
	it('fails on the whole item but succeeds on a page of it', async () => {
		// The premise of this file, asserted rather than assumed — and asserted in a way
		// that pins the cause to SIZE. Both calls target the same stream, same item, same
		// ABI; only the requested byte count differs. So a pass here cannot be explained
		// by a missing stream, a bad id, or a decode error.
		const { mnemonadAbi } = await import('../abi.js');

		const page = await hugeStream.readRange(0, 0, 512 * KB);
		expect(page.length).toBe(512 * KB);

		await expect(
			clients.publicClient.readContract({
				address: contractAddress,
				abi: mnemonadAbi,
				functionName: 'at',
				args: [hugeStream.id, 0n],
			})
		).rejects.toThrow();
	}, 60_000);
});

describe('paged reads', () => {
	it('reads a 4 MB on-chain item byte-exactly by paging', async () => {
		await hugeStream.initialize();
		expect(hugeStream.binaryLength).toBe(HUGE);

		const refs = await hugeStream.getItemRefs(0);
		expect(refs.chunks.length).toBe(Math.ceil(HUGE / MAX_CHUNK)); // 175 chunks
		expect(refs.size).toBe(HUGE);

		// `at()` pages automatically above readPageBytes; the caller sees one buffer.
		expectSameBytes(new Uint8Array(await hugeStream.at(0)), hugeData);
	}, 600_000);

	it('honours a custom page size', async () => {
		const paged = new Mnemonad(
			baseParams({ id: hugeStream.id, readPageBytes: 128 * KB })
		);
		expect(paged.readPageBytes).toBe(128 * KB);
		// 32 pages instead of 8 — same bytes out.
		expectSameBytes(new Uint8Array(await paged.at(0)), hugeData);
	}, 600_000);
});

describe('readRange slices', () => {
	it('returns the first and last bytes of a huge item', async () => {
		const head = await hugeStream.readRange(0, 0, 1_000);
		expectSameBytes(head, hugeData.subarray(0, 1_000));

		const tail = await hugeStream.readRange(0, HUGE - 1_000, 1_000);
		expectSameBytes(tail, hugeData.subarray(HUGE - 1_000));
	}, 120_000);

	it('reads a slice that spans a chunk boundary', async () => {
		// Chunk 0 ends at MAX_CHUNK, so this straddles chunks 0 and 1 — the case a naive
		// per-chunk implementation gets wrong.
		const start = MAX_CHUNK - 500;
		const len = 1_000;
		const slice = await hugeStream.readRange(0, start, len);
		expectSameBytes(slice, hugeData.subarray(start, start + len));
	}, 120_000);

	it('reads a slice spanning many whole chunks', async () => {
		const start = MAX_CHUNK * 3 + 17;
		const len = MAX_CHUNK * 4 + 123;
		const slice = await hugeStream.readRange(0, start, len);
		expectSameBytes(slice, hugeData.subarray(start, start + len));
	}, 120_000);

	it('reads a slice entirely inside one interior chunk', async () => {
		const start = MAX_CHUNK * 10 + 100;
		const len = 200;
		const slice = await hugeStream.readRange(0, start, len);
		expectSameBytes(slice, hugeData.subarray(start, start + len));
	}, 120_000);

	it('reads a deep slice far from the start', async () => {
		// Chunk 170 of 175: proves the skip loop walks correctly rather than only
		// handling early offsets.
		const start = MAX_CHUNK * 170 + 7;
		const len = 5_000;
		const slice = await hugeStream.readRange(0, start, len);
		expectSameBytes(slice, hugeData.subarray(start, start + len));
	}, 120_000);

	it('reads a zero-length slice', async () => {
		const slice = await hugeStream.readRange(0, 1_000, 0);
		expect(slice.length).toBe(0);
	}, 60_000);

	it('rejects a range past the end of the item', async () => {
		await expect(hugeStream.readRange(0, HUGE - 10, 100)).rejects.toThrow();
		await expect(hugeStream.readRange(0, HUGE + 1, 1)).rejects.toThrow();
	}, 60_000);
});

describe('readRange on other tiers', () => {
	it('slices a small SLOT item', async () => {
		const ev = await Mnemonad.create(baseParams());
		const data = makeBytes(31, 1);
		await ev.push(data);

		expectSameBytes(await ev.readRange(0, 10, 15), data.subarray(10, 25));
	}, 60_000);

	it('slices a packed item without leaking its neighbours', async () => {
		const ev = await Mnemonad.create(baseParams());
		const items = [makeBytes(500, 1), makeBytes(500, 2), makeBytes(500, 3)];
		await ev.pushMany(items);

		// Item 1 sits at offset 500 inside the shared chunk; a range must be relative to
		// the ITEM, not the chunk, and must not run into item 2.
		expectSameBytes(await ev.readRange(1, 0, 500), items[1]);
		expectSameBytes(await ev.readRange(1, 400, 100), items[1].subarray(400));
		await expect(ev.readRange(1, 400, 200)).rejects.toThrow();
	}, 60_000);
});
