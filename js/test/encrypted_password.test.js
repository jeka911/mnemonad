import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * Password-based key derivation — the second KEK method alongside the signature-based one
 * covered in `encrypted_small.test.js`. Deliberately narrow: `wrapAesKey`/`unwrapAesKey` and
 * every item-encryption path (`encryptItem`/`decryptItem`, tier routing, framing) are already
 * proven there and do not care which method produced the data key, so this file only
 * exercises what's actually new — `_deriveKekFromPassword`, salt handling, and the fact that
 * every write path still encrypts when the *method* is a password instead of a signer.
 *
 * Iteration counts are overridden low (`TEST_ITERATIONS`) purely so the suite runs fast — the
 * derivation math is identical at any iteration count, and the real default
 * (`MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS`) is asserted directly rather than exercised
 * 600,000 times per test.
 */

let node;
let clients;
let contractAddress;

const MAX_CHUNK = 2_000;
const TEST_ITERATIONS = 100;
const PASSWORD = 'correct horse battery staple';

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
}, 180_000);

afterAll(async () => {
	await node?.stop();
});

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

/** A writable, password-encrypted stream. */
function createEncrypted(extra = {}) {
	return Mnemonad.create(
		baseParams({
			encrypt: true,
			password: PASSWORD,
			passwordIterations: TEST_ITERATIONS,
			...extra,
		})
	);
}

describe('password validation', () => {
	it('rejects an empty password at construction', async () => {
		const ev = new Mnemonad(baseParams());
		expect(
			() =>
				new MnemonadCrypto({
					mnemonad: ev,
					password: '',
					passwordIterations: TEST_ITERATIONS,
				})
		).toThrow(/password must not be empty/);
	});

	it('rejects an empty password passed through Mnemonad', () => {
		expect(() => new Mnemonad(baseParams({ password: '' }))).toThrow(/password must not be empty/);
	});

	it('rejects create() with an empty password', async () => {
		await expect(
			createEncrypted({ password: '' })
		).rejects.toThrow(/password must not be empty/);
	});

	it('leaves password mode inactive when password is omitted entirely', async () => {
		const ev = new Mnemonad(baseParams());
		expect(ev.crypto.isEnabled).toBe(false);
	});
});

