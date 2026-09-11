/**
 * Tests for deleting a file/folder within a tree synced through MonadSync — pure
 * DoubleSync-level behavior, not anything chain-specific.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { DoubleSync, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';
import MonadSync from '../MonadSync.js';
import { equalUint8Arrays, seededBytes, collectTree } from './helpers.js';
import { startNode, makeClients, createMn, makeMn } from './fixture.js';

const TX_TIMEOUT = 90_000;

let node;
let clients;
let contractAddress;

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

async function createMonad() {
	const { mn, contractAddress: addr } = await createMn(clients);
	contractAddress = addr;
	return mn;
}

function reopen(id) {
	return makeMn(clients, contractAddress, id);
}

function makeSync() {
	return new DoubleSync({ avgSize: 1024 });
}

describe('file deletion', () => {
	it('deleted file is absent after restore', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('a.txt', seededBytes(2048, 1));
		await sender.addFile('b.txt', seededBytes(2048, 2));
		await sender.addFile('c.txt', seededBytes(2048, 3));

		await m.initialize();
		await m.push(sender);

		await sender.removeChild('b.txt');
		await m.push(sender);

		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();

		const tree = await collectTree(restored);
		const paths = tree.map(t => t.path.join('/'));
		expect(paths).toEqual(['a.txt', 'c.txt']);
		expect(await restored.findByPath(['b.txt'])).toBeNull();

		expect(equalUint8Arrays(tree[0].bytes, seededBytes(2048, 1))).toBe(true);
		expect(equalUint8Arrays(tree[1].bytes, seededBytes(2048, 3))).toBe(true);
	}, TX_TIMEOUT);

	it('delete all files then re-add produces correct tree', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('old.txt', seededBytes(1024, 10));

		await m.initialize();
		await m.push(sender);

		await sender.removeChild('old.txt');
		await sender.addFile('new.txt', seededBytes(1024, 11));
		await m.push(sender);

		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();

		const tree = await collectTree(restored);
		expect(tree.map(t => t.path.join('/'))).toEqual(['new.txt']);
		expect(equalUint8Arrays(tree[0].bytes, seededBytes(1024, 11))).toBe(true);
		expect(await restored.findByPath(['old.txt'])).toBeNull();
	}, TX_TIMEOUT);
});

describe('folder deletion', () => {
	it('deleted subfolder and its files are absent after restore', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('root.txt', seededBytes(1024, 20));
		const sub = await sender.addFolder('sub');
		await sub.addFile('deep.txt', seededBytes(1024, 21));
		await sub.addFile('other.txt', seededBytes(1024, 22));

		await m.initialize();
		await m.push(sender);

		await sender.removeChild('sub');
		await m.push(sender);

		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();

		const tree = await collectTree(restored);
		expect(tree.map(t => t.path.join('/'))).toEqual(['root.txt']);
		expect(await restored.findByPath(['sub'])).toBeNull();
		expect(await restored.findByPath(['sub', 'deep.txt'])).toBeNull();
	}, TX_TIMEOUT);

	it('delete folder then re-add folder with different contents', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		const sub = await sender.addFolder('data');
		await sub.addFile('v1.bin', seededBytes(2048, 30));

		await m.initialize();
		await m.push(sender);

		await sender.removeChild('data');
		const sub2 = await sender.addFolder('data');
		await sub2.addFile('v2.bin', seededBytes(2048, 31));
		await m.push(sender);

		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();

		const tree = await collectTree(restored);
		expect(tree.map(t => t.path.join('/'))).toEqual(['data/v2.bin']);
		expect(await restored.findByPath(['data', 'v1.bin'])).toBeNull();
		expect(equalUint8Arrays(tree[0].bytes, seededBytes(2048, 31))).toBe(true);
	}, TX_TIMEOUT);
});

describe('version restore with deletions', () => {
	it('restoring earlier version still has the deleted file', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('keep.txt', seededBytes(1024, 40));
		await sender.addFile('gone.txt', seededBytes(1024, 41));

		await m.initialize();
		await m.push(sender);

		await sender.removeChild('gone.txt');
		await m.push(sender);

		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });

		const v1 = await m2.restore(1);
		const v1tree = await collectTree(v1);
		expect(v1tree.map(t => t.path.join('/'))).toEqual(['gone.txt', 'keep.txt']);
		expect(equalUint8Arrays(
			(await (await v1.findByPath(['gone.txt'])).getContent()),
			seededBytes(1024, 41),
		)).toBe(true);

		const latest = await m2.restore();
		const latestTree = await collectTree(latest);
		expect(latestTree.map(t => t.path.join('/'))).toEqual(['keep.txt']);
		expect(await latest.findByPath(['gone.txt'])).toBeNull();
	}, TX_TIMEOUT);

	it('three versions: add, delete, re-add with different content', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('file.txt', seededBytes(2048, 50));

		await m.initialize();

		// v1: file exists
		await m.push(sender);

		// v2: file deleted
		await sender.removeChild('file.txt');
		await m.push(sender);

		// v3: file re-added with new content
		await sender.addFile('file.txt', seededBytes(2048, 51));
		await m.push(sender);

		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });

		const v1 = await m2.restore(1);
		expect(equalUint8Arrays(
			(await (await v1.findByPath(['file.txt'])).getContent()),
			seededBytes(2048, 50),
		)).toBe(true);

		const v2 = await m2.restore(2);
		expect(await v2.findByPath(['file.txt'])).toBeNull();

		const v3 = await m2.restore(3);
		expect(equalUint8Arrays(
			(await (await v3.findByPath(['file.txt'])).getContent()),
			seededBytes(2048, 51),
		)).toBe(true);
	}, TX_TIMEOUT * 2);
});
