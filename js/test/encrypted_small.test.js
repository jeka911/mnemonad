import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * Encryption at small sizes — key handling, tier interaction and the security properties.
 *
 * Split from `encrypted_large` / `encrypted_huge` because the interesting failures differ
 * by scale: here it is key derivation, nonce reuse and tier routing; there it is chunk
 * thresholds and paged reassembly.
 */

let node;
let clients;
let contractAddress;

/** Small ceiling: enough to exercise both the SLOT and CODE tiers under encryption. */
const MAX_CHUNK = 2_000;

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

/** A writable, encrypted stream owned by account 0. */
function createEncrypted(extra = {}) {
	return Mnemonad.create(
		baseParams({ encrypt: true, signer: clients.walletClient, ...extra })
	);
}

describe('creation and key material', () => {
	it('creates an encrypted stream in a single transaction', async () => {
		const ev = await createEncrypted();

		expect(await ev.isEncrypted()).toBe(true);
		expect(ev.encKeyWrapped.length).toBeGreaterThan(0);
		// The wrapped key is nonce(12) + 32-byte key + tag(16).
		expect(ev.encKeyWrapped.length).toBe(12 + 32 + 16);
	});

	it('creates encrypted with initial items already ciphertext', async () => {
		const items = [makeBytes(40, 1), makeBytes(41, 2)];
		const ev = await createEncrypted({ array: items });

		await ev.initialize();
		expect(ev.length).toBe(2);
		expect(new Uint8Array(await ev.at(0))).toEqual(items[0]);
		expect(new Uint8Array(await ev.at(1))).toEqual(items[1]);
		// Each item carries framing overhead: 10-byte header + one 16-byte tag per frame.
		expect(ev.binaryLength).toBe(
			cipherLen(items[0].length) + cipherLen(items[1].length)
		);
	});

	it('round-trips a key through wrap and unwrap', async () => {
		const ev = await Mnemonad.create(baseParams());
		const crypto = new MnemonadCrypto({
			mnemonad: ev,
			signer: clients.walletClient,
		});

		const key = MnemonadCrypto.generateAesKey();
		expect(key.length).toBe(32);

		const wrapped = await crypto.wrapAesKey(key, ev.id);
		expect(new Uint8Array(wrapped)).not.toEqual(key);
		expect(new Uint8Array(await crypto.unwrapAesKey(wrapped, ev.id))).toEqual(key);
	});

	it('derives a distinct key per stream for the same signer', async () => {
		const a = await createEncrypted();
		const b = await createEncrypted();
		await a.initialize();
		await b.initialize();

		// The KEK binds the stream id, so one wallet's streams are not cross-readable
		// even though they share a signing key.
		expect(Buffer.from(a.encKeyWrapped)).not.toEqual(Buffer.from(b.encKeyWrapped));
	});

	it('rejects an unwrap by the wrong signer', async () => {
		const { createWalletClient, http } = await import('viem');
		const { getChain, getRpcUrl } = await import('./fixture.js');

		const ev = await createEncrypted();
		await ev.push(makeBytes(100, 1));

		const otherWallet = createWalletClient({
			chain: getChain(),
			transport: http(getRpcUrl()),
			account: clients.accounts[1],
		});

		// A different signer derives a different KEK, so the GCM tag on the wrapped key
		// fails to verify. This is what "owner-bound" means in practice.
		const asOther = new Mnemonad(baseParams({ id: ev.id, signer: otherWallet }));
		await expect(asOther.at(0)).rejects.toThrow();
	});

	it('replaces the key on rewrap', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.setEncKeyWrapped(new Uint8Array([1, 2, 3]));
		await ev.initialize();
		expect(new Uint8Array(ev.encKeyWrapped)).toEqual(new Uint8Array([1, 2, 3]));

		// Owner-may-rewrap, not write-once.
		await ev.setEncKeyWrapped(new Uint8Array([4, 5, 6, 7]));
		await ev.initialize();
		expect(new Uint8Array(ev.encKeyWrapped)).toEqual(new Uint8Array([4, 5, 6, 7]));
	});
});

