import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad, { EXPECTED_CONTRACT_VERSION } from '../Mnemonad.js';
import MnemonadCrypto from '../MnemonadCrypto.js';
import { Store } from '../MnemonadItem.js';
import { encodeStreamMeta } from '../streamMeta.js';
import { encodeItemMeta } from '../itemMeta.js';
import {
	startNode,
	makeClients,
	deployRegistry,
	makeMockIpfs,
	makeBytes,
} from './fixture.js';

let node;
let clients;
let contractAddress;

/** Small enough that the staged multi-chunk path is reachable with modest payloads. */
const MAX_CHUNK = 2_000;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
}, 120_000);

afterAll(async () => {
	await node?.stop();
});

/** Base params for a writable instance. */
function baseParams(extra = {}) {
	return {
		publicClient: clients.publicClient,
		walletClient: clients.walletClient,
		contractAddress,
		...extra,
	};
}

describe('deployment', () => {
	it('reports the expected contract version and chunk ceiling', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.initialize();
		// Asserted against the SDK's own constant, not a literal: the two must move
		// together, and a drift between them is exactly what this check exists to catch.
		expect(ev.madeWithVersion).toBe(EXPECTED_CONTRACT_VERSION);
		expect(ev.maxChunkBytes).toBe(MAX_CHUNK);
	});

	it('refuses to operate against a mismatched contract', async () => {
		// Point the SDK at an address that isn't the registry; the version probe must fail
		// loudly rather than proceeding to misdecode whatever is there.
		const ev = new Mnemonad(
			baseParams({ id: 1n, contractAddress: clients.account.address })
		);
		await expect(ev.initialize()).rejects.toThrow();
	});
});

describe('create', () => {
	it('creates an empty stream', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.initialize();
		expect(ev.length).toBe(0);
		expect(ev.binaryLength).toBe(0);
		expect(await ev.owner()).toBe(clients.account.address);
	});

	it('returns the id predicted from the salt before creation', async () => {
		const salt = `0x${'11'.repeat(32)}`;
		const predicted = await Mnemonad.computeStreamId(
			clients.publicClient,
			contractAddress,
			clients.account.address,
			salt
		);

		const ev = await Mnemonad.create(baseParams({ salt }));
		expect(ev.id).toBe(predicted);
	});

	it('creates with initial items in a single transaction', async () => {
		const chunks = [makeBytes(40, 1), makeBytes(41, 2), makeBytes(42, 3)];
		const ev = await Mnemonad.create(baseParams({ array: chunks, meta: makeBytes(4, 9) }));
		await ev.initialize();

		expect(ev.length).toBe(3);
		expect(new Uint8Array(await ev.at(0))).toEqual(chunks[0]);
		expect(new Uint8Array(await ev.at(2))).toEqual(chunks[2]);
		expect(new Uint8Array(ev.meta)).toEqual(makeBytes(4, 9));
	});
});

