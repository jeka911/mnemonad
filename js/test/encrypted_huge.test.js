import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * Encryption at sizes past what a single read can return.
 *
 * This is where the framed ciphertext format earns its keep. A single GCM message per item
 * would put one tag over the whole ciphertext, so reading one byte of a 4 MB item would
 * mean fetching and authenticating all 4 MB — random access would work for plaintext items
 * and silently not for encrypted ones. Framing makes every 64 KiB frame independently
 * decryptable, so a range read touches only the frames it overlaps.
 *
 * Slow by nature: a 4 MB item is ~175 transactions to write.
 */

let node;
let clients;
let contractAddress;

const MAX_CHUNK = 24_000;
const KB = 1024;
const MB = 1024 * KB;

/** Larger than any one-shot read can serve, locally or on Monad. */
const HUGE = 4 * MB;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
}, 180_000);

afterAll(async () => {
	await node?.stop();
});

/** Ciphertext size for a plaintext of `n` bytes under the framed format. */
function cipherLen(n) {
	return MnemonadCrypto.ciphertextLengthFor(n);
}

function baseParams(extra = {}) {
	return {
		publicClient: clients.publicClient,
		walletClient: clients.walletClient,
		contractAddress,
		...extra,
	};
}

function createEncrypted(extra = {}) {
	return Mnemonad.create(
		baseParams({ encrypt: true, signer: clients.walletClient, ...extra })
	);
}

