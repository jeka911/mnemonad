/**
 * preparePush()/commitPush() — building a patch in one place and sending it from another
 * (the CLI's `push --detach` sends from a background process with a fresh instance).
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { DoubleSync, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';
import MonadSync from '../MonadSync.js';
import { seededBytes, treesEqual } from './helpers.js';
import { startNode, makeClients, createMn, makeMn } from './fixture.js';

const TX_TIMEOUT = 60_000;

let node;
let clients;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

function makeSync() {
	return new DoubleSync({ avgSize: 1024 });
}

async function makeTree(seed) {
	const root = new DoubleSyncMemoryFolder('proj');
	await root.addFile('a.bin', seededBytes(4096, seed));
	await root.addFile('b.bin', seededBytes(2048, seed + 1));
	return root;
}

describe('preparePush / commitPush', () => {
	it('writes nothing on prepare, and reports the version the patch will produce', async () => {
		const { mn } = await createMn(clients);
		const m = new MonadSync({ mnemonad: mn, sync: makeSync(), compress: 'gzip' });

		const first = await m.preparePush(await makeTree(1));
		expect(first.kind).toBe('patch');
		expect(first.baseLength).toBe(0);
		expect(first.itemCount).toBe(1);
		expect(first.version).toBe(1);
		expect(await m.length()).toBe(0);

		expect((await m.commitPush(first)).version).toBe(1);

		const second = await m.preparePush(await makeTree(2));
		expect(second.kind).toBe('diff-patch');
		expect(second.baseLength).toBe(1);
		expect(second.version).toBe(2);
		expect(await m.length()).toBe(1);
	}, TX_TIMEOUT);

	it('sends a prepared patch from a fresh instance that never replayed the chain', async () => {
		const { mn, contractAddress } = await createMn(clients);
		const m = new MonadSync({ mnemonad: mn, sync: makeSync(), compress: 'gzip' });
		await m.push(await makeTree(1));

		const tree = await makeTree(5);
		const prepared = await m.preparePush(tree);

		const sender = new MonadSync({ mnemonad: makeMn(clients, contractAddress, mn.id) });
		const { version } = await sender.commitPush({ patchBytes: prepared.patchBytes, baseLength: prepared.baseLength });
		expect(version).toBe(2);

		const restored = await new MonadSync({ mnemonad: makeMn(clients, contractAddress, mn.id) }).restore();
		expect(await treesEqual(restored, tree)).toBe(true);
	}, TX_TIMEOUT);

	it('leaves the preparing instance able to push normally when a prepared patch is dropped', async () => {
		const { mn, contractAddress } = await createMn(clients);
		const m = new MonadSync({ mnemonad: mn, sync: makeSync(), compress: 'gzip' });
		await m.push(await makeTree(1));

		await m.preparePush(await makeTree(7)); // built, never sent

		const tree = await makeTree(8);
		expect((await m.push(tree)).version).toBe(2);
		const restored = await new MonadSync({ mnemonad: makeMn(clients, contractAddress, mn.id) }).restore();
		expect(await treesEqual(restored, tree)).toBe(true);
	}, TX_TIMEOUT);

	it('refuses to send a patch once the stream has moved past its base, writing nothing', async () => {
		const { mn, contractAddress } = await createMn(clients);
		const m = new MonadSync({ mnemonad: mn, sync: makeSync(), compress: 'gzip' });
		await m.push(await makeTree(1));

		const stale = await m.preparePush(await makeTree(3));
		await m.push(await makeTree(4)); // stream is now at 2; `stale` was built against 1

		const sender = new MonadSync({ mnemonad: makeMn(clients, contractAddress, mn.id) });
		await expect(sender.commitPush(stale)).rejects.toMatchObject({ code: 'STREAM_MOVED' });
		expect(await new MonadSync({ mnemonad: makeMn(clients, contractAddress, mn.id) }).length()).toBe(2);
	}, TX_TIMEOUT);
});