describe('ciphertext properties', () => {
	it('stores ciphertext, never plaintext', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(300, 1);
		await ev.push(data);

		const raw = await ev._atRaw(0);
		expect(new Uint8Array(raw)).not.toEqual(data);
		expect(raw.length).toBe(cipherLen(data.length));
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('produces different ciphertext for identical plaintext', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(200, 5);

		await ev.push(data);
		await ev.push(data);

		const a = await ev._atRaw(0);
		const b = await ev._atRaw(1);
		// A fresh random nonce per item. Reusing a nonce under one key would be
		// catastrophic for GCM, so this property is worth pinning down.
		expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
		// Base nonces live at header bytes 2..10 and must differ per item.
		expect(a.subarray(2, 10)).not.toEqual(b.subarray(2, 10));

		// Both still decrypt to the same plaintext.
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
		expect(new Uint8Array(await ev.at(1))).toEqual(data);
	});

	it('fails authentication on tampered ciphertext', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(100, 1);
		const ct = await ev.crypto.encryptItem(data);

		const flipped = new Uint8Array(ct);
		flipped[40] ^= 0xff;

		// GCM is authenticated: a single flipped byte must fail, not decrypt to garbage.
		await expect(ev.crypto.decryptItem(flipped)).rejects.toThrow();
	});

	it('rejects a payload too short to be valid ciphertext', async () => {
		const ev = await createEncrypted();
		await expect(ev.crypto.decryptItem(new Uint8Array(10))).rejects.toThrow(/too short/);
	});

	it('leaves item metadata unencrypted', async () => {
		const ev = await createEncrypted();
		const meta = makeBytes(8, 9);
		await ev.push(makeBytes(100, 1), { itemMeta: meta });

		const item = await ev.itemAt(0);
		// Only payloads are encrypted. Metadata is plaintext on-chain — worth asserting so
		// nobody assumes otherwise and puts something sensitive there.
		expect(new Uint8Array(item.meta)).toEqual(meta);
	});
});