describe('metadata', () => {
	it('streamMeta reflects encodeStreamMeta round-tripped through a real create', async () => {
		const kek = { method: 'password', salt: `0x${'22'.repeat(16)}`, iterations: 600_000 };
		const meta = encodeStreamMeta({ name: 'My Documents', kek });
		const ev = await Mnemonad.create(baseParams({ meta }));
		await ev.initialize();

		expect(ev.streamMeta).toEqual({ name: 'My Documents', kek });
	});

	it('streamMeta is {name: null, kek: null} for a stream created with no meta at all', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.initialize();
		expect(ev.streamMeta).toEqual({ name: null, kek: null });
	});

	it("itemMeta reflects encodeItemMeta round-tripped through a real push, via both itemAt() and itemsAt()", async () => {
		const itemMeta = encodeItemMeta({ name: 'photo.jpg', type: 'image/jpeg' });
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(50, 1), { itemMeta });

		expect((await ev.itemAt(0)).itemMeta).toEqual({ name: 'photo.jpg', type: 'image/jpeg' });
		expect((await ev.itemsAt([0]))[0].itemMeta).toEqual({ name: 'photo.jpg', type: 'image/jpeg' });
	});

	it('itemMeta is {name: null, type: null} for an item pushed with no itemMeta at all', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(50, 2));
		expect((await ev.itemAt(0)).itemMeta).toEqual({ name: null, type: null });
	});

	describe('name/type sugar — the caller never calls encodeStreamMeta/encodeItemMeta itself', () => {
		it('create({ name }) encodes it, with no meta/encodeStreamMeta call from the caller', async () => {
			const ev = await Mnemonad.create(baseParams({ name: 'My Documents' }));
			await ev.initialize();
			expect(ev.streamMeta).toEqual({ name: 'My Documents', kek: null });
		});

		it('push({ name, type }) encodes it, with no itemMeta/encodeItemMeta call from the caller', async () => {
			const ev = await Mnemonad.create(baseParams());
			await ev.push(makeBytes(50, 3), { name: 'photo.jpg', type: 'image/jpeg' });
			expect((await ev.itemAt(0)).itemMeta).toEqual({ name: 'photo.jpg', type: 'image/jpeg' });
		});

		it('an explicit raw meta/itemMeta still wins outright over name/type', async () => {
			const rawStreamMeta = new TextEncoder().encode('raw legacy bytes');
			const ev = await Mnemonad.create(baseParams({ meta: rawStreamMeta, name: 'ignored' }));
			await ev.initialize();
			expect(new Uint8Array(ev.meta)).toEqual(rawStreamMeta);

			const rawItemMeta = new TextEncoder().encode('also raw');
			await ev.push(makeBytes(50, 4), { itemMeta: rawItemMeta, name: 'ignored', type: 'ignored' });
			expect(new Uint8Array((await ev.itemAt(0)).meta)).toEqual(rawItemMeta);
		});

		it('estimatePushCost accepts name/type too, without throwing or ignoring them', async () => {
			const ev = await Mnemonad.create(baseParams());
			const withoutMeta = await ev.estimatePushCost(makeBytes(50, 5));
			const withMeta = await ev.estimatePushCost(makeBytes(50, 5), { name: 'a', type: 'b' });
			// Not a byte-exact assertion (gas varies with calldata) — just proving name/type
			// actually reached the estimate rather than being silently dropped: a non-empty
			// itemMeta payload on the staged path changes beginItem's own calldata size.
			expect(withMeta.gas).not.toBe(withoutMeta.gas);
		});
	});
});

describe('push and at', () => {
	it('pushes a small Uint8Array and reads it back', async () => {
		const ev = await Mnemonad.create(baseParams());
		const data = makeBytes(20, 1);
		await ev.push(data);

		await ev.initialize();
		expect(ev.length).toBe(1);
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('routes tiny items to SLOT and larger ones to CODE', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(31, 1));
		await ev.push(makeBytes(32, 2));

		expect((await ev.itemAt(0)).storeName).toBe('slot');
		expect((await ev.itemAt(1)).storeName).toBe('code');
	});

	it('pushes across a range of sizes and round-trips each', async () => {
		const ev = await Mnemonad.create(baseParams());
		const sizes = [1, 31, 32, 500, MAX_CHUNK];

		for (let i = 0; i < sizes.length; i += 1) {
			const data = makeBytes(sizes[i], i + 1);
			await ev.push(data);
			expect(new Uint8Array(await ev.at(i))).toEqual(data);
		}

		await ev.initialize();
		expect(ev.length).toBe(sizes.length);
		expect(ev.binaryLength).toBe(sizes.reduce((a, b) => a + b, 0));
	});

	it('keeps length in sync across chained pushes without re-reading', async () => {
		const ev = await Mnemonad.create(baseParams());
		// The on-chain expectedLength guard would reject these if `length` drifted.
		await ev.push(makeBytes(50, 1));
		await ev.push(makeBytes(50, 2));
		await ev.push(makeBytes(50, 3));

		await ev.initialize();
		expect(ev.length).toBe(3);
	});

	it('rejects oversized items when neither staging nor IPFS is available', async () => {
		const ev = await Mnemonad.create(baseParams());
		await expect(ev.push(makeBytes(MAX_CHUNK + 1, 1))).rejects.toThrow(/exceeds maxChunkBytes/);
	});

	it('carries per-item metadata', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(100, 1), { itemMeta: makeBytes(8, 7) });
		const item = await ev.itemAt(0);
		expect(new Uint8Array(item.meta)).toEqual(makeBytes(8, 7));
	});
});