function expectSameBytes(actual, expected) {
	expect(actual.length).toBe(expected.length);
	expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

/** One huge encrypted item, written once and shared — each write is ~175 transactions. */
let hugeVector;
let hugeData;

beforeAll(async () => {
	hugeData = makeBytes(HUGE, 77);
	hugeVector = await createEncrypted();
	await hugeVector.push(hugeData, { onChain: true });
}, 900_000);

describe('paged encrypted reads', () => {
	it('writes 4 MB encrypted across many chunks', async () => {
		await hugeVector.initialize();
		expect(await hugeVector.isEncrypted()).toBe(true);
		expect(hugeVector.binaryLength).toBe(cipherLen(HUGE));

		const refs = await hugeVector.getItemRefs(0);
		expect(refs.chunks.length).toBe(Math.ceil(cipherLen(HUGE) / MAX_CHUNK));
		expect(refs.size).toBe(cipherLen(HUGE));
	}, 120_000);

	it('pages the ciphertext and decrypts once, byte-exactly', async () => {
		// The whole point of the file: at() must reassemble every page BEFORE decrypting.
		expectSameBytes(new Uint8Array(await hugeVector.at(0)), hugeData);
	}, 600_000);

	it('produces the same plaintext at a smaller page size', async () => {
		const paged = new Mnemonad(
			baseParams({
				id: hugeVector.id,
				signer: clients.walletClient,
				readPageBytes: 128 * KB,
			})
		);
		expect(paged.readPageBytes).toBe(128 * KB);
		// 32 pages instead of 8. Page size must not affect the decrypted result.
		expectSameBytes(new Uint8Array(await paged.at(0)), hugeData);
	}, 600_000);

	it('cannot serve the whole ciphertext in one call, but can serve a page', async () => {
		const { mnemonadAbi } = await import('../abi.js');

		const page = await hugeVector.readRange(0, 0, 512 * KB);
		expect(page.length).toBe(512 * KB);

		// Same vector, same item, same ABI — only the byte count differs, so the failure
		// is attributable to size alone.
		await expect(
			clients.publicClient.readContract({
				address: contractAddress,
				abi: mnemonadAbi,
				functionName: 'at',
				args: [hugeVector.id, 0n],
			})
		).rejects.toThrow();
	}, 120_000);
});

describe('partial decryption', () => {
	it('returns plaintext from a range of an encrypted item', async () => {
		const slice = await hugeVector.readRange(0, 0, 4 * KB);
		expectSameBytes(slice, hugeData.subarray(0, 4 * KB));
	}, 120_000);

	it('reads a range deep inside the item', async () => {
		const start = 3 * MB + 12_345;
		const len = 8 * KB;
		expectSameBytes(
			await hugeVector.readRange(0, start, len),
			hugeData.subarray(start, start + len)
		);
	}, 120_000);

	it('reads a range spanning a frame boundary', async () => {
		// Frames are 64 KiB, so this straddles frames 0 and 1 — the case that needs two
		// frames fetched and their plaintext joined.
		const start = 64 * KB - 100;
		const len = 200;
		expectSameBytes(
			await hugeVector.readRange(0, start, len),
			hugeData.subarray(start, start + len)
		);
	}, 120_000);

	it('reads the final partial frame', async () => {
		const start = HUGE - 1_000;
		expectSameBytes(await hugeVector.readRange(0, start, 1_000), hugeData.subarray(start));
	}, 120_000);

	it('fetches only the frames a small range overlaps', async () => {
		// The reason framing exists. Count the ranged contract calls a 1 KB read makes:
		// one for the 10-byte header, one for the single covering frame. Not 4 MB worth.
		const ev = new Mnemonad(
			baseParams({ id: hugeVector.id, signer: clients.walletClient })
		);
		const original = ev._read.bind(ev);
		const rangeReads = [];
		ev._read = async (fn, args) => {
			if (fn === 'readRange') rangeReads.push(Number(args[3]));
			return await original(fn, args);
		};

		const slice = await ev.readRange(0, 0, 1_024);
		expectSameBytes(slice, hugeData.subarray(0, 1_024));

		const fetched = rangeReads.reduce((a, b) => a + b, 0);
		// Header (10) + one 64 KiB frame + its tag. Far below the 4 MB item.
		expect(fetched).toBeLessThan(128 * KB);
		expect(rangeReads.length).toBe(2);
	}, 120_000);

	it('rejects a range outside the item', async () => {
		await expect(hugeVector.readRange(0, HUGE - 10, 100)).rejects.toThrow();
		await expect(hugeVector.readRange(0, HUGE + 1, 1)).rejects.toThrow();
	}, 60_000);

	it('reports the plaintext length, not the ciphertext length', async () => {
		expect(await hugeVector.plaintextLengthAt(0)).toBe(HUGE);
	}, 60_000);
});

describe('streaming', () => {
	it('streams a whole item frame by frame', async () => {
		let bytes = 0;
		let pieces = 0;
		for await (const piece of hugeVector.stream(0)) {
			bytes += piece.length;
			pieces += 1;
		}
		expect(bytes).toBe(HUGE);
		// 64 KiB frames over 4 MB.
		expect(pieces).toBe(Math.ceil(HUGE / (64 * KB)));
	}, 600_000);

	it('streams only a requested window', async () => {
		const start = 1 * MB;
		const len = 100 * KB;
		const parts = [];
		for await (const piece of hugeVector.stream(0, { start, len })) parts.push(piece);

		const joined = Buffer.concat(parts.map((p) => Buffer.from(p)));
		expect(joined.length).toBe(len);
		expect(joined.equals(Buffer.from(hugeData.subarray(start, start + len)))).toBe(true);
		// Two 64 KiB frames cover a 100 KB window starting on a frame boundary.
		expect(parts.length).toBe(2);
	}, 300_000);

	it('never holds more than one frame at a time', async () => {
		// A stream consumer that discards each piece should be able to walk an item far
		// larger than the plaintext buffer at() would allocate.
		let largest = 0;
		let total = 0;
		for await (const piece of hugeVector.stream(0)) {
			largest = Math.max(largest, piece.length);
			total += piece.length;
		}
		expect(total).toBe(HUGE);
		expect(largest).toBeLessThanOrEqual(64 * KB);
	}, 600_000);

	it('streams a plaintext vector too', async () => {
		const ev = await Mnemonad.create(baseParams({ readPageBytes: 64 * KB }));
		const data = makeBytes(200 * KB, 5);
		await ev.push(data, { onChain: true });

		const parts = [];
		for await (const piece of ev.stream(0)) parts.push(piece);
		expect(Buffer.concat(parts.map((p) => Buffer.from(p))).equals(Buffer.from(data)))
			.toBe(true);
	}, 300_000);
});

describe('frame integrity', () => {
	it('rejects a frame moved to another position', async () => {
		// Frame index is bound into the AAD, so a frame is only valid where it was written.
		// Without that, frames could be reordered undetectably.
		const layout = await hugeVector._cipherLayout(0);
		const frame0 = await hugeVector._readRangeRaw(
			0,
			layout.frameOffset(0),
			layout.frameCipherLength(0)
		);

		// At its own index and finality, it decrypts.
		const plain = await hugeVector.crypto.decryptFrame(frame0, 0, false, layout);
		expectSameBytes(plain, hugeData.subarray(0, layout.frameSize));

		// Claimed at another index, or as the final frame, it does not.
		await expect(hugeVector.crypto.decryptFrame(frame0, 1, false, layout)).rejects.toThrow();
		await expect(hugeVector.crypto.decryptFrame(frame0, 0, true, layout)).rejects.toThrow();
	}, 120_000);

	it('rejects a truncated item', async () => {
		// The final-frame flag is authenticated, so dropping trailing frames leaves a
		// reader expecting a final frame it never sees.
		const whole = await hugeVector._atRaw(0);
		const layout = await hugeVector._cipherLayout(0);
		const truncated = whole.subarray(0, layout.frameOffset(layout.frameCount - 1));

		await expect(hugeVector.crypto.decryptItem(truncated)).rejects.toThrow();
	}, 300_000);
});

describe('huge encrypted items offloaded to IPFS', () => {
	it('pins 8 MB of ciphertext and decrypts on read', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		const size = 8 * MB;
		const data = makeBytes(size, 88);

		await ev.push(data);

		await ev.initialize();
		expect(ev.binaryLength).toBe(cipherLen(size));

		const pointer = await ev.pointerAt(0);
		const stored = ipfsClient.store.get(pointer.locator);
		expect(stored.length).toBe(cipherLen(size));

		// Off-chain payloads have no page limit — the pointer is 36 bytes whatever the size.
		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 600_000);

	it('detects a substituted payload before attempting decryption', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		const data = makeBytes(2 * MB, 89);

		await ev.push(data);
		const pointer = await ev.pointerAt(0);

		ipfsClient.corrupt(pointer.locator, makeBytes(cipherLen(data.length), 7));
		await expect(ev.at(0)).rejects.toThrow(/hash mismatch/);
	}, 300_000);
});

