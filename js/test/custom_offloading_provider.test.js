import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import Mnemonad from '../Mnemonad.js';
import MnemonadOffloadingProvider, { bytesToHex } from '../offloading/MnemonadOffloadingProvider.js';
import { startNode, makeClients, deployRegistry, makeBytes } from './fixture.js';

/**
 * A minimal, entirely from-scratch provider — no relation to `MnemonadIpfs` at all —
 * proving the extension point documented on `MnemonadOffloadingProvider` actually works
 * for a third-party subclass, not just the SDK's own built-in ones. Stores payloads in a
 * plain in-memory Map keyed by a locator scheme it invents itself (not a real CID),
 * standing in for a backend that isn't IPFS at all — a private bucket, or a future
 * Filecoin/Walrus provider.
 */
class FakeOffloadingProvider extends MnemonadOffloadingProvider {
	constructor() {
		super();
		/** @type {Map<string, Uint8Array>} */
		this.store = new Map();
		this._nextId = 1;
	}

	// Deliberately not one of the built-in Codec values (IPFS=0/ARWEAVE=1/HTTPS=2) — proves
	// codec is genuinely open-ended, not secretly required to be a known one.
	static get codec() {
		return 99;
	}

	get isEnabled() {
		return true;
	}

	get canWrite() {
		return true;
	}

	async putBytes(data) {
		const locator = `fake://${this._nextId++}`;
		this.store.set(locator, new Uint8Array(data));
		return {
			hash: bytesToHex(sha256(data)),
			size: BigInt(data.length),
			codec: FakeOffloadingProvider.codec,
			locator,
		};
	}

	async readPointerBytes(pointerData) {
		const data = this.store.get(pointerData.locator);
		if (!data) throw new Error(`fake: no such locator ${pointerData.locator}`);
		this._verify(data, pointerData); // the inherited base helper, not a local copy
		return data;
	}

	async readPointerRange(pointerData, start, len) {
		const whole = await this.readPointerBytes(pointerData);
		return this._expectLength(whole.subarray(start, start + len), len, pointerData.locator);
	}

	async verifyAvailability() {
		const ev = this._mnemonad;
		await ev.initialize();
		const results = [];
		for (let i = ev.firstAvailableIndex; i < ev.length; i += 1) {
			const pointer = await ev.pointerAt(i).catch(() => null);
			if (!pointer) continue;
			results.push({
				index: i,
				locator: pointer.locator,
				available: this.store.has(pointer.locator),
				error: null,
			});
		}
		return results;
	}

	async repin(index) {
		const pointer = await this._mnemonad.pointerAt(index);
		if (!this.store.has(pointer.locator)) {
			throw new Error(`fake: cannot repin ${pointer.locator}, data lost`);
		}
		return pointer.locator;
	}
}

let node;
let clients;
let contractAddress;

/** Small enough that the oversized-item routing test doesn't need a huge payload. */
const MAX_CHUNK = 2_000;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients, { maxChunkBytes: MAX_CHUNK });
}, 120_000);

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

describe('custom offloading provider', () => {
	it('wires in via offloadingProvider — attach() called, same instance exposed', async () => {
		const provider = new FakeOffloadingProvider();
		const ev = await Mnemonad.create(baseParams({ offloadingProvider: provider }));

		expect(ev.offloadingProvider).toBe(provider);
		expect(provider._mnemonad).toBe(ev);
	});

	it('routes an external push and a read through it end-to-end, not MnemonadIpfs', async () => {
		const provider = new FakeOffloadingProvider();
		const ev = await Mnemonad.create(baseParams({ offloadingProvider: provider }));
		const data = makeBytes(1_000, 1);

		await ev.pushExternal(data);
		expect(provider.store.size).toBe(1);
		expect(new Uint8Array(await ev.at(0))).toEqual(data);
	});

	it('records the provider-reported codec on-chain, whatever value it is', async () => {
		const provider = new FakeOffloadingProvider();
		const ev = await Mnemonad.create(baseParams({ offloadingProvider: provider }));
		await ev.pushExternal(makeBytes(100, 2));

		const pointer = await ev.pointerAt(0);
		expect(pointer.codec).toBe(99); // the contract stored it verbatim, no validation
	});

	it("routes oversized push() through it when it's the only write path available", async () => {
		const provider = new FakeOffloadingProvider();
		const ev = await Mnemonad.create(baseParams({ offloadingProvider: provider }));
		const big = makeBytes(MAX_CHUNK + 500, 3); // exceeds maxChunkBytes

		// push()'s routing decision reads offloadingProvider.canWrite — proving that check
		// isn't hardcoded to a specific class.
		await ev.push(big);
		expect(provider.store.size).toBe(1);
		expect(new Uint8Array(await ev.at(0))).toEqual(big);
	});

	it('catches a hash mismatch via the inherited _verify, not a duplicated check', async () => {
		const provider = new FakeOffloadingProvider();
		const ev = await Mnemonad.create(baseParams({ offloadingProvider: provider }));
		await ev.pushExternal(makeBytes(200, 4));

		// Corrupt the provider's own copy after the fact — a real integrity failure, not a
		// fabricated pointer.
		const [locator] = provider.store.keys();
		provider.store.set(locator, makeBytes(200, 5));

		await expect(ev.at(0)).rejects.toThrow(/hash mismatch/);
	});

	it('supports readRange, verifyAvailability and repin through a fully custom implementation', async () => {
		const provider = new FakeOffloadingProvider();
		const ev = await Mnemonad.create(baseParams({ offloadingProvider: provider, allowUnverifiedRanges: true }));
		const data = makeBytes(500, 6);
		await ev.pushExternal(data);

		const slice = await ev.readRange(0, 100, 50);
		expect(new Uint8Array(slice)).toEqual(data.subarray(100, 150));

		const [report] = await provider.verifyAvailability();
		expect(report.available).toBe(true);

		const pointer = await ev.pointerAt(0);
		expect(await provider.repin(0)).toBe(pointer.locator);
	});
});