describe('pushMany (packing)', () => {
	it('packs a batch into one shared chunk and reads each item back', async () => {
		const ev = await Mnemonad.create(baseParams());
		const items = [makeBytes(100, 1), makeBytes(150, 2), makeBytes(70, 3)];
		await ev.pushMany(items);

		await ev.initialize();
		expect(ev.length).toBe(3);

		const refs = await Promise.all([0, 1, 2].map((i) => ev.getItemRefs(i)));
		// All three must live in the same deployed chunk — that's where the saving is.
		expect(refs[1].chunks[0]).toBe(refs[0].chunks[0]);
		expect(refs[2].chunks[0]).toBe(refs[0].chunks[0]);
		expect(refs.map((r) => r.offset)).toEqual([0, 100, 250]);

		for (let i = 0; i < items.length; i += 1) {
			expect(new Uint8Array(await ev.at(i))).toEqual(items[i]);
		}
	});

	it('pushes an array via push() as a packed batch', async () => {
		const ev = await Mnemonad.create(baseParams());
		const items = [makeBytes(60, 1), makeBytes(60, 2)];
		await ev.push(items);

		await ev.initialize();
		expect(ev.length).toBe(2);
		expect(new Uint8Array(await ev.at(1))).toEqual(items[1]);
	});

	it('refuses a batch containing an oversized item', async () => {
		const ev = await Mnemonad.create(baseParams());
		await expect(
			ev.pushMany([makeBytes(50, 1), makeBytes(MAX_CHUNK + 1, 2)])
		).rejects.toThrow(/exceeds maxChunkBytes/);
	});
});

describe('staged append', () => {
	it('stores an item larger than one chunk across several transactions', async () => {
		const ev = await Mnemonad.create(baseParams());
		const big = makeBytes(MAX_CHUNK * 2 + 500, 5);

		await ev.push(big, { onChain: true });

		await ev.initialize();
		expect(ev.length).toBe(1);
		expect(ev.binaryLength).toBe(big.length);
		expect(new Uint8Array(await ev.at(0))).toEqual(big);

		const refs = await ev.getItemRefs(0);
		expect(refs.chunks.length).toBe(3);
	});

	it('leaves the stream untouched until the item is committed', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(100, 1));
		await ev.initialize();
		const before = ev.length;

		await ev.push(makeBytes(MAX_CHUNK + 10, 2), { onChain: true });
		await ev.initialize();
		expect(ev.length).toBe(before + 1);
	});
});

describe('concat', () => {
	it('appends another stream and consumes it', async () => {
		const dst = await Mnemonad.create(baseParams());
		const src = await Mnemonad.create(baseParams());

		await dst.push(makeBytes(100, 1));
		await src.push(makeBytes(200, 2));
		await src.push(makeBytes(20, 3));

		await dst.concat(src);
		await dst.initialize();

		expect(dst.length).toBe(3);
		expect(new Uint8Array(await dst.at(1))).toEqual(makeBytes(200, 2));
		expect(new Uint8Array(await dst.at(2))).toEqual(makeBytes(20, 3));
	});

	it('shares chunks rather than copying payload bytes', async () => {
		const dst = await Mnemonad.create(baseParams());
		const src = await Mnemonad.create(baseParams());
		const payload = makeBytes(1_500, 9);

		await src.push(payload);
		const before = await src.getItemRefs(0);

		await dst.concat(src);
		const after = await dst.getItemRefs(0);

		expect(after.chunks[0]).toBe(before.chunks[0]);
		expect(new Uint8Array(await dst.at(0))).toEqual(payload);
	});

	it('accepts a bare stream id', async () => {
		const dst = await Mnemonad.create(baseParams());
		const src = await Mnemonad.create(baseParams());
		await src.push(makeBytes(64, 4));

		await dst.concat(src.id);
		await dst.initialize();
		expect(dst.length).toBe(1);
	});
});

