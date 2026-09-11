/**
 * Tests for full-snapshot recovery in MonadSync.
 *
 * Background: a watch-command-style bug can cause a diff patch to be pushed with a stale
 * base snapshot (a client's chain-length poll updating ahead of its own sync session's
 * `_lastSnapshot`). The resulting diff on-chain references the wrong `prevSnapshot`, so
 * `restore()` / `_replayRange()` throw when they try to apply it.
 *
 * Fix (see MonadSync.js): `restore()` and `_replayRange()` treat a full snapshot
 * (DoubleSyncPatch) at any chain position as a recovery point — resetting all state and
 * skipping any corrupt diffs that preceded it.
 *
 * These tests verify that behaviour end-to-end against a real Mnemonad stream. The
 * corruption itself is a DoubleSync-level hash mismatch (`applyDiffPatch` rejecting a
 * `prevSnapshot` that doesn't match), not anything chain-specific.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { DoubleSync, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';
import MonadSync from '../MonadSync.js';
import { seededBytes, equalUint8Arrays, treesEqual } from './helpers.js';
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
	return new MonadSync({ mnemonad: mn, sync: new DoubleSync({ avgSize: 4096 }) });
}

/**
 * Push a full snapshot at the current chain position, bypassing chain replay.
 * Mirrors the CLI --force-snapshot behaviour used to repair corrupt streams.
 */
async function forceFullSnapshot(msync, mn, folder) {
	await mn.initialize();
	msync._isInitialized = true;
	msync._lastSnapshot = null;
	msync._replayedCount = mn.length;
	return msync.push(folder);
}

/**
 * Build a minimal corrupt chain that reproduces the watch-command bug.
 *
 * Chain layout after this returns:
 *   index 0: full snapshot  (folder_v1 — "a.txt" seed 1)
 *   index 1: valid diff      (folder_v2 — "a.txt" seed 2)
 *   index 2: corrupt diff    (diff built against v1 snapshot, positioned at index 2
 *                             — applyDiffPatch fails because prevSnapshot ≠ v2 snapshot)
 *
 * Returns { mn, msync, folder_v1, folder_v2, folder_v3 } so callers can build on top.
 */
async function buildCorruptChain() {
	const mn = await createMonad();
	const msync = makeMonadSync(mn);

	// v0: full snapshot pushed by msync
	const folder_v1 = new DoubleSyncMemoryFolder('root');
	await folder_v1.addFile('a.txt', seededBytes(2048, 1));
	await msync.initialize();
	await msync.push(folder_v1);
	// msync._replayedCount = 1, _lastSnapshot = snap_v1

	// v1: valid diff pushed by a separate msync instance (simulates another client)
	const mn2 = reopen(mn.id);
	const msync2 = makeMonadSync(mn2);
	const folder_v2 = new DoubleSyncMemoryFolder('root');
	await folder_v2.addFile('a.txt', seededBytes(2048, 2));
	await msync2.initialize();
	await msync2.push(folder_v2);
	// chain length is now 2; msync doesn't know yet

	// Simulate the watch bug: mn.length gets updated (by a poll) but msync state stays stale
	mn.reInitialize();
	await mn.initialize();
	// mn.length = 2, but msync._lastSnapshot is still snap_v1

	// v2: corrupt diff — msync builds against snap_v1 but the append lands it at index 2
	const folder_v3 = new DoubleSyncMemoryFolder('root');
	await folder_v3.addFile('a.txt', seededBytes(2048, 3));
	await msync.push(folder_v3);
	// restore() will now fail: diff at index 2 expects prevSnapshot=snap_v1,
	// but restore() hands it prevSnapshot=snap_v2

	return { mn, msync, folder_v1, folder_v2, folder_v3 };
}

// ─── 1. restore() on corrupt chain ───────────────────────────────────────────

describe('restore() on corrupt chain', () => {
	it('throws when chain ends in corrupt state with no recovery snapshot', async () => {
		const { mn } = await buildCorruptChain();
		const reader = makeMonadSync(reopen(mn.id));
		await expect(reader.restore()).rejects.toThrow('corrupt state');
	}, TX_TIMEOUT * 3);

	it('restore(n) to the last good version still succeeds', async () => {
		const { mn, folder_v2 } = await buildCorruptChain();
		const reader = makeMonadSync(reopen(mn.id));

		// version 2 = first two items (full + valid diff) — before the corrupt one
		const restored = await reader.restore(2);
		expect(await treesEqual(restored, folder_v2)).toBe(true);
	}, TX_TIMEOUT * 3);
});

// ─── 2. force-snapshot repair ────────────────────────────────────────────────

