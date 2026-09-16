import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { push } from '../lib/commands/push.js';
import { diff } from '../lib/commands/diff.js';
import {
	startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, captureLogs,
} from './fixture.js';

let node;
let srcDir;

beforeAll(async () => {
	node = await startNode();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

beforeEach(async () => {
	srcDir = await makeTempDir();
});

afterEach(async () => {
	await cleanupDir(srcDir);
});

const TX_TIMEOUT = 60_000;

async function pushFolder(baseArgs, dir) {
	const { lines } = await captureLogs(() => push({ ...baseArgs, path: dir }));
	return lines.find((l) => l.includes('created:')).split('created:')[1].trim();
}

describe('diff', () => {
	it('reports no changes when the local folder matches the pushed version', async () => {
		await writeTestFile(srcDir, 'a.txt', 'same\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const { lines } = await captureLogs(() => diff({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('no changes — local folder matches version'))).toBe(true);
	}, TX_TIMEOUT);

	it('reports added, modified and deleted files vs the pushed version', async () => {
		await writeTestFile(srcDir, 'keep.txt', 'unchanged\n');
		await writeTestFile(srcDir, 'change.txt', 'before\n');
		await writeTestFile(srcDir, 'removeme.txt', 'bye\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		await writeTestFile(srcDir, 'change.txt', 'after, and different length\n');
		await writeTestFile(srcDir, 'new.txt', 'brand new\n');
		await import('node:fs/promises').then((fs) => fs.rm(`${srcDir}/removeme.txt`));

		const { lines } = await captureLogs(() => diff({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('added:') && l.includes('new.txt'))).toBe(true);
		expect(lines.some((l) => l.includes('modified:') && l.includes('change.txt'))).toBe(true);
		expect(lines.some((l) => l.includes('deleted:') && l.includes('removeme.txt'))).toBe(true);
		expect(lines.some((l) => l.includes('3 change(s): 1 added, 1 modified, 1 deleted'))).toBe(true);
	}, TX_TIMEOUT);

	it('treats a missing local folder as empty and reports every remote file as deleted', async () => {
		await writeTestFile(srcDir, 'only.txt', 'on chain only\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const missingDir = `${srcDir}-does-not-exist`;
		const { lines } = await captureLogs(() => diff({ ...baseArgs, streamId, path: missingDir }));
		expect(lines.some((l) => l.includes('deleted:') && l.includes('only.txt'))).toBe(true);
	}, TX_TIMEOUT);
});
