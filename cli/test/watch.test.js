import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { push } from '../lib/commands/push.js';
import { pull } from '../lib/commands/pull.js';
import { watch } from '../lib/commands/watch.js';
import { search } from '../lib/commands/search.js';
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
	srcDir = await makeTempDir('mnemonad-cli-watch-src-');
	destDir = await makeTempDir('mnemonad-cli-watch-dest-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
	await cleanupDir(destDir);
});

const TX_TIMEOUT = 60_000;

/** Polls `check()` until it returns truthy, or throws once `timeoutMs` elapses. */
async function waitFor(check, timeoutMs = 20_000, intervalMs = 200) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = check();
		if (result) return result;
		if (Date.now() > deadline) throw new Error('waitFor: timed out');
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/** Runs `watch()` in the background, capturing its console output, until SIGINT is sent. */
function startWatch(args) {
	const lines = [];
	const original = console.log;
	console.log = (...a) => { lines.push(a.map(String).join(' ')); original.call(console, ...a); };
	const donePromise = watch(args).finally(() => { console.log = original; });
	return {
		lines,
		async stop() {
			process.emit('SIGINT');
			await donePromise;
		},
	};
}

describe('watch', () => {
	it('auto-pushes a local file change after the debounce period', async () => {
		await writeTestFile(srcDir, 'a.txt', 'initial\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() => push({ ...baseArgs, path: srcDir }));
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		const handle = startWatch({
			...baseArgs, streamId, path: srcDir, pullOnly: false, pushOnly: true,
			debounce: 300, pollInterval: 1,
		});

		try {
			await waitFor(() => handle.lines.some((l) => l.includes('watching')));
			await writeTestFile(srcDir, 'a.txt', 'changed by watch test\n');
			await waitFor(() => handle.lines.some((l) => l.includes('pushed version 2')), 20_000);
		} finally {
			await handle.stop();
		}

		await pull({ ...baseArgs, streamId, path: destDir });
		const destTree = await readTree(destDir);
		expect(destTree['a.txt'].toString('utf8')).toBe('changed by watch test\n');
	}, TX_TIMEOUT);

	it('auto-pulls when the remote stream advances and local is clean', async () => {
		await writeTestFile(srcDir, 'a.txt', 'v1\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() => push({ ...baseArgs, path: srcDir }));
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		await pull({ ...baseArgs, streamId, path: destDir });

		const handle = startWatch({
			...baseArgs, streamId, path: destDir, pushOnly: false, pullOnly: true,
			debounce: 300, pollInterval: 1,
		});

		try {
			await waitFor(() => handle.lines.some((l) => l.includes('watching')));
			await writeTestFile(srcDir, 'a.txt', 'v2 pushed from elsewhere\n');
			await push({ ...baseArgs, path: srcDir, streamId });
			await waitFor(() => handle.lines.some((l) => l.includes('pulled version 2')), 20_000);
		} finally {
			await handle.stop();
		}

		const destTree = await readTree(destDir);
		expect(destTree['a.txt'].toString('utf8')).toBe('v2 pushed from elsewhere\n');
	}, TX_TIMEOUT);

	it('with --index, re-indexes before each push — and pushes once, not again for the index file', async () => {
		await writeTestFile(srcDir, 'notes.txt', 'Shopping list: bread, butter and jam.\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() => push({ ...baseArgs, path: srcDir, index: true }));
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		const handle = startWatch({
			...baseArgs, streamId, path: srcDir, pullOnly: false, pushOnly: true, index: true,
			debounce: 300, pollInterval: 1,
		});

		try {
			await waitFor(() => handle.lines.some((l) => l.includes('watching')));
			await writeTestFile(srcDir, 'notes.txt', 'Travel plans: a sailing trip around the harbour islands.\n');
			await waitFor(() => handle.lines.some((l) => l.includes('pushed version 2')), 60_000);
			// Writing the index is itself a change on disk; give the watcher more than a debounce
			// period to react to it, and check that it didn't turn into a second push.
			await new Promise((r) => setTimeout(r, 2500));
			expect(handle.lines.some((l) => l.includes('pushed version 3'))).toBe(false);
			expect(handle.lines.some((l) => l.includes('index: 1 file(s) re-embedded'))).toBe(true);
		} finally {
			await handle.stop();
		}

		// The pushed index describes the new text, not the old.
		await pull({ ...baseArgs, streamId, path: destDir });
		const { lines: hits } = await captureLogs(() =>
			search({ ...baseArgs, path: destDir, query: 'boats and islands', limit: 1 })
		);
		const snippet = hits[hits.findIndex((l) => /^\n1\. /.test(l)) + 1];
		expect(snippet).toContain('sailing trip');
	}, 120_000);

	it('rejects --index for a pull-only session, before watching starts', async () => {
		await writeTestFile(srcDir, 'a.txt', 'v1\n');
		const baseArgs = await makeBaseArgs();
		const { lines: pushLines } = await captureLogs(() => push({ ...baseArgs, path: srcDir }));
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		await expect(
			watch({ ...baseArgs, streamId, path: srcDir, pullOnly: true, index: true })
		).rejects.toThrow(/--index only applies when watch pushes/);
	}, TX_TIMEOUT);
});
