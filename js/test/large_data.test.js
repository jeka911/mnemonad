import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * Large-payload tests. The rest of the suite runs with a deliberately tiny 2 KB chunk
 * ceiling to keep the staged path reachable cheaply; this file uses a realistic ceiling and
 * genuinely large data, because "many chunks" and "a lot of bytes" fail in different ways.
 *
 * What CANNOT be covered here, and why it is a testnet-only concern:
 * the local EDR node enforces EIP-170's 24,576-byte contract-code limit, so a single chunk
 * can never exceed ~24 KB locally. Monad raises that to 128 KB, which is what makes a
 * ~120 KB single-chunk push possible there. So the chunk COUNT and reassembly logic are
 * proven here; the per-chunk SIZE ceiling is not.
 */

let node;
let clients;
let contractAddress;

/** Just under the local EIP-170 limit: runtime code is 1 + payload, so 24,000 + 1 fits. */
const MAX_CHUNK = 24_000;

const KB = 1024;

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

/**
 * Byte-exact comparison for large payloads.
 *
 * `expect(a).toEqual(b)` deep-compares typed arrays element by element, which costs ~19s
 * on 4 MB. Comparing length first, then via Buffer.equals, keeps the same strictness and
 * still distinguishes a truncated read from a corrupted one.
 */