describe('creation and key material', () => {
	it('creates a password-encrypted stream in a single transaction', async () => {
		const ev = await createEncrypted();

		expect(await ev.isEncrypted()).toBe(true);
		// Same wrapped-key layout as the signature method: nonce(12) + key(32) + tag(16).
		expect(ev.encKeyWrapped.length).toBe(12 + 32 + 16);
	});

	it('creates encrypted with initial items already ciphertext', async () => {
		const items = [makeBytes(40, 1), makeBytes(41, 2)];
		const ev = await createEncrypted({ array: items });

		await ev.initialize();
		expect(ev.length).toBe(2);
		expect(new Uint8Array(await ev.at(0))).toEqual(items[0]);
		expect(new Uint8Array(await ev.at(1))).toEqual(items[1]);
	});

	it('generates a salt lazily when none is supplied', async () => {
		const ev = new Mnemonad(baseParams());
		const crypto = new MnemonadCrypto({
			mnemonad: ev,
			password: PASSWORD,
			passwordIterations: TEST_ITERATIONS,
		});
		expect(crypto.getPasswordSalt()).toBeNull();

		const key = MnemonadCrypto.generateAesKey();
		await crypto.wrapAesKey(key, 0n);

		const salt = crypto.getPasswordSalt();
		expect(salt).toBeInstanceOf(Uint8Array);
		expect(salt.length).toBe(16);
	});

	it('accepts a caller-supplied salt as either bytes or hex', async () => {
		const salt = MnemonadCrypto.generatePasswordSalt();
		const hex = MnemonadCrypto.saltToHex(salt);

		const evBytes = new Mnemonad(baseParams());
		const cryptoBytes = new MnemonadCrypto({
			mnemonad: evBytes,
			password: PASSWORD,
			passwordSalt: salt,
			passwordIterations: TEST_ITERATIONS,
		});
		expect(cryptoBytes.getPasswordSalt()).toEqual(salt);

		const evHex = new Mnemonad(baseParams());
		const cryptoHex = new MnemonadCrypto({
			mnemonad: evHex,
			password: PASSWORD,
			passwordSalt: hex,
			passwordIterations: TEST_ITERATIONS,
		});
		expect(cryptoHex.getPasswordSalt()).toEqual(salt);

		// Same password + same salt + same iterations must derive the same KEK, whichever
		// input form the salt arrived in.
		const key = MnemonadCrypto.generateAesKey();
		const wrapped = await cryptoBytes.wrapAesKey(key, 0n);
		expect(new Uint8Array(await cryptoHex.unwrapAesKey(wrapped, 0n))).toEqual(key);
	});

	it('round-trips a key through wrap and unwrap with an explicit salt', async () => {
		const ev = await Mnemonad.create(baseParams());
		const salt = MnemonadCrypto.generatePasswordSalt();
		const crypto = new MnemonadCrypto({
			mnemonad: ev,
			password: PASSWORD,
			passwordSalt: salt,
			passwordIterations: TEST_ITERATIONS,
		});

		const key = MnemonadCrypto.generateAesKey();
		const wrapped = await crypto.wrapAesKey(key, ev.id);
		expect(new Uint8Array(wrapped)).not.toEqual(key);
		expect(new Uint8Array(await crypto.unwrapAesKey(wrapped, ev.id))).toEqual(key);
	});

	it('derives a distinct KEK per stream even for the same password', async () => {
		// Unlike the signature method (which binds the stream id into the signed message),
		// separation here comes entirely from each stream generating its own random salt.
		const a = await createEncrypted();
		const b = await createEncrypted();
		await a.initialize();
		await b.initialize();

		expect(Buffer.from(a.encKeyWrapped)).not.toEqual(Buffer.from(b.encKeyWrapped));
		expect(Buffer.from(a.crypto.getPasswordSalt())).not.toEqual(
			Buffer.from(b.crypto.getPasswordSalt())
		);
	});

	it('rejects an unwrap with the wrong password', async () => {
		const ev = await createEncrypted();
		await ev.push(makeBytes(100, 1));

		const wrongPassword = new Mnemonad(
			baseParams({
				id: ev.id,
				password: 'not the right password',
				passwordSalt: ev.crypto.getPasswordSalt(),
				passwordIterations: TEST_ITERATIONS,
			})
		);
		await expect(wrongPassword.at(0)).rejects.toThrow();
	});

	it('rejects an unwrap with the right password but the wrong salt', async () => {
		const ev = await createEncrypted();
		await ev.push(makeBytes(100, 1));

		const wrongSalt = new Mnemonad(
			baseParams({
				id: ev.id,
				password: PASSWORD,
				passwordSalt: MnemonadCrypto.generatePasswordSalt(), // fresh, unrelated salt
				passwordIterations: TEST_ITERATIONS,
			})
		);
		await expect(wrongSalt.at(0)).rejects.toThrow();
	});

	it('rejects an unwrap with the right password and salt but the wrong iteration count', async () => {
		const ev = await createEncrypted();
		await ev.push(makeBytes(100, 1));

		const wrongIterations = new Mnemonad(
			baseParams({
				id: ev.id,
				password: PASSWORD,
				passwordSalt: ev.crypto.getPasswordSalt(),
				passwordIterations: TEST_ITERATIONS + 1,
			})
		);
		await expect(wrongIterations.at(0)).rejects.toThrow();
	});

	it('replaces the key on rewrap', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.setEncKeyWrapped(new Uint8Array([1, 2, 3]));
		await ev.initialize();
		expect(new Uint8Array(ev.encKeyWrapped)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('exposes 600,000 as the shipped default iteration count', () => {
		expect(MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS).toBe(600_000);
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
		expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
		expect(new Uint8Array(await ev.at(1))).toEqual(data);
	});
});

describe('tier routing under password encryption', () => {
	it('keeps a tiny item in the SLOT tier when its ciphertext still fits', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(5, 1);
		await ev.push(data);

		expect((await ev.itemAt(0)).storeName).toBe('slot');
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('pushes a small item into the CODE tier once overhead crosses 31 bytes', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(6, 1);
		await ev.push(data);

		expect((await ev.itemAt(0)).storeName).toBe('code');
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});
});

describe('every write path encrypts under password mode', () => {
	it('encrypts a packed batch pushed via pushMany', async () => {
		const ev = await createEncrypted();
		const items = [makeBytes(100, 1), makeBytes(150, 2), makeBytes(70, 3)];

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
});

describe('reading without the key', () => {
	it('returns ciphertext to a reader with no password', async () => {
		const ev = await createEncrypted();
		const data = makeBytes(100, 4);
		await ev.push(data);

		const noPassword = new Mnemonad(baseParams({ id: ev.id }));
		const read = await noPassword.at(0);
		expect(Buffer.from(read)).not.toEqual(Buffer.from(data));
		expect(read.length).toBe(cipherLen(data.length));
	});

	it('unwraps from chain state in a fresh instance given password + salt', async () => {
		const created = await createEncrypted();
		const data = makeBytes(200, 3);
		await created.push(data);

		// No cached key: the KEK is re-derived from the password and encKeyWrapped is read
		// back from chain. The salt has to come from somewhere other than the chain itself
		// (this class never reads stream metadata) — here, straight from the creator.
		const reopened = new Mnemonad(
			baseParams({
				id: created.id,
				password: PASSWORD,
				passwordSalt: created.crypto.getPasswordSalt(),
				passwordIterations: TEST_ITERATIONS,
			})
		);
		expect(new Uint8Array(await reopened.at(0))).toEqual(data);
	});

	it('decrypts with a directly supplied data key and neither signer nor password', async () => {
		const created = await createEncrypted();
		const data = makeBytes(150, 6);
		await created.push(data);

		const key = created.crypto.getAesKey();
		expect(key).toBeTruthy();

		const withKey = new Mnemonad(baseParams({ id: created.id, aesKey: key }));
		expect(new Uint8Array(await withKey.at(0))).toEqual(data);
	});
});

describe('unlockWithPassword', () => {
	it('unlocks a fresh instance opened with no password at all, in place', async () => {
		const created = await createEncrypted();
		const data = makeBytes(200, 3);
		await created.push(data);

		// No password/salt/aesKey given at construction — exactly the "load read-only
		// first, unlock later once the user types a password" shape a UI actually uses,
		// unlike the constructor-time password already covered above.
		const reader = new Mnemonad(baseParams({ id: created.id }));
		expect(reader.crypto.isEnabled).toBe(false);
		expect(Buffer.from(await reader.at(0))).not.toEqual(Buffer.from(data));

		const key = await reader.unlockWithPassword(PASSWORD, {
			passwordSalt: created.crypto.getPasswordSalt(),
			passwordIterations: TEST_ITERATIONS,
		});

		expect(reader.crypto.isEnabled).toBe(true);
		expect(new Uint8Array(reader.crypto.getAesKey())).toEqual(new Uint8Array(key));
		expect(new Uint8Array(await reader.at(0))).toEqual(data);
	});

	it('rejects a wrong password without adopting anything', async () => {
		const created = await createEncrypted();
		await created.push(makeBytes(50, 1));

		const reader = new Mnemonad(baseParams({ id: created.id }));
		await expect(
			reader.unlockWithPassword('not the right password', {
				passwordSalt: created.crypto.getPasswordSalt(),
				passwordIterations: TEST_ITERATIONS,
			})
		).rejects.toThrow();

		// The failed attempt must not have left a key installed — still ciphertext.
		expect(reader.crypto.isEnabled).toBe(false);
		expect(Buffer.from(await reader.at(0))).not.toEqual(Buffer.from(makeBytes(50, 1)));
	});

	it('rejects the right password with the wrong salt', async () => {
		const created = await createEncrypted();
		await created.push(makeBytes(50, 1));

		const reader = new Mnemonad(baseParams({ id: created.id }));
		await expect(
			reader.unlockWithPassword(PASSWORD, {
				passwordSalt: MnemonadCrypto.generatePasswordSalt(), // fresh, unrelated salt
				passwordIterations: TEST_ITERATIONS,
			})
		).rejects.toThrow();
		expect(reader.crypto.isEnabled).toBe(false);
	});

	it('throws for a stream with no wrapped key at all', async () => {
		const plain = await Mnemonad.create(baseParams());
		await expect(
			plain.unlockWithPassword(PASSWORD, { passwordSalt: MnemonadCrypto.generatePasswordSalt() })
		).rejects.toThrow(/no wrapped key/);
	});
});

describe('password-encrypted streams and ownership', () => {
	it('blocks transfer while a key is set, same as the signature method', async () => {
		const { mnemonadAbi } = await import('../abi.js');
		const ev = await createEncrypted();

		await expect(
			clients.walletClient.writeContract({
				address: contractAddress,
				abi: mnemonadAbi,
				functionName: 'transferFrom',
				args: [clients.account.address, clients.accounts[1].address, ev.id],
			})
		).rejects.toThrow();
	});

	it('allows burning a password-encrypted stream', async () => {
		const ev = await createEncrypted();
		await ev.push(makeBytes(100, 1));
		await ev.burn();
		await expect(ev.initialize()).rejects.toThrow();
	});
});
