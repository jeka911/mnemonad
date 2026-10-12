import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createWalletClient, http } from 'viem';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { kekMethodOf } from '../streamMeta.js';
import { startNode, makeClients, deployRegistry, makeBytes, getChain, getRpcUrl } from './fixture.js';

/**
 * Passkey-based key derivation — the third KEK method. The SDK never runs WebAuthn itself;
 * it calls a provider's `evaluate(salt)` and treats the 32 bytes that come back as PRF
 * output. So a fake passkey here is just HMAC-SHA256 under a fixed secret: deterministic per
 * (secret, salt), different for a different secret — the two properties a real PRF has that
 * this method relies on.
 *
 * Like `encrypted_password.test.js`, this only covers what's new: the derivation, the
 * metadata it publishes, unlocking, and that the wallet plays no part. Item encryption
 * itself doesn't care which method produced the data key and is proven elsewhere.
 */

let node;
let clients;
let contractAddress;

const RP_ID = 'mnemonad.example';

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: 2_000 });
}, 180_000);

afterAll(async () => {
	await node?.stop();
});

/**
 * A stand-in passkey. `calls` records every salt it was asked to evaluate. With
 * `pickedId`, it behaves like a ceremony that picks (or creates) the passkey and reports
 * which one, the way the create flow does.
 */
function fakePasskey(secret, { credentialId = null, pickedId = null } = {}) {
	const key = new TextEncoder().encode(secret);
	const calls = [];
	return {
		rpId: RP_ID,
		credentialId,
		calls,
		async evaluate(salt) {
			calls.push(salt);
			const output = hmac(sha256, key, salt);
			return pickedId ? { output, credentialId: pickedId } : output;
		},
	};
}

function baseParams(extra = {}) {
	return {
		publicClient: clients.publicClient,
		walletClient: clients.walletClient,
		contractAddress,
		...extra,
	};
}

/** `create()` marks the instance stale; `initialize()` reloads the `meta` that
 *  `streamMeta` decodes. */
async function createWithPasskey(passkey, extra = {}) {
	const ev = await Mnemonad.create(baseParams({ encrypt: true, passkey, ...extra }));
	await ev.initialize();
	return ev;
}

/** A read-only view of an existing stream, holding no credential at all. */
async function reopen(id, extra = {}) {
	const ev = new Mnemonad({ publicClient: clients.publicClient, contractAddress, id, ...extra });
	await ev.initialize();
	return ev;
}

describe('construction', () => {
	it('rejects a passkey alongside a signer or a password', () => {
		const passkey = fakePasskey('a');
		expect(() => new MnemonadCrypto({ passkey, signer: clients.walletClient })).toThrow(/only one of/);
		expect(() => new MnemonadCrypto({ passkey, password: 'pw' })).toThrow(/only one of/);
	});

	it('rejects a passkey without evaluate() or an rpId', () => {
		expect(() => new MnemonadCrypto({ passkey: { rpId: RP_ID } })).toThrow(/evaluate/);
		expect(() => new MnemonadCrypto({ passkey: { evaluate: async () => new Uint8Array(32) } })).toThrow(/rpId/);
	});

	it('counts as enabled', () => {
		expect(new MnemonadCrypto({ passkey: fakePasskey('a') }).isEnabled).toBe(true);
	});
});

