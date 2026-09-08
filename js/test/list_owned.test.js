import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import { mnemonadAbi } from '../abi.js';
import { startNode, makeClients, deployRegistry } from './fixture.js';

let node;
let clients;
let contractAddress;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
	contractAddress = await deployRegistry(clients);
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

/** Direct ERC-721 transfer — the SDK deliberately doesn't wrap this, it's standard tooling
 *  territory, not stream-specific — so tests reach for the raw ABI call. */
async function transfer(from, to, id) {
	const hash = await clients.walletClient.writeContract({
		address: contractAddress,
		abi: mnemonadAbi,
		functionName: 'transferFrom',
		args: [from.address, to.address, id],
		account: from,
	});
	await clients.publicClient.waitForTransactionReceipt({ hash });
}

describe('listOwned', () => {
	it('is empty for an address that owns nothing', async () => {
		const owned = await Mnemonad.listOwned(clients.publicClient, contractAddress, clients.accounts[2].address);
		expect(owned).toEqual([]);
	});

	it('lists every stream a single owner created', async () => {
		const a = await Mnemonad.create(baseParams());
		const b = await Mnemonad.create(baseParams());

		const owned = await Mnemonad.listOwned(clients.publicClient, contractAddress, clients.account.address);
		const ids = owned.map(String).sort();
		expect(ids).toEqual(expect.arrayContaining([String(a.id), String(b.id)]));
	});

	it('does not cross owners', async () => {
		const mine = await Mnemonad.create(baseParams());
		const owned0 = await Mnemonad.listOwned(clients.publicClient, contractAddress, clients.accounts[0].address);
		const owned1 = await Mnemonad.listOwned(clients.publicClient, contractAddress, clients.accounts[1].address);

		expect(owned0.map(String)).toContain(String(mine.id));
		expect(owned1.map(String)).not.toContain(String(mine.id));
	});

	it('reflects a transfer: leaves the sender, appears for the recipient', async () => {
		const ev = await Mnemonad.create(baseParams());
		const sender = clients.accounts[0];
		const recipient = clients.accounts[1];

		const beforeSender = (await Mnemonad.listOwned(clients.publicClient, contractAddress, sender.address)).map(String);
		expect(beforeSender).toContain(String(ev.id));

		await transfer(sender, recipient, ev.id);

		const afterSender = (await Mnemonad.listOwned(clients.publicClient, contractAddress, sender.address)).map(String);
		const afterRecipient = (await Mnemonad.listOwned(clients.publicClient, contractAddress, recipient.address)).map(String);
		expect(afterSender).not.toContain(String(ev.id));
		expect(afterRecipient).toContain(String(ev.id));
	});
});
