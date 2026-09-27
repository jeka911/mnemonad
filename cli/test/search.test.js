import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TextWindowChunkingStrategy } from '../lib/search/index.js';
import { buildIndex } from '../lib/commands/buildIndex.js';
import { search } from '../lib/commands/search.js';
import { startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, captureLogs } from './fixture.js';

let node;
let srcDir;

beforeAll(async () => {
	node = await startNode();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

beforeEach(async () => {
	srcDir = await makeTempDir('mnemonad-cli-search-src-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
});

const TEST_TIMEOUT = 90_000;

describe('search (mnemonad search)', () => {
	it('requires a query', async () => {
		const baseArgs = await makeBaseArgs();
		await expect(search({ ...baseArgs, path: srcDir, query: null })).rejects.toThrow(/query is required/);
	});

	it('refuses with an actionable message when no index exists yet', async () => {
		await writeTestFile(srcDir, 'a.txt', 'some content');
		const baseArgs = await makeBaseArgs();
		await expect(search({ ...baseArgs, path: srcDir, query: 'anything' })).rejects.toThrow(/mnemonad index/);
	});

	it('ranks the topically-relevant file first', async () => {
		await writeTestFile(srcDir, 'animals.txt', 'Foxes and dogs are common household pets and animals.');
		await writeTestFile(srcDir, 'finance.txt', 'The stock market and economy saw major inflation this year.');
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'money and the economy' })
		);
		const firstResultLine = lines.find((l) => /^\n?\d+\. /.test(l));
		expect(firstResultLine).toContain('finance.txt');
	}, TEST_TIMEOUT);

	it('respects --limit', async () => {
		await writeTestFile(srcDir, 'a.txt', 'apples and oranges are fruit');
		await writeTestFile(srcDir, 'b.txt', 'bananas and grapes are also fruit');
		await writeTestFile(srcDir, 'c.txt', 'completely unrelated content about spaceships');
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'fruit', limit: 1 })
		);
		const resultLines = lines.filter((l) => /^\n?\d+\. /.test(l));
		expect(resultLines).toHaveLength(1);
	}, TEST_TIMEOUT);
});

/**
 * Parses search()'s printed results back into records: each hit is a header line
 * `\n<rank>. <path> (chunk <n>, distance <d>)`, optionally followed by a snippet line indented
 * three spaces. Anything else (the "no matches" line) is ignored here.
 */
function parseResults(lines) {
	const results = [];
	for (const line of lines) {
		const header = line.match(/^\n(\d+)\. (.+) \(chunk (\d+), distance (\d+\.\d+)\)$/);
		if (header) {
			results.push({
				rank: Number(header[1]),
				path: header[2],
				chunk: Number(header[3]),
				distance: header[4],
				snippet: null,
			});
		} else if (results.length && line.startsWith('   ')) {
			results[results.length - 1].snippet = line.slice(3);
		}
	}
	return results;
}

/** What search() is expected to print for a chunk's text: whitespace runs collapsed to one
 *  space, capped at 200 characters. */
function expectedSnippet(text) {
	return text.replace(/\s+/g, ' ').slice(0, 200);
}