function expectSameBytes(actual, expected) {
	expect(actual.length).toBe(expected.length);
	expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

describe('single chunk at the local ceiling', () => {
	it('pushes and reads back the largest chunk this environment allows', async () => {
		const ev = await Mnemonad.create(baseParams());
		const data = makeBytes(MAX_CHUNK, 1);

		await ev.push(data);

		expectSameBytes(new Uint8Array(await ev.at(0)), data);

		const refs = await ev.getItemRefs(0);
		expect(refs.chunks.length).toBe(1);
	}, 60_000);
});

describe('staged on-chain append of large items', () => {
	it('stores 256 KB across many chunks and reassembles it byte-exactly', async () => {
		const ev = await Mnemonad.create(baseParams());
		const size = 256 * KB;
		const data = makeBytes(size, 3);

		await ev.push(data, { onChain: true });

		await ev.initialize();
		expect(ev.length).toBe(1);
		expect(ev.binaryLength).toBe(size);

		const expectedChunks = Math.ceil(size / MAX_CHUNK);
		const refs = await ev.getItemRefs(0);
		expect(refs.chunks.length).toBe(expectedChunks);
		expect(refs.size).toBe(size);
		// Every chunk must be a distinct deployment.
		expect(new Set(refs.chunks).size).toBe(expectedChunks);

		// The real assertion: a single eth_call reassembles all 11 chunks correctly.
		// Reassembly preallocates one buffer rather than concatenating chunk by chunk,
		// which would be quadratic in memory and blow Monad's 8 MB per-tx cap here.
		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 180_000);

	it('stores 1 MB on-chain and reads it back intact', async () => {
		const ev = await Mnemonad.create(baseParams());
		const size = 1024 * KB;
		const data = makeBytes(size, 4);

		await ev.push(data, { onChain: true });

		await ev.initialize();
		expect(ev.binaryLength).toBe(size);

		const refs = await ev.getItemRefs(0);
		expect(refs.chunks.length).toBe(Math.ceil(size / MAX_CHUNK)); // 44 chunks

		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 300_000);

	it('keeps small items readable alongside a large one', async () => {
		const ev = await Mnemonad.create(baseParams());
		const small = makeBytes(50, 1);
		const big = makeBytes(64 * KB, 2);

		await ev.push(small);
		await ev.push(big, { onChain: true });
		await ev.push(small);

		await ev.initialize();
		expect(ev.length).toBe(3);
		expect(new Uint8Array(await ev.at(0))).toEqual(small);
		expectSameBytes(new Uint8Array(await ev.at(1)), big);
		expect(new Uint8Array(await ev.at(2))).toEqual(small);
	}, 120_000);

	it('reports progress once per beginItem/appendChunk/commitItem', async () => {
		const ev = await Mnemonad.create(baseParams());
		// Small enough to stay fast (a handful of chunks), big enough to genuinely stage.
		const size = MAX_CHUNK * 3 + 500;
		const data = makeBytes(size, 5);
		const expectedChunks = Math.ceil(size / MAX_CHUNK);

		const events = [];
		await ev.push(data, { onChain: true, onProgress: (info) => events.push(info) });

		expect(events.length).toBe(1 + expectedChunks + 1); // begin + N chunks + commit
		expect(events[0]).toEqual({ phase: 'begin', chunkIndex: 0, chunkCount: expectedChunks });
		for (let i = 0; i < expectedChunks; i += 1) {
			expect(events[1 + i]).toEqual({ phase: 'chunk', chunkIndex: i + 1, chunkCount: expectedChunks });
		}
		expect(events[events.length - 1]).toEqual({
			phase: 'commit',
			chunkIndex: expectedChunks,
			chunkCount: expectedChunks,
		});

		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 60_000);

	it('never lets a throwing onProgress break the upload', async () => {
		const ev = await Mnemonad.create(baseParams());
		const data = makeBytes(MAX_CHUNK * 2 + 100, 6);

		await ev.push(data, {
			onChain: true,
			onProgress: () => {
				throw new Error('a badly-written callback should not matter');
			},
		});

		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 60_000);

	it('onProgress is never called for a single-transaction push', async () => {
		const ev = await Mnemonad.create(baseParams());
		let called = false;

		await ev.push(makeBytes(50, 7), { onProgress: () => { called = true; } });

		expect(called).toBe(false);
	});

	it('rejects a mid-stage retry at a stale offset', async () => {
		// Staging offsets are checked on-chain, which is what makes a retry after a
		// timeout idempotent instead of appending the same chunk twice. Exercised here
		// against the raw contract, since the SDK never replays a chunk itself.
		const { mnemonadAbi } = await import('../abi.js');
		const ev = await Mnemonad.create(baseParams());

		const beginHash = await clients.walletClient.writeContract({
			address: contractAddress,
			abi: mnemonadAbi,
			functionName: 'beginItem',
			args: [ev.id, 2 * MAX_CHUNK, '0x'],
		});
		const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: beginHash });

		const { decodeEventLog } = await import('viem');
		let stagingId;
		for (const log of receipt.logs) {
			try {
				const d = decodeEventLog({ abi: mnemonadAbi, data: log.data, topics: log.topics });
				if (d.eventName === 'ItemStaged') stagingId = d.args.stagingId;
			} catch { /* not ours */ }
		}
		expect(stagingId).toBeDefined();

		const chunk = makeBytes(MAX_CHUNK, 1);
		const hex = `0x${Buffer.from(chunk).toString('hex')}`;
		const h = await clients.walletClient.writeContract({
			address: contractAddress,
			abi: mnemonadAbi,
			functionName: 'appendChunk',
			args: [stagingId, 0, hex],
		});
		await clients.publicClient.waitForTransactionReceipt({ hash: h });

		// Replaying offset 0 must revert rather than duplicate.
		await expect(
			clients.walletClient.writeContract({
				address: contractAddress,
				abi: mnemonadAbi,
				functionName: 'appendChunk',
				args: [stagingId, 0, hex],
			})
		).rejects.toThrow();
	}, 120_000);
});

describe('large items via IPFS', () => {
	it('offloads 4 MB with only a pointer on-chain', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		const size = 4 * 1024 * KB;
		const data = makeBytes(size, 5);

		await ev.push(data);

		await ev.initialize();
		expect(ev.length).toBe(1);
		// binaryLength tracks the off-chain payload even though ~36 bytes hit the chain.
		expect(ev.binaryLength).toBe(size);

		const item = await ev.itemAt(0);
		expect(item.isExternal).toBe(true);
		expect(item.size).toBe(size);

		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 180_000);

	it('offloads a payload far beyond any on-chain ceiling', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		const size = 16 * 1024 * KB; // 16 MB — hopeless on-chain, trivial as a pointer
		const data = makeBytes(size, 6);

		await ev.push(data);

		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 240_000);
});

describe('large packed batches', () => {
	it('packs many items up to the chunk ceiling into one deployment', async () => {
		const ev = await Mnemonad.create(baseParams());
		const count = 60;
		const each = Math.floor(MAX_CHUNK / count); // 400 bytes each, ~24 KB total
		const items = Array.from({ length: count }, (_, i) => makeBytes(each, (i % 250) + 1));

		await ev.pushMany(items);

		await ev.initialize();
		expect(ev.length).toBe(count);
		expect(ev.binaryLength).toBe(count * each);

		const first = await ev.getItemRefs(0);
		const last = await ev.getItemRefs(count - 1);
		// All 60 items in a single deployed chunk — the whole point of packing.
		expect(last.chunks[0]).toBe(first.chunks[0]);
		expect(last.offset).toBe((count - 1) * each);

		for (let i = 0; i < count; i += 1) {
			expect(new Uint8Array(await ev.at(i))).toEqual(items[i]);
		}
	}, 180_000);
});

describe('many items', () => {
	it('grows past a single storage page without losing items', async () => {
		// Monad's MIP-8 pages hold 128 slots each, so 140 items span at least two pages
		// wherever the array starts — which is where a layout mistake in the item array
		// would first show up. (The array starts at a hashed slot, so its page boundary
		// falls at an arbitrary index, not at 128.)
		const ev = await Mnemonad.create(baseParams());
		const count = 140;
		const items = Array.from({ length: count }, (_, i) => makeBytes(20, (i % 250) + 1));

		// Two packed batches, straddling the 128-slot page boundary.
		await ev.pushMany(items.slice(0, 70));
		await ev.pushMany(items.slice(70));

		await ev.initialize();
		expect(ev.length).toBe(count);

		for (const i of [0, 69, 70, 127, 128, 139]) {
			expect(new Uint8Array(await ev.at(i))).toEqual(items[i]);
		}
	}, 180_000);
});