describe('creation', () => {
	it('creates an encrypted stream and publishes the passkey marker', async () => {
		const passkey = fakePasskey('alice', { pickedId: 'cred-alice' });
		const ev = await createWithPasskey(passkey, { name: 'notes' });

		expect(await ev.isEncrypted()).toBe(true);
		expect(ev.streamMeta).toEqual({
			name: 'notes',
			kek: { method: 'passkey', rpId: RP_ID, credentialId: 'cred-alice' },
		});
		expect(kekMethodOf({ kek: ev.streamMeta.kek, encrypted: true })).toBe('passkey');
	});

	it('evaluates the passkey once, with the salt computed from the stream', async () => {
		const passkey = fakePasskey('alice');
		const ev = await createWithPasskey(passkey);

		expect(passkey.calls).toHaveLength(1);
		expect(passkey.calls[0]).toEqual(MnemonadCrypto.passkeyKekSalt(ev.chainId, contractAddress, ev.id));
		// No credential id known and none reported by the ceremony: nothing to publish.
		expect(ev.streamMeta.kek).toEqual({ method: 'passkey', rpId: RP_ID });
	});

	it('keeps a credential id the caller already knew', async () => {
		const ev = await createWithPasskey(fakePasskey('alice', { credentialId: 'known-id' }));
		expect(ev.streamMeta.kek.credentialId).toBe('known-id');
	});

	it('derives a different salt for every stream', async () => {
		const passkey = fakePasskey('alice');
		await createWithPasskey(passkey);
		await createWithPasskey(passkey);
		expect(passkey.calls[0]).not.toEqual(passkey.calls[1]);
	});

	it('binds chain id and contract into the salt too', () => {
		const a = MnemonadCrypto.passkeyKekSalt(10143, contractAddress, 1n);
		expect(a).toHaveLength(32);
		expect(MnemonadCrypto.passkeyKekSalt(143, contractAddress, 1n)).not.toEqual(a);
		expect(MnemonadCrypto.passkeyKekSalt(10143, '0x' + '11'.repeat(20), 1n)).not.toEqual(a);
		// Address case must not matter: the same contract always gives the same salt.
		expect(MnemonadCrypto.passkeyKekSalt(10143, contractAddress.toUpperCase().replace('0X', '0x'), 1n)).toEqual(a);
	});

	it('rejects a PRF output that is not 32 bytes', async () => {
		const bad = { rpId: RP_ID, evaluate: async () => new Uint8Array(16) };
		await expect(createWithPasskey(bad)).rejects.toThrow(/32-byte/);
	});
});

describe('unlocking', () => {
	it('returns ciphertext to a reader with no passkey', async () => {
		const plain = makeBytes(500, 3);
		const ev = await createWithPasskey(fakePasskey('alice'), { array: [plain] });

		const reader = await reopen(ev.id);
		const raw = new Uint8Array(await reader.at(0));
		expect(raw).not.toEqual(plain);
	});

	it('unlocks a fresh instance with the same passkey', async () => {
		const plain = makeBytes(500, 4);
		const ev = await createWithPasskey(fakePasskey('alice'), { array: [plain] });

		const reader = await reopen(ev.id);
		const key = await reader.unlockWithPasskey(fakePasskey('alice'));
		expect(key).toEqual(ev.crypto.getAesKey());
		expect(new Uint8Array(await reader.at(0))).toEqual(plain);
	});

	it('rejects a different passkey with KEK_MISMATCH and adopts nothing', async () => {
		const ev = await createWithPasskey(fakePasskey('alice'), { array: [makeBytes(100, 5)] });

		const reader = await reopen(ev.id);
		const err = await reader.unlockWithPasskey(fakePasskey('mallory')).catch((e) => e);
		expect(err.code).toBe('KEK_MISMATCH');
		expect(err.message).toMatch(/passkey/);
		expect(reader.crypto.getAesKey()).toBeNull();
	});

	it('does not care which wallet the reader is connected with', async () => {
		const plain = makeBytes(300, 6);
		const ev = await createWithPasskey(fakePasskey('alice'), { array: [plain] });

		const otherWallet = createWalletClient({ chain: getChain(), transport: http(getRpcUrl()), account: clients.accounts[1] });
		const reader = await reopen(ev.id, { walletClient: otherWallet });
		await reader.unlockWithPasskey(fakePasskey('alice'));
		expect(new Uint8Array(await reader.at(0))).toEqual(plain);
	});

	it('lets the owner keep writing after unlocking, under the same key', async () => {
		const ev = await createWithPasskey(fakePasskey('alice'));

		const writer = new Mnemonad(baseParams({ id: ev.id }));
		await writer.unlockWithPasskey(fakePasskey('alice'));
		const plain = makeBytes(700, 7);
		await writer.push(plain);

		const reader = await reopen(ev.id);
		await reader.unlockWithPasskey(fakePasskey('alice'));
		expect(new Uint8Array(await reader.at(0))).toEqual(plain);
	});

	it('throws for a stream with no wrapped key', async () => {
		const plainStream = await Mnemonad.create(baseParams());
		const reader = await reopen(plainStream.id);
		await expect(reader.unlockWithPasskey(fakePasskey('alice'))).rejects.toThrow(/no wrapped key/);
	});

	it('leaves password and signature streams alone', async () => {
		const sig = await Mnemonad.create(baseParams({ encrypt: true, signer: clients.walletClient }));
		await sig.initialize();
		expect(sig.streamMeta.kek).toEqual({ method: 'signature' });

		// A passkey can't open a signature stream: different KEK, same typed failure.
		const reader = await reopen(sig.id);
		const err = await reader.unlockWithPasskey(fakePasskey('alice')).catch((e) => e);
		expect(err.code).toBe('KEK_MISMATCH');
	});
});
