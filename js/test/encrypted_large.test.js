import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * Encryption at large sizes — where the 28-byte AES-GCM overhead starts interacting with
 * chunk thresholds and the staged-append path.
 *
 * Sizes here stay under what a single `at()` can return, so reads are one-shot. Paged
 * reads of encrypted items are `encrypted_huge.test.js`.
 */

let node;
let clients;
let contractAddress;

/** Realistic ceiling, just under the local EIP-170 code limit. */
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

describe('staged on-chain encrypted items', () => {
	it('stores 64 KB across chunks and decrypts on read', async () => {
		const ev = await createEncrypted();
		const size = 64 * KB;
		const data = makeBytes(size, 1);

		await ev.push(data, { onChain: true });

		await ev.initialize();
		expect(ev.length).toBe(1);
		expect(ev.binaryLength).toBe(cipherLen(size));

		const refs = await ev.getItemRefs(0);
		// Chunk count follows the CIPHERTEXT length, not the plaintext.
		expect(refs.chunks.length).toBe(Math.ceil(cipherLen(size) / MAX_CHUNK));
		expect(refs.size).toBe(cipherLen(size));

		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 180_000);

	it('stores 256 KB and decrypts byte-exactly', async () => {
		const ev = await createEncrypted();
		const size = 256 * KB;
		const data = makeBytes(size, 2);

		await ev.push(data, { onChain: true });

		await ev.initialize();
		expect(ev.binaryLength).toBe(cipherLen(size));
		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 300_000);

	it('crosses a chunk boundary purely because of encryption overhead', async () => {
		const ev = await createEncrypted();
		// Plaintext fits one chunk exactly; ciphertext does not. The staged path must
		// therefore produce two chunks where an unencrypted push would produce one.
		const data = makeBytes(MAX_CHUNK, 3);

		await ev.push(data, { onChain: true });

		const refs = await ev.getItemRefs(0);
		expect(refs.chunks.length).toBe(2);
		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 120_000);

	it('keeps several large encrypted items independently readable', async () => {
		const ev = await createEncrypted();
		const a = makeBytes(40 * KB, 4);
		const b = makeBytes(50 * KB, 5);

		await ev.push(a, { onChain: true });
		await ev.push(b, { onChain: true });

		await ev.initialize();
		expect(ev.length).toBe(2);
		expect(ev.binaryLength).toBe(cipherLen(a.length) + cipherLen(b.length));

		// Each item carries its own nonce, so neither key nor nonce is shared across items.
		expectSameBytes(new Uint8Array(await ev.at(0)), a);
		expectSameBytes(new Uint8Array(await ev.at(1)), b);
	}, 300_000);
});

describe('encrypted items offloaded to IPFS', () => {
	it('pins ciphertext only for a 1 MB payload', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		const size = 1024 * KB;
		const data = makeBytes(size, 6);

		await ev.push(data);

		const item = await ev.itemAt(0);
		expect(item.isExternal).toBe(true);

		const pointer = await ev.pointerAt(0);
		const stored = ipfsClient.store.get(pointer.locator);
		expect(stored.length).toBe(cipherLen(size));
		// Spot-check the head rather than compare a megabyte twice over.
		expect(Buffer.from(stored.subarray(0, 4096)).equals(Buffer.from(data.subarray(0, 4096))))
			.toBe(false);

		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 240_000);

	it('records the ciphertext hash, so tampering is caught before decryption', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		const data = makeBytes(64 * KB, 7);

		await ev.push(data);
		const pointer = await ev.pointerAt(0);

		// Two independent guards stack here: the pointer hash catches substitution at the
		// gateway, and GCM's tag would catch it again at decryption. The hash fires first,
		// giving a clearer error than an auth failure.
		ipfsClient.corrupt(pointer.locator, makeBytes(cipherLen(data.length), 99));
		await expect(ev.at(0)).rejects.toThrow(/hash mismatch/);
	}, 120_000);

	it('routes to IPFS rather than failing when overhead crosses the ceiling', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		// Plaintext fits a chunk, ciphertext does not — with IPFS configured this becomes
		// an external item instead of an error.
		const data = makeBytes(MAX_CHUNK, 8);

		await ev.push(data);

		expect((await ev.itemAt(0)).storeName).toBe('external');
		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 120_000);

	it('prefers on-chain staging when asked, even with IPFS available', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		const data = makeBytes(32 * KB, 9);

		await ev.push(data, { onChain: true });

		expect((await ev.itemAt(0)).storeName).toBe('code');
		expect(ipfsClient.store.size).toBe(0);
		expectSameBytes(new Uint8Array(await ev.at(0)), data);
	}, 120_000);
});

describe('large encrypted batches', () => {
	it('encrypts every item of a packed batch near the chunk ceiling', async () => {
		const ev = await createEncrypted();
		const count = 20;
		// Leave room for 28 bytes of overhead per item inside one shared chunk.
		const each = Math.floor(MAX_CHUNK / count) - 26;
		const items = Array.from({ length: count }, (_, i) => makeBytes(each, (i % 250) + 1));

		await ev.pushMany(items);

		await ev.initialize();
		expect(ev.length).toBe(count);
		expect(ev.binaryLength).toBe(count * cipherLen(each));

		const first = await ev.getItemRefs(0);
		const last = await ev.getItemRefs(count - 1);
		// Still packed into a single deployment despite per-item overhead.
		expect(last.chunks[0]).toBe(first.chunks[0]);

		for (let i = 0; i < count; i += 1) {
			expectSameBytes(new Uint8Array(await ev.at(i)), items[i]);
		}
	}, 240_000);

	it('rejects a batch that only overflows once encrypted', async () => {
		const ev = await createEncrypted();
		// Each item fits alone; with overhead one of them exceeds the chunk ceiling.
		await expect(
			ev.pushMany([makeBytes(100, 1), makeBytes(MAX_CHUNK - 10, 2)])
		).rejects.toThrow(/exceeds maxChunkBytes/);
	}, 60_000);
});
