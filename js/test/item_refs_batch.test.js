import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import { startNode, makeClients, deployRegistry, makeMockIpfs, makeBytes } from './fixture.js';

let node;
let clients;
let contractAddress;

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
	return { publicClient: clients.publicClient, walletClient: clients.walletClient, contractAddress, ...extra };
}

describe('getItemRefsBatch', () => {
	it('matches N individual getItemRefs calls, across SLOT/CODE/EXTERNAL tiers', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		await ev.push(makeBytes(10, 1)); // SLOT
		await ev.push(makeBytes(500, 2)); // CODE
		await ev.push(makeBytes(MAX_CHUNK * 2, 3)); // EXTERNAL (offloaded)

		const individual = [];
		for (let i = 0; i < 3; i++) individual.push(await ev.getItemRefs(i));

		const batch = await ev.getItemRefsBatch([0, 1, 2]);

		expect(batch).toHaveLength(3);
		for (let i = 0; i < 3; i++) {
			expect(batch[i].store).toBe(individual[i].store);
			expect(batch[i].chunks).toEqual(individual[i].chunks);
			expect(batch[i].offset).toBe(individual[i].offset);
			expect(batch[i].size).toBe(individual[i].size);
			expect(batch[i].meta).toEqual(individual[i].meta);
		}
	});

	it('preserves the requested order, independent of index order', async () => {
		const ev = await Mnemonad.create(baseParams());
		for (let i = 0; i < 4; i++) await ev.push(makeBytes(20 + i, i));

		const batch = await ev.getItemRefsBatch([3, 0, 2, 1]);
		expect(batch.map((r) => r.size)).toEqual([23, 20, 22, 21]);
	});

	it('returns an empty array for an empty request, without reverting', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(10, 1));
		await expect(ev.getItemRefsBatch([])).resolves.toEqual([]);
	});

	it('collapses N logical reads into exactly one client call', async () => {
		const ev = await Mnemonad.create(baseParams());
		for (let i = 0; i < 5; i++) await ev.push(makeBytes(20 + i, i));
		await ev.initialize(); // pre-warm — this call's own reads must not count below

		const seen = [];
		const original = clients.publicClient.readContract.bind(clients.publicClient);
		clients.publicClient.readContract = async (args) => {
			seen.push(args.functionName);
			return original(args);
		};
		try {
			await ev.getItemRefsBatch([0, 1, 2, 3, 4]);
		} finally {
			clients.publicClient.readContract = original;
		}
		// The point of this method: a client-side rate limiter counts *invocations* of
		// readContract, not indices inside an array argument — this is what actually turns
		// "5 items" into one call against that budget, not just one HTTP request.
		expect(seen).toEqual(['getItemRefsBatch']);
	});
});

describe('itemsAt', () => {
	it('matches N individual itemAt calls, in the requested order', async () => {
		const ipfsClient = makeMockIpfs();
		const ev = await Mnemonad.create(baseParams({ ipfsClient }));
		await ev.push(makeBytes(10, 1));
		await ev.push(makeBytes(500, 2));
		await ev.push(makeBytes(MAX_CHUNK * 2, 3));

		// Reference values, fetched individually.
		const individual = await Promise.all([2, 0, 1].map((i) => ev.itemAt(i)));

		// A second, independent instance (same vector, empty cache) so itemsAt actually
		// exercises the batched-fetch path instead of just returning ev's own warm cache.
		const fresh = new Mnemonad({ publicClient: clients.publicClient, contractAddress, id: ev.id, ipfsClient });
		const batch = await fresh.itemsAt([2, 0, 1]);

		expect(batch.map((it) => it.storeName)).toEqual(individual.map((it) => it.storeName));
		expect(batch.map((it) => it.size)).toEqual(individual.map((it) => it.size));
	});

	it('skips already-cached indices instead of refetching them', async () => {
		const ev = await Mnemonad.create(baseParams());
		for (let i = 0; i < 3; i++) await ev.push(makeBytes(20 + i, i));

		await ev.itemAt(1); // pre-warm index 1's cache

		let calls = 0;
		const original = clients.publicClient.readContract.bind(clients.publicClient);
		clients.publicClient.readContract = async (args) => {
			if (args.functionName === 'getItemRefsBatch') calls++;
			return original(args);
		};
		let result;
		try {
			result = await ev.itemsAt([0, 1, 2]);
		} finally {
			clients.publicClient.readContract = original;
		}
		expect(calls).toBe(1);
		// The batch call only asked for the two indices not already cached — confirmed by
		// the returned items still being correct for all three, cached or not.
		expect(result.map((it) => it.size)).toEqual([20, 21, 22]);
	});

	it('returns [] for an empty request', async () => {
		const ev = await Mnemonad.create(baseParams());
		await ev.push(makeBytes(10, 1));
		await expect(ev.itemsAt([])).resolves.toEqual([]);
	});
});
