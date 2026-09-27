import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
	srcDir = await makeTempDir('mnemonad-cli-index-src-');
	destDir = await makeTempDir('mnemonad-cli-index-dest-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
	await cleanupDir(destDir);
});

// Generous: a real chain round-trip plus a real (if small/cached-after-first-run) embedding
// model load, not mocked — same "verify against the real thing" convention every other test
// in this suite already follows for chain interaction.
const TEST_TIMEOUT = 90_000;

describe('buildIndex (mnemonad index)', () => {
	it('creates search_index.db at the folder root, as a plain (non-dot) file', async () => {
		await writeTestFile(srcDir, 'animals.txt', 'Foxes and dogs are common household pets.');
		const baseArgs = await makeBaseArgs();

		const { lines } = await captureLogs(() => buildIndex({ ...baseArgs, path: srcDir }));
		expect(lines.some((l) => l.includes('files changed: 1'))).toBe(true);
		expect(existsSync(join(srcDir, 'search_index.db'))).toBe(true);
	}, TEST_TIMEOUT);

	it('skips a file whose content has not changed since the last index', async () => {
		await writeTestFile(srcDir, 'a.txt', 'unchanging content for the index');
		const baseArgs = await makeBaseArgs();

		await buildIndex({ ...baseArgs, path: srcDir });
		const { lines } = await captureLogs(() => buildIndex({ ...baseArgs, path: srcDir }));
		expect(lines.some((l) => l.includes('files changed: 0'))).toBe(true);
		expect(lines.some((l) => l.includes('files skipped: 1'))).toBe(true);
	}, TEST_TIMEOUT);

	it('reindexes only the file that actually changed, leaving others untouched', async () => {
		await writeTestFile(srcDir, 'a.txt', 'first version of file a, about foxes');
		await writeTestFile(srcDir, 'b.txt', 'this file never changes, about the ocean');
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });

		await writeTestFile(srcDir, 'a.txt', 'second, different version of file a, about dogs now');
		const { lines } = await captureLogs(() => buildIndex({ ...baseArgs, path: srcDir }));
		expect(lines.some((l) => l.includes('files changed: 1'))).toBe(true);
		expect(lines.some((l) => l.includes('files skipped: 1'))).toBe(true);
	}, TEST_TIMEOUT);

	it('a pushed index is immediately searchable after pull, with no local reindexing', async () => {
		await writeTestFile(srcDir, 'animals.txt', 'Foxes and dogs are common household pets and animals.');
		await writeTestFile(srcDir, 'finance.txt', 'The stock market and economy saw major inflation this year.');
		const baseArgs = await makeBaseArgs();

		await buildIndex({ ...baseArgs, path: srcDir });

		const { lines: pushLines } = await captureLogs(() => push({ ...baseArgs, path: srcDir }));
		const streamId = pushLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		await pull({ ...baseArgs, streamId, path: destDir });
		expect(existsSync(join(destDir, 'search_index.db'))).toBe(true);

		// No buildIndex() call here at all — this is the actual claim under test: the puller
		// gets a ready-to-search index with zero local embedding work of their own.
		const { lines: searchLines } = await captureLogs(() =>
			search({ ...baseArgs, path: destDir, query: 'pets and household animals' })
		);
		expect(searchLines.some((l) => l.includes('animals.txt'))).toBe(true);
	}, TEST_TIMEOUT);
});
