import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import { startNode, makeClients, deployRegistry, makeBytes } from './fixture.js';

/**
 * Verifies `CONTRACT_VERSION`/`maxChunkBytes` are read once per chain+contract, not once per
 * `Mnemonad` instance — the fix for `initialize()` (and `Mnemonad.create()`) paying for two
 * RPC calls that can never produce a different answer on a second ask, since both values are
 * immutable for an already-deployed contract.
 */

let node;
let clients;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
}, 120_000);

afterAll(async () => {
	await node?.stop();
});

function baseParams(contractAddress, extra = {}) {
	return { publicClient: clients.publicClient, walletClient: clients.walletClient, contractAddress, ...extra };
}

async function countReadContractCalls(fn) {
	let calls = 0;
	const original = clients.publicClient.readContract.bind(clients.publicClient);
	clients.publicClient.readContract = async (args) => {
		calls++;
		return original(args);
	};
	try {
		await fn();
	} finally {
		clients.publicClient.readContract = original;
	}
	return calls;
}

describe('shared contract constants', () => {
	it('a second instance on the same contract skips the CONTRACT_VERSION/maxChunkBytes reads', async () => {
		const contractAddress = await deployRegistry(clients);
		const first = await Mnemonad.create(baseParams(contractAddress));
		expect(first.madeWithVersion).toBeGreaterThan(0);
		expect(first.maxChunkBytes).toBeGreaterThan(0);

		let seenFunctions = [];
		const original = clients.publicClient.readContract.bind(clients.publicClient);
		clients.publicClient.readContract = async (args) => {
			seenFunctions.push(args.functionName);
			return original(args);
		};
		const second = new Mnemonad({ ...baseParams(contractAddress), id: first.id });
		try {
			await second.initialize();
		} finally {
			clients.publicClient.readContract = original;
		}

		expect(seenFunctions).not.toContain('CONTRACT_VERSION');
		expect(seenFunctions).not.toContain('maxChunkBytes');
		// The genuinely per-vector fields are still read — this only skips the 2 constants.
		// One call, not five: `length`/`binaryLength`/`firstAvailableIndex`/`vectorMeta`/
		// `encKeyWrapped` were folded into `getVectorInfo` (see its comment in Mnemonad.sol).
		expect(seenFunctions).toContain('getVectorInfo');
		expect(second.madeWithVersion).toBe(first.madeWithVersion);
		expect(second.maxChunkBytes).toBe(first.maxChunkBytes);
	});

	it('Mnemonad.create() also benefits — its own _loadConstants() skips the reads too', async () => {
		const contractAddress = await deployRegistry(clients);
		await Mnemonad.create(baseParams(contractAddress)); // populates the shared cache

		let seenFunctions = [];
		const original = clients.publicClient.readContract.bind(clients.publicClient);
		clients.publicClient.readContract = async (args) => {
			seenFunctions.push(args.functionName);
			return original(args);
		};
		let second;
		try {
			second = await Mnemonad.create(baseParams(contractAddress, { salt: `0x${'33'.repeat(32)}` }));
		} finally {
			clients.publicClient.readContract = original;
		}

		expect(seenFunctions).not.toContain('CONTRACT_VERSION');
		expect(seenFunctions).not.toContain('maxChunkBytes');
		expect(second.maxChunkBytes).toBeGreaterThan(0);
	});

	it('two different contract deployments do not share constants', async () => {
		const addressA = await deployRegistry(clients, { maxChunkBytes: 4_000 });
		const addressB = await deployRegistry(clients, { maxChunkBytes: 8_000 });

		const a = await Mnemonad.create(baseParams(addressA));
		const b = await Mnemonad.create(baseParams(addressB));

		expect(a.maxChunkBytes).toBe(4_000);
		expect(b.maxChunkBytes).toBe(8_000);

		// A fresh instance on B must still ask B's own chain state, not reuse A's answer.
		const freshB = new Mnemonad({ ...baseParams(addressB), id: b.id });
		const calls = await countReadContractCalls(async () => {
			await freshB.initialize();
		});
		expect(calls).toBeGreaterThan(0); // still has to read B's per-vector fields at least
		expect(freshB.maxChunkBytes).toBe(8_000);
	});

	it("a fresh instance's own values are correct when served entirely from the shared cache", async () => {
		const contractAddress = await deployRegistry(clients, { maxChunkBytes: 12_345 });
		const first = await Mnemonad.create(baseParams(contractAddress));
		await first.push(makeBytes(30, 1));

		const second = new Mnemonad({ ...baseParams(contractAddress), id: first.id });
		await second.initialize();
		expect(second.maxChunkBytes).toBe(12_345);
		expect(second.madeWithVersion).toBe(first.madeWithVersion);
		expect(second.length).toBe(1); // per-vector fields are still read fresh, and correct
	});
});