describe('tier routing under encryption', () => {
	it('keeps a tiny item in the SLOT tier when its ciphertext still fits', async () => {
		const ev = await createEncrypted();
		// 5 bytes + 26 overhead = 31, exactly the SLOT ceiling.
		const data = makeBytes(5, 1);
		await ev.push(data);

		expect((await ev.itemAt(0)).storeName).toBe('slot');
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('pushes a small item into the CODE tier once overhead crosses 31 bytes', async () => {
		const ev = await createEncrypted();
		// 6 bytes + 26 = 32, one past the SLOT ceiling. The tier is chosen from the
		// CIPHERTEXT size, which is why encryption happens before routing.
		const data = makeBytes(6, 1);
		await ev.push(data);

		expect((await ev.itemAt(0)).storeName).toBe('code');
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('rejects a plaintext that only exceeds the chunk ceiling once encrypted', async () => {
		const ev = await createEncrypted();
		// Exactly maxChunkBytes as plaintext, maxChunkBytes + 28 as ciphertext. Routing on
		// plaintext size would have accepted this and then failed on-chain.
		await expect(ev.push(makeBytes(MAX_CHUNK, 1))).rejects.toThrow(/exceeds maxChunkBytes/);
	});

	it('accepts the largest plaintext that still fits after overhead', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(MAX_CHUNK - 26, 1);
		await ev.push(data);

		await ev.initialize();
		expect(ev.binaryLength).toBe(MAX_CHUNK);
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});
});

describe('every write path encrypts', () => {
	it('encrypts a packed batch pushed via pushMany', async () => {
		const ev = await createEncrypted();
		const items = [makeBytes(100, 1), makeBytes(150, 2), makeBytes(70, 3)];

		// Called directly, not via push(). Encryption must not depend on which entrypoint
		// the caller happens to use.
		await ev.pushMany(items);

		await ev.initialize();
		expect(ev.length).toBe(3);
		for (let i = 0; i < items.length; i += 1) {
			const raw = await ev._atRaw(i);
			expect(raw.length).toBe(cipherLen(items[i].length));
			expect(Buffer.from(raw)).not.toEqual(Buffer.from(items[i]));
			expect(new Uint8Array(await ev.at(i))).toEqual(items[i]);
		}
	});

	it('encrypts before an explicit pushExternal', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		const data = makeBytes(500, 4);

		await ev.pushExternal(data);

		const pointer = await ev.pointerAt(0);
		const stored = ipfsClient.store.get(pointer.locator);
		expect(stored.length).toBe(cipherLen(data.length));
		expect(Buffer.from(stored)).not.toEqual(Buffer.from(data));
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('does not double-encrypt when push() delegates to a batch', async () => {
		const ev = await createEncrypted();
		const items = [makeBytes(60, 1), makeBytes(60, 2)];

		// push() with an array delegates to pushMany; the payloads must be encrypted once.
		await ev.push(items);

		const raw = await ev._atRaw(0);
		expect(raw.length).toBe(cipherLen(60)); // not double-encrypted
		expect(new Uint8Array(await ev.at(0))).toEqual(items[0]);
	});
});

describe('reading without the key', () => {
	it('returns ciphertext to a reader with no signer', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(100, 4);
		await ev.push(data);

		const noSigner = new Mnemonad(baseParams({ id: ev.id }));
		const read = await noSigner.at(0);
		expect(Buffer.from(read)).not.toEqual(Buffer.from(data));
		expect(read.length).toBe(cipherLen(data.length));
	});

	it('unwraps from chain state in a fresh instance', async () => {
		const created = await createEncrypted();
		const data = makeBytes(200, 3);
		await created.push(data);

		// No cached key: the KEK is re-derived from a signature and encKeyWrapped is read
		// back from chain.
		const reopened = new Mnemonad(
			baseParams({ id: created.id, signer: clients.walletClient })
		);
		expect(new Uint8Array(await reopened.at(0))).toEqual(data);
	});

	it('decrypts with a directly supplied data key and no signer', async () => {
		const created = await createEncrypted();
		const data = makeBytes(150, 6);
		await created.push(data);

		// Handing over the unwrapped key is the only sharing mechanism v1 offers — there
		// is no delegation, so an out-of-band key is how a second party reads.
		const key = created.crypto.getAesKey();
		expect(key).toBeTruthy();

		const withKey = new Mnemonad(baseParams({ id: created.id, aesKey: key }));
		expect(new Uint8Array(await withKey.at(0))).toEqual(data);
	});
});

describe('encrypted streams and ownership', () => {
	it('blocks transfer while a key is set', async () => {
		const { mnemonadAbi } = await import('../abi.js');
		const ev = await createEncrypted();

		// A self-wrapped key is bound to its owner, so the recipient could never decrypt.
		// Blocking is the honest behaviour until the propose/accept rewrap flow exists.
		await expect(
			clients.walletClient.writeContract({
				address: contractAddress,
				abi: mnemonadAbi,
				functionName: 'transferFrom',
				args: [clients.account.address, clients.accounts[1].address, ev.id],
			})
		).rejects.toThrow();
	});

	it('allows transfer once the key is cleared', async () => {
		const { mnemonadAbi } = await import('../abi.js');
		const ev = await createEncrypted();
		await ev.setEncKeyWrapped(new Uint8Array());

		const hash = await clients.walletClient.writeContract({
			address: contractAddress,
			abi: mnemonadAbi,
			functionName: 'transferFrom',
			args: [clients.account.address, clients.accounts[1].address, ev.id],
		});
		await clients.publicClient.waitForTransactionReceipt({ hash });
		expect(await ev.owner()).toBe(clients.accounts[1].address);
	});

	it('allows burning an encrypted stream', async () => {
		const ev = await createEncrypted();
		await ev.push(makeBytes(100, 1));
		await ev.burn();
		await expect(ev.initialize()).rejects.toThrow();
	});

	it('refuses to concat an encrypted stream', async () => {
		const dst = await Mnemonad.create(baseParams());
		const src = await createEncrypted();

		// Each stream is keyed independently, so their items cannot be merged under one key.
		await expect(dst.concat(src)).rejects.toThrow();
	});
});

describe('offloadCommitment', () => {
	/**
	 * The value prepaid through `MnemonadUploadGateway` has to be byte-identical to the
	 * `Pointer.hash` the registry later settles against. If the two ever disagree the escrow
	 * silently fails to settle and sits until it expires, so this asserts they agree against
	 * a real offloaded push rather than trusting the arithmetic.
	 */
	it('matches the Pointer hash an offloaded push actually records', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		const data = makeBytes(MAX_CHUNK * 2, 7); // oversized, so it routes off-chain

		const commitment = await ev.offloadCommitment(data);
		await ev.push(data);

		const pointer = await ev.pointerAt(0);
		expect(pointer.hash.toLowerCase()).toBe(commitment.hash.toLowerCase());
		expect(Number(pointer.size)).toBe(commitment.size);
	});

	it('refuses on an encrypted stream rather than committing an unmatchable hash', async () => {
		const ev = await createEncrypted();
		// Encryption draws a fresh nonce per call, so no hash computed in advance can match
		// the ciphertext push() will upload. Failing loudly beats escrowing MON against a
		// commitment the registry will never settle.
		await expect(ev.offloadCommitment(makeBytes(100, 8))).rejects.toThrow(/encrypted/i);
	});

	/**
	 * The `alreadyEncrypted` escape hatch: encrypt once client-side, commit to *that*
	 * ciphertext, then push it as-is. Proves the whole point of the mechanism — the
	 * committed hash and the hash `pushExternal` actually records must be identical, or
	 * gateway settlement would never find a matching escrow.
	 */
	it('matches when the caller pre-encrypts and commits to the ciphertext', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await createEncrypted({ ipfsClient });
		const plaintext = makeBytes(MAX_CHUNK * 2, 8); // oversized, so it routes off-chain

		const ciphertext = await ev.crypto.encryptItem(plaintext);
		const commitment = await ev.offloadCommitment(ciphertext, { alreadyEncrypted: true });
		await ev.pushExternal(ciphertext, { alreadyEncrypted: true });

		const pointer = await ev.pointerAt(0);
		expect(pointer.hash.toLowerCase()).toBe(commitment.hash.toLowerCase());
		expect(Number(pointer.size)).toBe(commitment.size);
		expect(Number(pointer.size)).toBe(ciphertext.length);
		// And it still reads back correctly — pre-encrypting by hand didn't bypass framing.
		expect(new Uint8Array(await ev.at(0))).toEqual(plaintext);
	});

	it('still refuses without alreadyEncrypted even if the caller happens to pass ciphertext', async () => {
		const ev = await createEncrypted();
		const ciphertext = await ev.crypto.encryptItem(makeBytes(50, 9));
		// The guard is about the *option*, not about guessing whether `data` looks like
		// ciphertext — omitting it should still refuse, so a caller can't get lucky/unlucky
		// depending on what bytes they happened to pass.
		await expect(ev.offloadCommitment(ciphertext)).rejects.toThrow(/encrypted/i);
	});

	it('reports the plaintext size and hash on an unencrypted stream', async () => {
		const { sha256 } = await import('@noble/hashes/sha2.js');
		const ev = await Mnemonad.create(baseParams());
		const data = makeBytes(500, 9);

		const c = await ev.offloadCommitment(data);
		const expected = '0x' + Array.from(sha256(data), (b) => b.toString(16).padStart(2, '0')).join('');
		expect(c.hash).toBe(expected);
		expect(c.size).toBe(data.length);
	});
});