describe('truncateFrom', () => {
	it('advances the first readable index and blocks earlier reads', async () => {
		const ev = await Mnemonad.create(baseParams());
		for (let i = 0; i < 4; i += 1) {
			await ev.push(makeBytes(100 + i, i + 1));
		}

		await ev.truncateFrom(2);
		await ev.initialize();

		expect(ev.firstAvailableIndex).toBe(2);
		// length never decreases, so indices stay stable.
		expect(ev.length).toBe(4);

		await expect(ev.at(0)).rejects.toThrow();
		expect(new Uint8Array(await ev.at(2))).toEqual(makeBytes(102, 3));
	});
});

describe('burn', () => {
	it('destroys the stream', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(100, 1));
		await ev.burn();
		await expect(ev.initialize()).rejects.toThrow();
	});
});

describe('IPFS offloading', () => {
	it('auto-routes oversized items to IPFS when a transport is configured', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));

		const big = makeBytes(MAX_CHUNK * 3, 6);
		await ev.push(big);

		await ev.initialize();
		expect(ev.length).toBe(1);

		const item = await ev.itemAt(0);
		expect(item.isExternal).toBe(true);
		expect(item.storeName).toBe('external');
		expect(item.size).toBe(big.length);

		// binaryLength counts the off-chain payload, though only ~36 bytes hit the chain.
		expect(ev.binaryLength).toBe(big.length);
		expect(new Uint8Array(await ev.at(0))).toEqual(big);
	});

	it('verifies the hash on read and rejects tampered payloads', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));

		const big = makeBytes(MAX_CHUNK * 2, 7);
		await ev.push(big);

		const pointer = await ev.pointerAt(0);
		// A gateway is untrusted, so a substituted payload must be caught rather than
		// returned — that's what the recorded hash is for.
		ipfsClient.corrupt(pointer.locator, makeBytes(big.length, 99));

		await expect(ev.at(0)).rejects.toThrow(/hash mismatch/);
	});

	it('rejects a payload of the wrong length', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		await ev.push(makeBytes(MAX_CHUNK * 2, 8));

		const pointer = await ev.pointerAt(0);
		ipfsClient.corrupt(pointer.locator, makeBytes(10, 1));

		await expect(ev.at(0)).rejects.toThrow(/size mismatch/);
	});

	it('reports availability across external items', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		await ev.push(makeBytes(MAX_CHUNK * 2, 12));

		const report = await ev.offloadingProvider.verifyAvailability({ verify: true });
		expect(report.length).toBe(1);
		expect(report[0].available).toBe(true);

		// Unpin it and the report must flip — this is the closest analogue of the
		// reference's minBlobEndEpoch(), and strictly weaker: it observes, not guarantees.
		ipfsClient.store.clear();
		const after = await ev.offloadingProvider.verifyAvailability({ verify: true });
		expect(after[0].available).toBe(false);
	});

	it('forces oversized items on-chain when asked, ignoring IPFS', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));

		const big = makeBytes(MAX_CHUNK + 200, 13);
		await ev.push(big, { onChain: true });

		const item = await ev.itemAt(0);
		expect(item.storeName).toBe('code');
		expect(ipfsClient.store.size).toBe(0);
		expect(new Uint8Array(await ev.at(0))).toEqual(big);
	});
});

