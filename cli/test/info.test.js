import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { push } from '../lib/commands/push.js';
import { info } from '../lib/commands/info.js';
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

describe('info', () => {
	it('shows chain and wallet with no stream-id given', async () => {
		const baseArgs = await makeBaseArgs();
		const { lines } = await captureLogs(() => info({ ...baseArgs, streamId: null }));
		expect(lines.some((l) => l.includes('chain:') && l.includes('local'))).toBe(true);
		expect(lines.some((l) => l.includes('your wallet:') && l.toLowerCase().includes(baseArgs.accountAddress.toLowerCase()))).toBe(true);
	});

	it('shows owner (marked as you), version count and up-to-date status for a matching local folder', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const { lines } = await captureLogs(() => info({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.toLowerCase().includes('owner:') && l.toLowerCase().includes(baseArgs.accountAddress.toLowerCase()) && l.includes('(you)'))).toBe(true);
		expect(lines.some((l) => l.includes('encrypted:') && l.includes('no'))).toBe(true);
		expect(lines.some((l) => l.includes('versions:') && l.includes('1'))).toBe(true);
		expect(lines.some((l) => l.includes('local matches:') && l.includes('version 1'))).toBe(true);
		expect(lines.some((l) => l.includes('status:') && l.includes('up to date'))).toBe(true);
	}, TX_TIMEOUT);

	it('reports how many versions behind when the local folder matches an older version', async () => {
		await writeTestFile(srcDir, 'a.txt', 'v1\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		// Preserve a copy of the v1 folder contents on disk, push v2, then point info at
		// a folder that still has v1's exact content.
		const { readFile, writeFile } = await import('node:fs/promises');
		const v1Content = await readFile(`${srcDir}/a.txt`);
		await writeTestFile(srcDir, 'a.txt', 'v2, now different\n');
		await push({ ...baseArgs, path: srcDir, streamId });
		await writeFile(`${srcDir}/a.txt`, v1Content);

		const { lines } = await captureLogs(() => info({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('local matches:') && l.includes('version 1'))).toBe(true);
		expect(lines.some((l) => l.includes('behind by:') && l.includes('1'))).toBe(true);
	}, TX_TIMEOUT);

	it('notes truncated history after compact', async () => {
		await writeTestFile(srcDir, 'a.txt', 'v1\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const { compact } = await import('../lib/commands/compact.js');
		await captureLogs(() => compact({ ...baseArgs, streamId, path: srcDir }));

		const { lines } = await captureLogs(() => info({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('history starts:') && l.includes('truncated'))).toBe(true);
	}, TX_TIMEOUT);

	it('declines to compare against an encrypted stream without --password', async () => {
		await writeTestFile(srcDir, 'secret.txt', 'shh\n');
		const baseArgs = await makeBaseArgs();
		const password = 'correct horse battery staple';
		const streamId = await pushFolder({ ...baseArgs, encrypt: true, password }, srcDir);

		const { lines } = await captureLogs(() => info({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('encrypted:') && l.includes('yes'))).toBe(true);
		expect(lines.some((l) => l.includes('provide --password'))).toBe(true);
	}, TX_TIMEOUT);
});
