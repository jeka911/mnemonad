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
		expect(lines.some((l) => /balance:\s+\d+(\.\d+)? ETH$/.test(l))).toBe(true);
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

	it('discovers the stream id from .mnemonad and shows full stream info when --manifest is set and no id is given', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, manifest: true })
		);
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		const { lines } = await captureLogs(() =>
			info({ ...baseArgs, streamId: null, path: srcDir, manifest: true })
		);
		expect(lines.some((l) => l.includes('using stream id from .mnemonad manifest'))).toBe(true);
		expect(lines.some((l) => l.includes('stream:') && l.includes(streamId))).toBe(true);
		expect(lines.some((l) => l.includes('versions:') && l.includes('1'))).toBe(true);
		expect(lines.some((l) => l.includes('status:') && l.includes('up to date'))).toBe(true);
	}, TX_TIMEOUT);

	it('still just shows chain/wallet when --manifest is set but no path is given', async () => {
		const baseArgs = await makeBaseArgs();
		const { lines } = await captureLogs(() => info({ ...baseArgs, streamId: null, path: null, manifest: true }));
		expect(lines.some((l) => l.includes('chain:'))).toBe(true);
		expect(lines.some((l) => l.includes('stream:'))).toBe(false);
	});

	it('reports on the folder\'s own stream from its manifest when no id is given, without --manifest', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, manifest: true })
		);
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		// No --manifest this time, and no id — the folder's own manifest names the stream,
		// so this is the full on-chain report for it.
		const { lines } = await captureLogs(() =>
			info({ ...baseArgs, streamId: null, path: srcDir, manifest: false })
		);
		expect(lines.some((l) => l.includes('using stream id from .mnemonad manifest:') && l.includes(streamId))).toBe(true);
		expect(lines.some((l) => l.includes('stream:') && l.includes(streamId))).toBe(true);
	}, TX_TIMEOUT);

	it('notes when an explicitly-given id differs from the folder\'s own manifest', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, manifest: true })
		);
		const manifestStreamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		// A second, unrelated stream, created without touching srcDir's manifest.
		const otherDir = await makeTempDir();
		try {
			await writeTestFile(otherDir, 'b.txt', 'other stream\n');
			const otherStreamId = await pushFolder(baseArgs, otherDir);
			expect(otherStreamId).not.toBe(manifestStreamId);

			const { lines } = await captureLogs(() =>
				info({ ...baseArgs, streamId: otherStreamId, path: srcDir })
			);
			expect(lines.some((l) =>
				l.includes('manifest:') && l.includes(manifestStreamId) && l.includes('differs from the id given') && l.includes(otherStreamId)
			)).toBe(true);
		} finally {
			await cleanupDir(otherDir);
		}
	}, TX_TIMEOUT);

	it('says nothing extra when the given id already matches the folder\'s own manifest', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, manifest: true })
		);
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		const { lines } = await captureLogs(() => info({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('manifest:'))).toBe(false);
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