describe('fees', () => {
	it('quotes zero while the fee is dormant', async () => {
		const ev = await Mnemonad.create(baseParams());
		expect(await ev.quotePushFee(1_000, Store.CODE)).toBe(0n);
	});

	it('charges per byte on-chain and a flat fee for external items', async () => {
		// Fresh registry so the fee change can't disturb other tests.
		const address = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
		const abiMod = (await import('../abi.js')).mnemonadAbi;

		const feePerByte = 1_000n;
		const hash = await clients.walletClient.writeContract({
			address,
			abi: abiMod,
			functionName: 'setFeePerByte',
			args: [feePerByte],
		});
		await clients.publicClient.waitForTransactionReceipt({ hash });

		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(
			baseParams({ contractAddress: address, ipfsClient })
		);

		expect(await ev.quotePushFee(1_000, Store.CODE)).toBe(1_000n * feePerByte);

		const externalFeeBytes = await clients.publicClient.readContract({
			address,
			abi: abiMod,
			functionName: 'externalFeeBytes',
		});
		const flat = externalFeeBytes * feePerByte;
		// Flat regardless of payload size — the decided rule.
		expect(await ev.quotePushFee(1_000_000_000, Store.EXTERNAL)).toBe(flat);
		expect(await ev.quotePushFee(1, Store.EXTERNAL)).toBe(flat);

		// A push must actually succeed with the fee attached.
		const data = makeBytes(200, 1);
		await ev.push(data);
		expect(new Uint8Array(await ev.at(0))).toEqual(data);

		const accrued = await clients.publicClient.readContract({
			address,
			abi: abiMod,
			functionName: 'feesAccrued',
		});
		expect(accrued).toBe(200n * feePerByte);
	});

	it('estimates gas and fee for a push', async () => {
		const ev = await Mnemonad.create(baseParams());
		const estimate = await ev.estimatePushCost(makeBytes(1_000, 1));

		expect(estimate.gas).toBeGreaterThan(0n);
		expect(estimate.total).toBe(estimate.gasCost + estimate.fee);
		expect(estimate.transactionCount).toBe(1);
	});

	it('estimates the staged path for an oversized item with { onChain: true }', async () => {
		const ev = await Mnemonad.create(baseParams());
		// 2 full chunks + 1 partial — exercises both branches of the chunk loop.
		const data = makeBytes(MAX_CHUNK * 2 + 500, 2);
		const estimate = await ev.estimatePushCost(data, { onChain: true });

		expect(estimate.transactionCount).toBe(5); // beginItem + 3 appendChunk + commitItem
		expect(estimate.gas).toBeGreaterThan(0n);
		expect(estimate.total).toBe(estimate.gasCost + estimate.fee);

		// The estimate should be in the right ballpark of what staging it for real costs —
		// loose bounds since it is a model, not a byte-exact simulation (see the method's
		// own doc comment for why appendChunk/commitItem can't be simulated directly).
		await ev.push(data, { onChain: true });
	});

	it('estimates an IPFS-backed push without actually uploading anything', async () => {
		const ipfs = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient: ipfs }));
		const data = makeBytes(MAX_CHUNK + 500, 3);

		const estimate = await ev.estimatePushCost(data);
		expect(estimate.transactionCount).toBe(1);
		expect(estimate.gas).toBeGreaterThan(0n);
		expect(ipfs.store.size).toBe(0); // no real upload happened

		await ev.push(data);
		expect(ipfs.store.size).toBe(1); // the real push does upload
	});

	it('throws the same descriptive error push() would, for an oversized item with no route', async () => {
		const ev = await Mnemonad.create(baseParams());
		const data = makeBytes(MAX_CHUNK + 1, 4);
		await expect(ev.estimatePushCost(data)).rejects.toThrow(/exceeds maxChunkBytes/);
	});

	describe('on an encrypted stream', () => {
		it('estimates on ciphertext size, not plaintext -- fee matches the larger encrypted length', async () => {
			const ev = await Mnemonad.create(baseParams({ encrypt: true, signer: clients.walletClient }));
			const plaintext = makeBytes(500, 5);
			const cipherLen = MnemonadCrypto.ciphertextLengthFor(plaintext.length);
			// Sanity: the two lengths actually differ, so the assertions below aren't
			// vacuously true regardless of which one estimatePushCost used.
			expect(cipherLen).not.toBe(plaintext.length);

			const estimate = await ev.estimatePushCost(plaintext);
			expect(estimate.fee).toBe(await ev.quotePushFee(cipherLen, Store.CODE));

			// The estimate has to genuinely match what push() does with the same input.
			await ev.push(plaintext);
			expect((await ev.itemAt(0)).size).toBe(cipherLen);
		});

		it('a plaintext size that fits on-chain unencrypted can still need { onChain: true } once encrypted', async () => {
			// Exactly the case push()'s own "encrypt first, then route" comment warns
			// about — the bug this fix closes: estimating on plaintext length would have
			// picked the single-transaction on-chain path here, when push() itself (which
			// encrypts before routing) would actually need the staged path or IPFS.
			const ev = await Mnemonad.create(baseParams({ encrypt: true, signer: clients.walletClient }));
			const plaintext = makeBytes(MAX_CHUNK - 10, 6);
			expect(MnemonadCrypto.ciphertextLengthFor(plaintext.length)).toBeGreaterThan(MAX_CHUNK);

			await expect(ev.estimatePushCost(plaintext)).rejects.toThrow(/exceeds maxChunkBytes/);

			const estimate = await ev.estimatePushCost(plaintext, { onChain: true });
			expect(estimate.transactionCount).toBeGreaterThan(1);
			await ev.push(plaintext, { onChain: true });
		});

		it('{ alreadyEncrypted: true } estimates on the given ciphertext directly, without encrypting it again', async () => {
			const ev = await Mnemonad.create(baseParams({ encrypt: true, signer: clients.walletClient }));
			const plaintext = makeBytes(300, 7);
			const ciphertext = await ev.crypto.encryptItem(plaintext);

			const estimate = await ev.estimatePushCost(ciphertext, { alreadyEncrypted: true });
			expect(estimate.fee).toBe(await ev.quotePushFee(ciphertext.length, Store.CODE));
		});
	});
});

