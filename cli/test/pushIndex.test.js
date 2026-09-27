import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VectorIndex } from '../lib/search/index.js';
import { push } from '../lib/commands/push.js';
import { pull } from '../lib/commands/pull.js';
import { buildIndex } from '../lib/commands/buildIndex.js';
import { search } from '../lib/commands/search.js';
import {
	startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, captureLogs,
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
	srcDir = await makeTempDir('mnemonad-cli-pushindex-src-');
	destDir = await makeTempDir('mnemonad-cli-pushindex-dest-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
	await cleanupDir(destDir);
});

// A real chain round-trip plus the real (cached after the first run) embedding model.
const TEST_TIMEOUT = 90_000;

function createdId(lines) {
	return lines.find((l) => l.includes('created:')).split('created:')[1].trim();
}

/** Paths recorded in a folder's index, read without touching the file. */
function indexedPaths(dir) {
	const index = new VectorIndex(join(dir, 'search_index.db'), { readonly: true });
	try {
		return index.listFiles().sort();
	} finally {
		index.close();
	}
}

describe('push --index', () => {
	it('builds the index and pushes it, so a pull is searchable with no indexing of its own', async () => {
		await writeTestFile(srcDir, 'animals.txt', 'Foxes and dogs are common household pets and animals.');
		await writeTestFile(srcDir, 'finance.txt', 'The stock market and economy saw major inflation this year.');
		const baseArgs = await makeBaseArgs();

		const { lines } = await captureLogs(() => push({ ...baseArgs, path: srcDir, index: true }));
		expect(lines.some((l) => l.includes('index: 2 file(s) re-embedded'))).toBe(true);
		expect(existsSync(join(srcDir, 'search_index.db'))).toBe(true);

		await pull({ ...baseArgs, streamId: createdId(lines), path: destDir });
		const { lines: hits } = await captureLogs(() =>
			search({ ...baseArgs, path: destDir, query: 'money and the economy', limit: 1 })
		);
		expect(hits.find((l) => /^\n1\. /.test(l))).toContain('finance.txt');
	}, TEST_TIMEOUT);

	it('indexes exactly what the push uploads — the same --exclude, and never itself', async () => {
		await writeTestFile(srcDir, 'public.txt', 'Notes that belong in the stream.');
		await writeTestFile(srcDir, 'private/secret.txt', 'Notes that must stay local.');
		const baseArgs = await makeBaseArgs();

		const { lines } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, index: true, exclude: 'private' })
		);
		await pull({ ...baseArgs, streamId: createdId(lines), path: destDir });

		expect(existsSync(join(destDir, 'private'))).toBe(false);
		expect(indexedPaths(destDir)).toEqual(['public.txt']);
	}, TEST_TIMEOUT);

	it('pushes nothing when indexing fails', async () => {
		await writeTestFile(srcDir, 'a.txt', 'some content');
		const baseArgs = await makeBaseArgs();

		// Overlap ≥ size is rejected by the chunker before any file is read.
		const { lines } = await captureLogs(async () => {
			await expect(
				push({ ...baseArgs, path: srcDir, index: true, chunkSize: 100, chunkOverlap: 100 })
			).rejects.toThrow(/indexing failed, so nothing was pushed/);
		});
		expect(lines.some((l) => l.includes('creating new stream'))).toBe(false);
		expect(lines.some((l) => l.includes('created:'))).toBe(false);
	}, TEST_TIMEOUT);

	it('reports an unchanged index as up to date on the next push', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content that does not change');
		const baseArgs = await makeBaseArgs();
		const { lines } = await captureLogs(() => push({ ...baseArgs, path: srcDir, index: true }));
		const streamId = createdId(lines);

		const { lines: again } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, streamId, index: true })
		);
		expect(again).toContain('  index: up to date');
		expect(again.some((l) => l.includes('no changes, nothing to push'))).toBe(true);
	}, TEST_TIMEOUT);
});

describe('push without --index', () => {
	it('warns when the folder\'s index has fallen behind its files', async () => {
		await writeTestFile(srcDir, 'a.txt', 'first version');
		await writeTestFile(srcDir, 'b.txt', 'unchanged file');
		const baseArgs = await makeBaseArgs();
		await captureLogs(() => buildIndex({ ...baseArgs, path: srcDir }));

		await writeTestFile(srcDir, 'a.txt', 'second, edited version');
		await writeTestFile(srcDir, 'c.txt', 'a brand new file');
		const { lines } = await captureLogs(() => push({ ...baseArgs, path: srcDir }));

		const note = lines.find((l) => l.includes('search_index.db is out of date'));
		expect(note).toContain('1 changed, 1 new file(s)');
		expect(note).toContain('--index');
	}, TEST_TIMEOUT);

	it('says nothing when the index is current, or when there is none', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content');
		const baseArgs = await makeBaseArgs();

		const { lines: noIndex } = await captureLogs(() => push({ ...baseArgs, path: srcDir }));
		expect(noIndex.some((l) => l.includes('out of date'))).toBe(false);

		await captureLogs(() => buildIndex({ ...baseArgs, path: srcDir }));
		const { lines: current } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, streamId: createdId(noIndex) })
		);
		expect(current.some((l) => l.includes('out of date'))).toBe(false);
	}, TEST_TIMEOUT);

	it('leaves the index file untouched while checking it', async () => {
		const { readFile } = await import('node:fs/promises');
		await writeTestFile(srcDir, 'a.txt', 'content');
		const baseArgs = await makeBaseArgs();
		await captureLogs(() => buildIndex({ ...baseArgs, path: srcDir }));
		const before = await readFile(join(srcDir, 'search_index.db'));

		await writeTestFile(srcDir, 'a.txt', 'edited content');
		await captureLogs(() => push({ ...baseArgs, path: srcDir }));

		expect(Buffer.compare(before, await readFile(join(srcDir, 'search_index.db')))).toBe(0);
	}, TEST_TIMEOUT);
});
