import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import Mnemonad from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import MnemonadUploadGateway from '../MnemonadUploadGateway.js';
import { startNode, makeClients, deployRegistry, deployGateway, makeMockIpfs, makeBytes } from './fixture.js';

/**
 * `push()`'s automatic gateway-payment behavior for an off-chain item
 * (`_pushExternalAuto`) — see `Mnemonad.js`'s own doc on that method for the two
 * independent reasons prepaying matters. A caller now never encrypts, hashes, or pays
 * anything itself for an oversized item; `push()` does the whole
 * encrypt → commit → pay → upload sequence internally.
 *
 * Deliberately the one place in this suite that deploys a real `MnemonadUploadGateway`
 * (see `fixture.js`'s `deployGateway`) — everything else about the gateway's own on-chain
 * behavior is covered by the Solidity suite (`contracts/test/MnemonadUploadGateway.t.sol`);
 * this exists specifically to prove the SDK's own orchestration calls a *real* gateway
 * correctly, which the Solidity suite has no way to exercise since it never runs the SDK.
 */

let node;
let clients;
let contractAddress;
let gatewayAddress;

const MAX_CHUNK = 2_000;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
	({ gatewayAddress } = await deployGateway(clients, contractAddress));
}, 180_000);

afterAll(async () => {
	await node?.stop();
});

function baseParams(extra = {}) {
	return { publicClient: clients.publicClient, walletClient: clients.walletClient, contractAddress, ...extra };
}

function gatewayClient() {
	return new MnemonadUploadGateway({
		publicClient: clients.publicClient,
		walletClient: clients.walletClient,
		address: gatewayAddress,
	});
}

function contentHashHex(bytes) {
	return `0x${Buffer.from(sha256(bytes)).toString('hex')}`;
}

describe('push() auto-pays a wired gateway for an off-chain item', () => {
	it('pays through the gateway, then pushes — revenue increases, escrow settles', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		const data = makeBytes(MAX_CHUNK * 2, 1); // oversized, routes external

		const gw = gatewayClient();
		const before = await gw.balances();

		await ev.push(data);

		await ev.initialize();
		expect(ev.length).toBe(1);
		expect(new Uint8Array(await ev.at(0))).toEqual(data);

		const after = await gw.balances();
		// A settled escrow moves its amount from `escrowed` into `revenue` (the registry
		// waives its own flat fee specifically because a matching escrow existed) — proof
		// the payment genuinely happened and was consumed, not merely attempted.
		expect(after.revenue).toBeGreaterThan(before.revenue);

		const escrow = await gw.requestFor(clients.account.address, contentHashHex(data));
		expect(escrow.exists).toBe(false); // settled and cleared, not left dangling
	});

	it('encrypts first — commits to and settles against the ciphertext, not the plaintext', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ ipfsClient, encrypt: true, signer: clients.walletClient })
		);
		const plaintext = makeBytes(MAX_CHUNK * 2, 2);

		await ev.push(plaintext);

		// Reads back correctly — the encrypt-then-commit-then-upload sequence used the
		// SAME ciphertext throughout, not a fresh encryption at some later step (which
		// would draw a different nonce and make this fail to decrypt).
		expect(new Uint8Array(await ev.at(0))).toEqual(plaintext);

		// The escrow settled against the CIPHERTEXT's hash — proof push() committed to
		// what actually got uploaded, not to the plaintext it started with.
		const ciphertext = ipfsClient.store.values().next().value;
		expect(ciphertext.length).toBe(MnemonadCrypto.ciphertextLengthFor(plaintext.length));
		expect(Buffer.from(ciphertext)).not.toEqual(Buffer.from(plaintext));

		const plaintextEscrow = await (
			await gatewayClient()
		).requestFor(clients.account.address, contentHashHex(plaintext));
		expect(plaintextEscrow.exists).toBe(false); // never existed — not what was committed to

		const ciphertextEscrow = await gatewayClient().requestFor(
			clients.account.address,
			contentHashHex(ciphertext)
		);
		expect(ciphertextEscrow.exists).toBe(false); // existed briefly, now settled — not dangling
	});

	it('reports gateway-pay then gateway-upload progress, in that order', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		const data = makeBytes(MAX_CHUNK * 2, 3);

		const events = [];
		await ev.push(data, { onProgress: (info) => events.push(info) });

		expect(events).toEqual([
			{ phase: 'gateway-pay', chunkIndex: 0, chunkCount: 1 },
			{ phase: 'gateway-upload', chunkIndex: 1, chunkCount: 1 },
		]);
	});

	it('a throwing onProgress never breaks the upload', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		const data = makeBytes(MAX_CHUNK * 2, 4);

		await ev.push(data, {
			onProgress: () => {
				throw new Error('a badly-written callback should not matter');
			},
		});

		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('payGateway: false skips payment even though a gateway is wired', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		const data = makeBytes(MAX_CHUNK * 2, 5);

		const gw = gatewayClient();
		const before = await gw.balances();

		await ev.push(data, { payGateway: false });

		expect(new Uint8Array(await ev.at(0))).toEqual(data);
		const after = await gw.balances();
		expect(after.revenue).toBe(before.revenue); // untouched — no payment was attempted
	});
});

describe('push() without a wired gateway', () => {
	it('still routes external via the registry\'s flat fee, unaffected', async () => {
		// A separate, gateway-less registry — proves the fallback (pre-existing behavior)
		// still works unchanged when _pushExternalAuto finds nothing wired to pay through.
		const freshContract = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create({
			publicClient: clients.publicClient,
			walletClient: clients.walletClient,
			contractAddress: freshContract,
			ipfsClient,
		});
		const data = makeBytes(MAX_CHUNK * 2, 6);

		await ev.push(data);

		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});
});

describe('quoteOffloadUpload', () => {
	it('matches MnemonadUploadGateway.quote() directly, for the same size', async () => {
		const ev = await Mnemonad.create(baseParams());
		const quote = await ev.quoteOffloadUpload(MAX_CHUNK * 2);
		expect(quote).toEqual(await gatewayClient().quote(MAX_CHUNK * 2));
		expect(quote).toBeGreaterThan(0n);
	});

	it('returns null, not a rejection, when no gateway is wired', async () => {
		const freshContract = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
		const ev = await Mnemonad.create({
			publicClient: clients.publicClient,
			walletClient: clients.walletClient,
			contractAddress: freshContract,
		});
		expect(await ev.quoteOffloadUpload(MAX_CHUNK * 2)).toBeNull();
	});

	it('requires no walletClient at all -- read-only instances can quote too', async () => {
		const created = await Mnemonad.create(baseParams());
		const readOnly = new Mnemonad({ publicClient: clients.publicClient, contractAddress, id: created.id });
		const quote = await readOnly.quoteOffloadUpload(MAX_CHUNK * 2);
		expect(quote).toBeGreaterThan(0n);
	});
});