describe('search output', () => {
	it('prints numbered hits with path, chunk and a 4-decimal distance, closest first', async () => {
		await writeTestFile(srcDir, 'fruit.txt', 'Apples, pears and plums ripen in the orchard every autumn.');
		await writeTestFile(srcDir, 'space.txt', 'The rocket reached orbit and docked with the space station.');
		await writeTestFile(srcDir, 'ocean.txt', 'Whales and dolphins swim through the deep blue ocean.');
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'fruit trees in an orchard', limit: 3 })
		);
		const results = parseResults(lines);

		expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
		expect(results[0].path).toBe('fruit.txt');
		expect(results.map((r) => r.path).sort()).toEqual(['fruit.txt', 'ocean.txt', 'space.txt']);
		for (const r of results) {
			expect(r.chunk).toBe(0);
			expect(r.distance).toMatch(/^\d+\.\d{4}$/);
		}
		const distances = results.map((r) => Number(r.distance));
		expect(distances).toEqual([...distances].sort((a, b) => a - b));
	}, TEST_TIMEOUT);

	it('cuts each snippet from the source file at that chunk\'s own offsets', async () => {
		// Small chunks, so one file splits into several and most hits start mid-file — the
		// case where a wrong offset would actually show the wrong text.
		const text = [
			'The hare boasted of his speed to all the animals of the forest.',
			'The tortoise, tired of hearing it, challenged him to a race.',
			'The hare ran far ahead, then lay down under a tree to sleep.',
			'Meanwhile the tortoise kept plodding on without ever stopping.',
			'When the hare woke, the tortoise had already crossed the line.',
			'Slow and steady wins the race, said the tortoise to the crowd.',
		].join(' ');
		await writeTestFile(srcDir, 'fable.txt', text);
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir, chunkSize: 120, chunkOverlap: 20 });
		const chunks = new TextWindowChunkingStrategy({ size: 120, overlap: 20 }).chunk(text);
		expect(chunks.length).toBeGreaterThan(2);

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'slow and steady wins the race', limit: chunks.length })
		);
		const results = parseResults(lines);

		// Every chunk comes back once, and each one's snippet is exactly its own slice.
		expect(results.map((r) => r.chunk).sort((a, b) => a - b)).toEqual(chunks.map((_, i) => i));
		for (const r of results) {
			expect(r.path).toBe('fable.txt');
			expect(r.snippet).toBe(expectedSnippet(chunks[r.chunk].text));
		}
		expect(results[0].snippet).toContain('Slow and steady wins the race');
	}, TEST_TIMEOUT);

	it('collapses whitespace in the snippet and caps it at 200 characters', async () => {
		const text = 'Line one of a long note.\n\n\tIndented line two,\t\twith tabs.\n' +
			'A third line that keeps going. '.repeat(12);
		await writeTestFile(srcDir, 'note.txt', text);
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'a long note', limit: 1 })
		);
		const [hit] = parseResults(lines);

		expect(hit.snippet).toHaveLength(200);
		expect(hit.snippet).not.toMatch(/\s{2,}|[\n\t]/);
		expect(hit.snippet).toBe(expectedSnippet(text));
		expect(hit.snippet.startsWith('Line one of a long note. Indented line two, with tabs.')).toBe(true);
	}, TEST_TIMEOUT);

	it('prints a nested file\'s path relative to the folder root', async () => {
		await writeTestFile(srcDir, 'notes/animals/fox.txt', 'A fox crept through the henhouse at night.');
		await writeTestFile(srcDir, 'top.txt', 'Quarterly budget figures for the finance team.');
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'a fox in the henhouse', limit: 1 })
		);
		const [hit] = parseResults(lines);

		expect(hit.path).toBe('notes/animals/fox.txt');
		expect(hit.snippet).toBe('A fox crept through the henhouse at night.');
	}, TEST_TIMEOUT);

	it('still lists a hit whose file was deleted after indexing, just without a snippet', async () => {
		await writeTestFile(srcDir, 'gone.txt', 'Notes about sailing boats and harbour tides.');
		await writeTestFile(srcDir, 'kept.txt', 'Recipes for bread, butter and jam.');
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });
		await rm(join(srcDir, 'gone.txt'));

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'sailing boats in the harbour', limit: 2 })
		);
		const results = parseResults(lines);

		// The index still describes the folder as it was at the last `index` run (see
		// docs/search.md, "Stale until re-indexed") — the hit stays, only its snippet can't be read.
		expect(results[0].path).toBe('gone.txt');
		expect(results[0].snippet).toBe(null);
		expect(results[1].path).toBe('kept.txt');
		expect(results[1].snippet).toBe('Recipes for bread, butter and jam.');
	}, TEST_TIMEOUT);

	it('drops a deleted file once the folder is re-indexed, down to "no matches"', async () => {
		await writeTestFile(srcDir, 'only.txt', 'The single file this folder ever had.');
		const baseArgs = await makeBaseArgs();
		await buildIndex({ ...baseArgs, path: srcDir });
		await rm(join(srcDir, 'only.txt'));
		await buildIndex({ ...baseArgs, path: srcDir });

		const { lines } = await captureLogs(() =>
			search({ ...baseArgs, path: srcDir, query: 'the single file' })
		);

		expect(parseResults(lines)).toEqual([]);
		expect(lines).toContain('  no matches');
	}, TEST_TIMEOUT);
});