describe('force-snapshot repair', () => {
	it('restore() skips corrupt diff and recovers at the new full snapshot', async () => {
		const { mn, msync } = await buildCorruptChain();

		// Repair: push a full snapshot at the current chain tip
		const folder_v4 = new DoubleSyncMemoryFolder('root');
		await folder_v4.addFile('a.txt', seededBytes(2048, 4));
		await folder_v4.addFile('b.txt', seededBytes(512, 40));
		await forceFullSnapshot(msync, mn, folder_v4);

		// restore() must skip index 2 (corrupt diff) and recover from index 3 (full)
		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();
		expect(await treesEqual(restored, folder_v4)).toBe(true);
	}, TX_TIMEOUT * 3);

	it('file content from recovery snapshot is byte-equal to what was pushed', async () => {
		const { mn, msync } = await buildCorruptChain();

		const expected = seededBytes(4096, 99);
		const folder_v4 = new DoubleSyncMemoryFolder('root');
		await folder_v4.addFile('recovery.bin', expected);
		await forceFullSnapshot(msync, mn, folder_v4);

		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();
		const file = await restored.findByPath(['recovery.bin']);
		expect(file).not.toBeNull();
		const content = await file.getContent();
		expect(equalUint8Arrays(content, expected)).toBe(true);
	}, TX_TIMEOUT * 3);
});

// ─── 3. push after repair ────────────────────────────────────────────────────

describe('push after repair', () => {
	it('diff pushed on same msync instance after force-snapshot is applied correctly', async () => {
		const { mn, msync } = await buildCorruptChain();

		const folder_v4 = new DoubleSyncMemoryFolder('root');
		await folder_v4.addFile('a.txt', seededBytes(2048, 4));
		await forceFullSnapshot(msync, mn, folder_v4);
		// msync._lastSnapshot is now snap_v4

		// Edit and push another diff via the same instance
		const folder_v5 = new DoubleSyncMemoryFolder('root');
		await folder_v5.addFile('a.txt', seededBytes(2048, 5));
		await folder_v5.addFile('new.txt', seededBytes(256, 50));
		await msync.push(folder_v5);

		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();
		expect(await treesEqual(restored, folder_v5)).toBe(true);
	}, TX_TIMEOUT * 3);

	it('fresh msync initializes through corrupt history and pushes a correct diff', async () => {
		// This specifically tests _replayRange() recovery: a brand-new MonadSync instance
		// calls initialize() which replays the whole chain including the corrupt diff, and
		// must survive it by resetting at the subsequent full snapshot.
		const { mn, msync } = await buildCorruptChain();

		const folder_v4 = new DoubleSyncMemoryFolder('root');
		await folder_v4.addFile('a.txt', seededBytes(2048, 4));
		await forceFullSnapshot(msync, mn, folder_v4);

		// Fresh instance — initialize() triggers _replayRange(0, 4)
		const mn3 = reopen(mn.id);
		const msync3 = makeMonadSync(mn3);
		await msync3.initialize();   // must not throw despite corrupt index 2
		expect(msync3._lastSnapshot).not.toBeNull();

		const folder_v5 = new DoubleSyncMemoryFolder('root');
		await folder_v5.addFile('a.txt', seededBytes(2048, 5));
		await msync3.push(folder_v5);

		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();
		expect(await treesEqual(restored, folder_v5)).toBe(true);
	}, TX_TIMEOUT * 3);
});

// ─── 4. no regression on clean chains ────────────────────────────────────────

describe('no regression on clean chains', () => {
	it('full snapshot mid-chain (no corruption) is treated as a new baseline', async () => {
		// Push v1 normally, then push v2 as an intentional mid-chain full snapshot, then
		// push v3 as a diff on top of v2. restore() should return v3 state.
		const mn = await createMonad();
		const msync = makeMonadSync(mn);

		const folder_v1 = new DoubleSyncMemoryFolder('root');
		await folder_v1.addFile('x.txt', seededBytes(1024, 10));
		await msync.initialize();
		await msync.push(folder_v1);

		// Intentional mid-chain full snapshot (e.g. after a long divergence)
		const folder_v2 = new DoubleSyncMemoryFolder('root');
		await folder_v2.addFile('y.txt', seededBytes(1024, 20));
		await forceFullSnapshot(msync, mn, folder_v2);

		// Diff on top of v2
		const folder_v3 = new DoubleSyncMemoryFolder('root');
		await folder_v3.addFile('y.txt', seededBytes(1024, 21));
		await folder_v3.addFile('z.txt', seededBytes(512, 30));
		await msync.push(folder_v3);

		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();
		expect(await treesEqual(restored, folder_v3)).toBe(true);
	}, TX_TIMEOUT * 3);

	it('sequential normal pushes are unaffected', async () => {
		const mn = await createMonad();
		const msync = makeMonadSync(mn);
		await msync.initialize();

		const folders = [];
		for (let i = 0; i < 3; i++) {
			const f = new DoubleSyncMemoryFolder('root');
			await f.addFile('doc.txt', seededBytes(1024, i + 100));
			folders.push(f);
			await msync.push(f);
		}

		const reader = makeMonadSync(reopen(mn.id));
		const restored = await reader.restore();
		expect(await treesEqual(restored, folders[2])).toBe(true);
	}, TX_TIMEOUT * 3);
});