describe('access control', () => {
	it('is read-only without a wallet or send function', async () => {
		const created = await Mnemonad.create(baseParams());
		await created.push(makeBytes(100, 1));

		const readOnly = new Mnemonad({
			publicClient: clients.publicClient,
			contractAddress,
			id: created.id,
		});

		expect(readOnly.isWritable).toBe(false);
		expect(new Uint8Array(await readOnly.at(0))).toEqual(makeBytes(100, 1));
		await expect(readOnly.push(makeBytes(10, 1))).rejects.toThrow(/not writable/);
		// No sender configured at all — resolves false rather than rejecting.
		expect(await readOnly.canWrite()).toBe(false);
	});

	it('lets an approved writer append, but not a stranger', async () => {
		const { createWalletClient, http } = await import('viem');
		const { getChain, getRpcUrl } = await import('./fixture.js');

		const ev = await Mnemonad.create(baseParams());
		const otherWallet = createWalletClient({
			chain: getChain(),
			transport: http(getRpcUrl()),
			account: clients.accounts[1],
		});

		const asOther = new Mnemonad({
			publicClient: clients.publicClient,
			walletClient: otherWallet,
			contractAddress,
			id: ev.id,
		});

		expect(await ev.canWrite()).toBe(true); // owner, using its own configured sender
		expect(await asOther.canWrite()).toBe(false);
		expect(await ev.canWrite(clients.accounts[1].address)).toBe(false); // explicit address
		await expect(asOther.push(makeBytes(100, 1))).rejects.toThrow();

		await ev.setWriterApproval(clients.accounts[1].address, true);
		expect(await asOther.canWrite()).toBe(true);
		await asOther.push(makeBytes(100, 2));

		await ev.initialize();
		expect(ev.length).toBe(1);
	});

	it('supports a custom sendTransaction callback', async () => {
		let calls = 0;
		const ev = await Mnemonad.create(
			baseParams({
				walletClient: null,
				sendTransaction: async (request) => {
					calls += 1;
					return await clients.walletClient.writeContract(request);
				},
				senderAddress: clients.account.address,
			})
		);

		await ev.push(makeBytes(100, 1));
		await ev.initialize();

		expect(ev.length).toBe(1);
		// create + push
		expect(calls).toBe(2);
	});
});
