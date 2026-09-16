import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { push } from '../lib/commands/push.js';
import { pull } from '../lib/commands/pull.js';
import { compact } from '../lib/commands/compact.js';
import {
	startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, readTree, captureLogs,
} from './fixture.js';
import { DEV_KEYS } from '../../js/test/fixture.js';

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
	srcDir = await makeTempDir('mnemonad-cli-compact-src-');
	destDir = await makeTempDir('mnemonad-cli-compact-dest-');
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

describe('compact', () => {
	it('drops old history and still restores correctly afterward', async () => {
		await writeTestFile(srcDir, 'a.txt', 'v1\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		await writeTestFile(srcDir, 'a.txt', 'v2, now with more content\n');
		await push({ ...baseArgs, path: srcDir, streamId });
		await writeTestFile(srcDir, 'b.txt', 'added in v3\n');
		await push({ ...baseArgs, path: srcDir, streamId });

		const { lines } = await captureLogs(() => compact({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('dropped') && l.includes('history entries'))).toBe(true);
		expect(lines.some((l) => l.includes('not a cost refund'))).toBe(true);

		await pull({ ...baseArgs, streamId, path: destDir });
		const destTree = await readTree(destDir);
		expect(destTree['a.txt'].toString('utf8')).toBe('v2, now with more content\n');
		expect(destTree['b.txt'].toString('utf8')).toBe('added in v3\n');
	}, TX_TIMEOUT);

	it('can be run again after an earlier compact and still restores correctly', async () => {
		await writeTestFile(srcDir, 'a.txt', 'v1\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);
		await captureLogs(() => compact({ ...baseArgs, streamId, path: srcDir }));

		await writeTestFile(srcDir, 'a.txt', 'v-after-first-compact\n');
		await push({ ...baseArgs, path: srcDir, streamId });

		const { lines } = await captureLogs(() => compact({ ...baseArgs, streamId, path: srcDir }));
		expect(lines.some((l) => l.includes('dropped') && l.includes('history entries'))).toBe(true);

		await pull({ ...baseArgs, streamId, path: destDir });
		const destTree = await readTree(destDir);
		expect(destTree['a.txt'].toString('utf8')).toBe('v-after-first-compact\n');
	}, TX_TIMEOUT);

	it('requires stream-id', async () => {
		const baseArgs = await makeBaseArgs();
		await expect(compact({ ...baseArgs, streamId: null, path: srcDir })).rejects.toThrow(/stream-id is required/);
	});

	it('refuses to compact a stream owned by someone else', async () => {
		await writeTestFile(srcDir, 'a.txt', 'mine\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const intruder = { ...baseArgs, streamId, path: srcDir, key: DEV_KEYS[1] };
		await expect(compact(intruder)).rejects.toThrow(/owned by/);
	}, TX_TIMEOUT);
});
