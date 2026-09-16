import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { push } from '../lib/commands/push.js';
import { pull } from '../lib/commands/pull.js';
import {
	startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, readTree, captureLogs,
} from './fixture.js';

let node;
let srcDir;
let destDir;

beforeAll(async () => {
	node = await startNode();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

beforeEach(async () => {
	srcDir = await makeTempDir('mnemonad-cli-src-');
	destDir = await makeTempDir('mnemonad-cli-dest-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
	await cleanupDir(destDir);
});

const TX_TIMEOUT = 60_000;

async function pushFolder(baseArgs, dir) {
	const { lines } = await captureLogs(() => push({ ...baseArgs, path: dir }));
	return lines.find((l) => l.includes('created:')).split('created:')[1].trim();
}

describe('pull', () => {
	it('restores a pushed folder byte-for-byte into a fresh directory', async () => {
		await writeTestFile(srcDir, 'readme.md', 'hello world\n');
		await writeTestFile(srcDir, 'nested/deep/file.bin', Buffer.from([1, 2, 3, 4, 5]));

		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		await pull({ ...baseArgs, streamId, path: destDir });

		const srcTree = await readTree(srcDir);
		const destTree = await readTree(destDir);
		expect(Object.keys(destTree).sort()).toEqual(Object.keys(srcTree).sort());
		for (const relPath of Object.keys(srcTree)) {
			expect(destTree[relPath].equals(srcTree[relPath])).toBe(true);
		}
	}, TX_TIMEOUT);

	it('restores into a destination directory that does not exist yet', async () => {
		// makeTempDir() (used for destDir elsewhere) already creates the directory itself —
		// this exercises the real first-ever-pull case, where nothing has mkdir'd the
		// destination and a root-level file would otherwise have nowhere to be written.
		await writeTestFile(srcDir, 'readme.md', 'brand new destination\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const freshDest = `${destDir}/not-created-yet`;
		await pull({ ...baseArgs, streamId, path: freshDest });

		const destTree = await readTree(freshDest);
		expect(destTree['readme.md'].toString('utf8')).toBe('brand new destination\n');
	}, TX_TIMEOUT);

	it('deletes local files that no longer exist in the pulled version', async () => {
		await writeTestFile(srcDir, 'keep.txt', 'stays\n');
		await writeTestFile(srcDir, 'gone.txt', 'will be deleted\n');

		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);
		await pull({ ...baseArgs, streamId, path: destDir });
		expect(Object.keys(await readTree(destDir)).sort()).toEqual(['gone.txt', 'keep.txt']);

		await import('node:fs/promises').then((fs) => fs.rm(`${srcDir}/gone.txt`));
		await push({ ...baseArgs, path: srcDir, streamId });

		await pull({ ...baseArgs, streamId, path: destDir });
		expect(Object.keys(await readTree(destDir)).sort()).toEqual(['keep.txt']);
	}, TX_TIMEOUT);

	it('requires --password for an encrypted stream and succeeds once given', async () => {
		await writeTestFile(srcDir, 'secret.txt', 'classified\n');
		const baseArgs = await makeBaseArgs();
		const password = 'correct horse battery staple';
		const streamId = await pushFolder({ ...baseArgs, encrypt: true, password }, srcDir);

		await expect(pull({ ...baseArgs, streamId, path: destDir })).rejects.toThrow(/encrypted/);

		await pull({ ...baseArgs, streamId, path: destDir, password });
		const destTree = await readTree(destDir);
		expect(destTree['secret.txt'].toString('utf8')).toBe('classified\n');
	}, TX_TIMEOUT);

	it('throws when no stream-id is given', async () => {
		const baseArgs = await makeBaseArgs();
		await expect(pull({ ...baseArgs, streamId: null, path: destDir })).rejects.toThrow(/stream-id is required/);
	});
});
