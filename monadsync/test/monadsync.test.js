/**
 * Integration tests for MonadSync — stores DoubleSync patches inside a real
 * Mnemonad stream on a local Hardhat node.
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
	DoubleSync,
	DoubleSyncMemoryFolder,
	DoubleSyncFormat,
	DoubleSyncDiffPatch,
	DoubleSyncFile,
	DoubleSyncFolder,
} from '@fizzyflow/doublesync';
import MonadSync from '../MonadSync.js';
import { equalUint8Arrays, seededBytes, collectTree, treesEqual } from './helpers.js';
import { startNode, makeClients, createMn, makeMn } from './fixture.js';

const TX_TIMEOUT = 60_000;

let node;
let clients;
let contractAddress;

// ─── setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
	node = await startNode();
	clients = makeClients();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function createMonad(params = {}) {
	const { mn, contractAddress: addr } = await createMn(clients, params);
	contractAddress = addr;
	return mn;
}

function reopen(id) {
	return makeMn(clients, contractAddress, id);
}

function makeSync() {
	return new DoubleSync({ avgSize: 1024 });
}

// ─── single push + restore ───────────────────────────────────────────────────

describe('single push and restore', () => {
	it('pushes a tree and restores it identically', async () => {
		const mn = await createMonad();
		const m = new MonadSync({ mnemonad: mn, sync: makeSync() });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('readme.md', seededBytes(2048, 1));
		const src = await sender.addFolder('src');
		await src.addFile('index.js', seededBytes(4096, 2));
		await src.addFile('utils.js', seededBytes(3072, 3));

		await m.initialize();
		const { version } = await m.push(sender);
		expect(version).toBe(1);

		// Read back from a separate reader instance
		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();
		expect(await treesEqual(sender, restored)).toBe(true);
	}, TX_TIMEOUT);

	it('first push produces a full DoubleSyncPatch on chain', async () => {
		const mn = await createMonad();
		const m = new MonadSync({ mnemonad: mn, sync: makeSync() });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('a.txt', seededBytes(512, 10));

		await m.initialize();
		await m.push(sender);

		const raw = await mn.at(0);
		expect(DoubleSyncFormat.detect(raw)).toBe('patch');
	}, TX_TIMEOUT);

	it('restore of empty stream returns empty folder', async () => {
		const mn = await createMonad();
		const m = new MonadSync({ mnemonad: mn });
		const folder = await m.restore();
		expect(folder).toBeInstanceOf(DoubleSyncMemoryFolder);
		const children = await folder.list();
		expect(children.length).toBe(0);
	}, TX_TIMEOUT);
});

// ─── multi-version push + restore ────────────────────────────────────────────

describe('multi-version push and restore', () => {
	it('chain of 3 edits: full then diffs, all restore correctly', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await m.initialize();

		// v1: initial tree
		await sender.addFile('readme.md', seededBytes(2048, 20));
		const src = await sender.addFolder('src');
		await src.addFile('index.js', seededBytes(4096, 21));
		await m.push(sender);

		// v2: add a file
		await src.addFile('utils.js', seededBytes(3072, 22));
		await m.push(sender);

		// v3: edit readme
		const readme = await sender.findByPath(['readme.md']);
		const old = await readme.getContent();
		const edited = new Uint8Array(old.length + 1);
		edited.set(old.subarray(0, 512));
		edited[512] = 0x21;
		edited.set(old.subarray(512), 513);
		await readme.setContent(edited);
		await m.push(sender);

		mn.reInitialize();
		await mn.initialize();
		expect(mn.length).toBe(3);

		// First item is a full patch, rest are diff patches
		expect(DoubleSyncFormat.detect(await mn.at(0))).toBe('patch');
		expect(DoubleSyncFormat.detect(await mn.at(1))).toBe('diff-patch');
		expect(DoubleSyncFormat.detect(await mn.at(2))).toBe('diff-patch');

		// Restore latest
		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const latest = await m2.restore();
		expect(await treesEqual(sender, latest)).toBe(true);

		// Restore v1 only
		const v1 = await m2.restore(1);
		const v1files = await collectTree(v1);
		const v1paths = v1files.map(f => f.path.join('/'));
		expect(v1paths).toContain('readme.md');
		expect(v1paths).toContain('src/index.js');
		expect(v1paths).not.toContain('src/utils.js');

		// Restore v2
		const v2 = await m2.restore(2);
		const v2files = await collectTree(v2);
		const v2paths = v2files.map(f => f.path.join('/'));
		expect(v2paths).toContain('src/utils.js');
	}, TX_TIMEOUT * 3);

	it('diff patches are smaller than the full patch', async () => {
		// The two files here (16KB + 8KB) produce a ~26KB DoubleSyncPatch document once
		// CDC/manifest overhead is added — over the fixture's default maxChunkBytes
		// (20000). Raising maxChunkBytes itself just moves the problem: a single on-chain
		// CODE-store chunk is still a deployed contract's *runtime code*, so a local
		// Hardhat node's standard EIP-170 24576-byte contract-size cap throws
		// `DeployFailed()` well before any Mnemonad-side limit does (real Monad allows
		// much more; this is a local-node-only ceiling). `{ onChain: true }` — exactly
		// what Mnemonad's own error message suggests — instead pushes the oversized full
		// patch across several smaller staged chunks under one item, no size tuning
		// needed; the small diff patch below never exceeds maxChunkBytes in the first
		// place, so the same flag on it is a no-op.
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('big.bin', seededBytes(16 * 1024, 30));
		await sender.addFile('other.bin', seededBytes(8 * 1024, 31));

		await m.initialize();
		await m.push(sender, { onChain: true });

		// Small edit
		const big = await sender.findByPath(['big.bin']);
		const old = await big.getContent();
		const edited = new Uint8Array(old.length + 1);
		edited.set(old.subarray(0, 4096));
		edited[4096] = 0xab;
		edited.set(old.subarray(4096), 4097);
		await big.setContent(edited);

		await m.push(sender, { onChain: true });

		const fullPatchSize = (await mn.at(0)).length;
		const diffPatchSize = (await mn.at(1)).length;
		expect(diffPatchSize).toBeLessThan(fullPatchSize);
	}, TX_TIMEOUT * 2);
});

// ─── initialize rebuilds state ───────────────────────────────────────────────

describe('initialize rebuilds sender state from chain', () => {
	it('new MonadSync on a populated stream continues with diff patches', async () => {
		const mn = await createMonad();
		const sync = makeSync();

		// First sender pushes 2 versions
		const m1 = new MonadSync({ mnemonad: mn, sync });
		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('a.txt', seededBytes(2048, 40));
		await m1.initialize();
		await m1.push(sender);

		await sender.addFile('b.txt', seededBytes(2048, 41));
		await m1.push(sender);

		// Second sender creates a fresh MonadSync on the same stream
		const mn2 = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mn2, sync: makeSync() });
		await m2.initialize();

		// Next push should be a diff patch (not a full patch)
		await sender.addFile('c.txt', seededBytes(1024, 42));
		await m2.push(sender);

		mn2.reInitialize();
		await mn2.initialize();
		expect(mn2.length).toBe(3);
		expect(DoubleSyncFormat.detect(await mn2.at(2))).toBe('diff-patch');

		// Restore validates full chain
		const mnReader = reopen(mn.id);
		const m3 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m3.restore();
		expect(await treesEqual(sender, restored)).toBe(true);
	}, TX_TIMEOUT * 3);
});

// ─── getPatch ────────────────────────────────────────────────────────────────

describe('getPatch', () => {
	it('returns raw patch bytes at index', async () => {
		const mn = await createMonad();
		const m = new MonadSync({ mnemonad: mn, sync: makeSync() });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('file.txt', seededBytes(512, 50));
		await m.initialize();
		await m.push(sender);

		const raw = await m.getPatch(0);
		expect(raw).toBeInstanceOf(Uint8Array);
		expect(DoubleSyncFormat.isDoubleSync(raw)).toBe(true);
	}, TX_TIMEOUT);
});

// ─── length ──────────────────────────────────────────────────────────────────

describe('length', () => {
	it('reflects chain length after pushes', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		expect(await m.length()).toBe(0);

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('a.txt', seededBytes(256, 60));
		await m.initialize();
		await m.push(sender);

		expect(await m.length()).toBe(1);

		await sender.addFile('b.txt', seededBytes(256, 61));
		await m.push(sender);

		expect(await m.length()).toBe(2);
	}, TX_TIMEOUT * 2);
});

// ─── compression ─────────────────────────────────────────────────────────────

describe('compression', () => {
	it('compressed patches are stored on chain and restored correctly', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync, compress: 'gzip' });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('readme.md', seededBytes(2048, 70));
		const src = await sender.addFolder('src');
		await src.addFile('index.js', seededBytes(4096, 71));

		await m.initialize();
		await m.push(sender);

		// First patch should be compressed on chain
		const raw = await mn.at(0);
		expect(DoubleSyncFormat.detect(raw)).toBe('compressed');

		// Edit and push again
		await sender.addFile('changelog.md', seededBytes(1024, 72));
		await m.push(sender);

		const raw2 = await mn.at(1);
		expect(DoubleSyncFormat.detect(raw2)).toBe('compressed');

		// Restore from a non-compressed reader (auto-detects)
		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();
		expect(await treesEqual(sender, restored)).toBe(true);
	}, TX_TIMEOUT * 2);
});

// ─── no-op push ──────────────────────────────────────────────────────────────

describe('no-op push', () => {
	it('no-change push produces a diff with zero ops', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFile('stable.txt', seededBytes(4096, 80));

		await m.initialize();
		await m.push(sender);

		// Push again with no changes
		await m.push(sender);

		const diffBytes = await mn.at(1);
		expect(DoubleSyncFormat.detect(diffBytes)).toBe('diff-patch');
		const parsed = new DoubleSyncDiffPatch(diffBytes);
		expect(parsed.opCount).toBe(0);
		expect(parsed.chunkCount).toBe(0);

		// Restore still works
		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();
		expect(await treesEqual(sender, restored)).toBe(true);
	}, TX_TIMEOUT * 2);
});

// ─── empty folders ───────────────────────────────────────────────────────────

describe('empty folders', () => {
	it('preserves empty folders through push and restore', async () => {
		const mn = await createMonad();
		const m = new MonadSync({ mnemonad: mn, sync: makeSync() });

		const sender = new DoubleSyncMemoryFolder('proj');
		await sender.addFolder('empty');
		const nested = await sender.addFolder('nested');
		await nested.addFolder('also-empty');
		await sender.addFile('file.txt', new Uint8Array([1, 2, 3]));

		await m.initialize();
		await m.push(sender);

		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();

		const e1 = await restored.findByPath(['empty']);
		expect(e1).toBeInstanceOf(DoubleSyncFolder);
		const e2 = await restored.findByPath(['nested', 'also-empty']);
		expect(e2).toBeInstanceOf(DoubleSyncFolder);
		const f = await restored.findByPath(['file.txt']);
		expect(f).toBeInstanceOf(DoubleSyncFile);
	}, TX_TIMEOUT);
});

// ─── larger tree with incremental edits ──────────────────────────────────────

describe('larger tree with incremental edits', () => {
	it('20 files across 4 folders, edit 3, restore matches', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		const folders = [];
		for (let f = 0; f < 4; f++) {
			const folder = await sender.addFolder(`dir${f}`);
			folders.push(folder);
			for (let i = 0; i < 5; i++) {
				await folder.addFile(`file${i}.bin`, seededBytes(512 + i * 128, f * 100 + i));
			}
		}

		await m.initialize();
		await m.push(sender);

		// Edit 3 files in different folders
		const f0 = await folders[0].findByPath(['file0.bin']);
		await f0.setContent(seededBytes(1024, 999));
		const f2 = await folders[2].findByPath(['file3.bin']);
		await f2.setContent(seededBytes(1024, 998));
		const f3 = await folders[3].findByPath(['file4.bin']);
		await f3.setContent(seededBytes(1024, 997));

		await m.push(sender);

		// Restore
		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const restored = await m2.restore();
		expect(await treesEqual(sender, restored)).toBe(true);
	}, TX_TIMEOUT * 2);
});

// ─── partial restore (specific version) ──────────────────────────────────────

describe('partial restore', () => {
	it('restore(N) stops at version N', async () => {
		const mn = await createMonad();
		const sync = makeSync();
		const m = new MonadSync({ mnemonad: mn, sync });

		const sender = new DoubleSyncMemoryFolder('proj');
		await m.initialize();

		// v1
		await sender.addFile('a.txt', seededBytes(512, 90));
		await m.push(sender);

		// v2
		await sender.addFile('b.txt', seededBytes(512, 91));
		await m.push(sender);

		// v3
		await sender.addFile('c.txt', seededBytes(512, 92));
		await m.push(sender);

		// restore(2) should have a.txt and b.txt but not c.txt
		const mnReader = reopen(mn.id);
		const m2 = new MonadSync({ mnemonad: mnReader, sync: makeSync() });
		const v2 = await m2.restore(2);
		const v2tree = await collectTree(v2);
		const v2paths = v2tree.map(f => f.path.join('/'));
		expect(v2paths).toContain('a.txt');
		expect(v2paths).toContain('b.txt');
		expect(v2paths).not.toContain('c.txt');

		// restore(1) should have only a.txt
		const v1 = await m2.restore(1);
		const v1tree = await collectTree(v1);
		expect(v1tree.map(f => f.path.join('/'))).toEqual(['a.txt']);
	}, TX_TIMEOUT * 3);
});