describe('ranged reads of encrypted off-chain items', () => {
	/** One 8 MB encrypted external item, shared across the cases below. */
	let extVector;
	let extData;
	let ipfsClient;

	beforeAll(async () => {
		ipfsClient = makeMockIpfs();
		extVector = await createEncrypted({ ipfsClient });
		extData = makeBytes(8 * MB, 91);
		await extVector.push(extData);
	}, 600_000);

	it('fetches only the covering frames for a small range', async () => {
		ipfsClient.reset();
		const start = 5 * MB + 777;
		const len = 2 * KB;

		expectSameBytes(
			await extVector.readRange(0, start, len),
			extData.subarray(start, start + len)
		);

		// The saving this exists for: an 8 MB payload, and a 2 KB read touches one 64 KiB
		// frame. Before ranged fetches the whole blob came down to read its header alone.
		expect(ipfsClient.stats.wholeReads).toBe(0);
		expect(ipfsClient.stats.bytesRead).toBeLessThan(128 * KB);
	}, 300_000);

	it('reads the layout header without downloading the payload', async () => {
		const fresh = new Mnemonad(
			baseParams({ id: extVector.id, signer: clients.walletClient, ipfsClient })
		);
		ipfsClient.reset();

		expect(await fresh.plaintextLengthAt(0)).toBe(extData.length);

		// The ciphertext length comes from the on-chain pointer; only the 10-byte header is
		// fetched. Deriving it by downloading 8 MB would defeat every partial read.
		expect(ipfsClient.stats.wholeReads).toBe(0);
		expect(ipfsClient.stats.bytesRead).toBeLessThan(1 * KB);
	}, 120_000);

	it('streams a window without pulling the whole payload', async () => {
		const fresh = new Mnemonad(
			baseParams({ id: extVector.id, signer: clients.walletClient, ipfsClient })
		);
		ipfsClient.reset();

		const start = 1 * MB;
		const len = 100 * KB;
		const parts = [];
		for await (const piece of fresh.stream(0, { start, len })) parts.push(piece);

		const joined = Buffer.concat(parts.map((p) => Buffer.from(p)));
		expect(joined.equals(Buffer.from(extData.subarray(start, start + len)))).toBe(true);
		expect(ipfsClient.stats.wholeReads).toBe(0);
		expect(ipfsClient.stats.bytesRead).toBeLessThan(300 * KB);
	}, 300_000);

	it('still verifies the blob hash on a full read', async () => {
		const fresh = new Mnemonad(
			baseParams({ id: extVector.id, signer: clients.walletClient, ipfsClient })
		);
		ipfsClient.reset();

		expectSameBytes(new Uint8Array(await fresh.at(0)), extData);

		// A whole-item read goes back to a single verified fetch — cheaper than one request
		// per frame, and it puts the pointer hash back in play.
		expect(ipfsClient.stats.wholeReads).toBe(1);
	}, 600_000);

	it('rejects a tampered frame served over a ranged fetch', async () => {
		const tampered = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient: tampered });
		const data = makeBytes(1 * MB, 92);
		await ev.push(data);

		const pointer = await ev.pointerAt(0);
		const corrupted = new Uint8Array(tampered.store.get(pointer.locator));
		corrupted[20_000] ^= 0xff; // inside frame 0's ciphertext
		tampered.store.set(pointer.locator, corrupted);

		const fresh = new Mnemonad(
			baseParams({ id: ev.id, signer: clients.walletClient, ipfsClient: tampered })
		);
		// A ranged fetch cannot be checked against the whole-blob hash — but it does not
		// need to be. The frame's own GCM tag catches this.
		await expect(fresh.readRange(0, 0, 1_024)).rejects.toThrow();
	}, 300_000);

	it('works correctly against a transport with no ranged support', async () => {
		const noRange = makeMockIpfs({ noRange: true });
		const ev = await createEncrypted({ ipfsClient: noRange });
		const data = makeBytes(512 * KB, 93);
		await ev.push(data);

		const fresh = new Mnemonad(
			baseParams({ id: ev.id, signer: clients.walletClient, ipfsClient: noRange })
		);

		// Falls back to whole-payload fetches: correct, just not cheap.
		expectSameBytes(
			await fresh.readRange(0, 1_000, 500),
			data.subarray(1_000, 1_500)
		);
		expect(noRange.stats.wholeReads).toBeGreaterThan(0);
	}, 300_000);
});
