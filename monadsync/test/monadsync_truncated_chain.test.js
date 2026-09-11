/**
 * Tests for MonadSync against a truncated stream prefix.
 *
 * `Mnemonad.truncateFrom(uptoIndex)` drops everything before `uptoIndex` and advances
 * `firstAvailableIndex` — MonadSync's `initialize()`/`restore()`/`getTreeHash()` all use
 * that field to skip a dropped prefix instead of failing on it (see MonadSync.js's own doc).
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { DoubleSync, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';
import MonadSync from '../MonadSync.js';
import { seededBytes, treesEqual } from './helpers.js';
import { startNode, makeClients, createMn, makeMn } from './fixture.js';

const TX_TIMEOUT = 60_000;

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

function makeMonadSync(mn) {
	return new MonadSync({ mnemonad: mn, sync: new DoubleSync({ avgSize: 1024 }) });
}

/**
 * Push a full snapshot at the current chain position, bypassing chain replay — same
 * "force a fresh baseline" pattern the snapshot-recovery suite uses, needed here to get a
 * full snapshot sitting at the exact index `truncateFrom` will later keep.
 */
async function forceFullSnapshot(msync, mn, folder) {
	await mn.initialize();
	msync._isInitialized = true;
	msync._lastSnapshot = null;
	msync._replayedCount = mn.length;
	return msync.push(folder);
}

describe('truncated prefix', () => {
	it('truncateFrom advances firstAvailableIndex and reading a dropped index throws IndexTruncated', async () => {
		const mn = await createMonad();
		const msync = makeMonadSync(mn);

		const folder_v1 = new DoubleSyncMemoryFolder('root');
		await folder_v1.addFile('a.txt', seededBytes(1024, 1));
		await msync.initialize();
		await msync.push(folder_v1);

		await folder_v1.addFile('b.txt', seededBytes(1024, 2));
		await msync.push(folder_v1);

		await mn.truncateFrom(1);
		await mn.initialize();
		expect(mn.firstAvailableIndex).toBe(1);

		await expect(mn.at(0)).rejects.toThrow(/IndexTruncated/);
		// Index 1 is still readable.
		await expect(mn.at(1)).resolves.toBeInstanceOf(Uint8Array);
	}, TX_TIMEOUT * 2);

	it('initialize() on a fresh instance starts replay at firstAvailableIndex, not 0', async () => {
		const mn = await createMonad();
		const msync = makeMonadSync(mn);

		// v1 (full) + v2 (diff) + v3 (forced full snapshot) — v3 becomes the recovery
		// point truncateFrom will keep.
		const folder_v1 = new DoubleSyncMemoryFolder('root');
		await folder_v1.addFile('x.txt', seededBytes(1024, 10));
		await msync.initialize();
		await msync.push(folder_v1);

		await folder_v1.addFile('y.txt', seededBytes(1024, 11));
		await msync.push(folder_v1);

		const folder_v3 = new DoubleSyncMemoryFolder('root');
		await folder_v3.addFile('z.txt', seededBytes(1024, 12));
		await forceFullSnapshot(msync, mn, folder_v3);

		// Drop indices 0 and 1 — only the forced full snapshot at index 2 remains readable.
		await mn.truncateFrom(2);

		const mnFresh = reopen(mn.id);
		const msyncFresh = makeMonadSync(mnFresh);
		await msyncFresh.initialize(); // must not throw despite indices 0-1 being gone
		expect(msyncFresh._replayedCount).toBe(3);
		expect(msyncFresh._lastSnapshot).not.toBeNull();

		// A push from here produces a diff against the recovered snapshot, not a full patch.
		const folder_v4 = new DoubleSyncMemoryFolder('root');
		await folder_v4.addFile('z.txt', seededBytes(1024, 13));
		await msyncFresh.push(folder_v4);

		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();
		expect(await treesEqual(restored, folder_v4)).toBe(true);
	}, TX_TIMEOUT * 3);

	it('restore() skips the truncated prefix and rebuilds from the surviving full snapshot', async () => {
		const mn = await createMonad();
		const msync = makeMonadSync(mn);

		const folder_v1 = new DoubleSyncMemoryFolder('root');
		await folder_v1.addFile('old.txt', seededBytes(1024, 20));
		await msync.initialize();
		await msync.push(folder_v1);

		const folder_v2 = new DoubleSyncMemoryFolder('root');
		await folder_v2.addFile('fresh.txt', seededBytes(1024, 21));
		await folder_v2.addFile('other.bin', seededBytes(2048, 22));
		await forceFullSnapshot(msync, mn, folder_v2);

		await mn.truncateFrom(1);

		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();

		const names = (await restored.list()).map((f) => f.name);
		expect(names).toContain('fresh.txt');
		expect(names).toContain('other.bin');
		expect(names).not.toContain('old.txt');
	}, TX_TIMEOUT * 2);

	it('getTreeHash resolves the latest version without touching the truncated prefix', async () => {
		const mn = await createMonad();
		const msync = makeMonadSync(mn);

		const folder_v1 = new DoubleSyncMemoryFolder('root');
		await folder_v1.addFile('a.txt', seededBytes(1024, 30));
		await msync.initialize();
		await msync.push(folder_v1);

		const folder_v2 = new DoubleSyncMemoryFolder('root');
		await folder_v2.addFile('b.txt', seededBytes(1024, 31));
		await forceFullSnapshot(msync, mn, folder_v2);

		await folder_v2.addFile('c.txt', seededBytes(1024, 32));
		await msync.push(folder_v2);

		await mn.truncateFrom(1);

		const reader = makeMonadSync(reopen(mn.id));
		const hash = await reader.getTreeHash();
		expect(hash).toBeInstanceOf(Uint8Array);
		expect(hash.length).toBe(32);
		expect(hash.some((b) => b !== 0)).toBe(true);
	}, TX_TIMEOUT * 2);
});
