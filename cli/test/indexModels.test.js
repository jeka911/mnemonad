import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { VectorIndex } from '../lib/search/index.js';
import { buildIndex, chooseModel } from '../lib/commands/buildIndex.js';
import { search } from '../lib/commands/search.js';
import { makeTempDir, cleanupDir, writeTestFile, captureLogs } from './fixture.js';

// Indexing and searching touch no chain, so these run without a node — but with the real
// models: potion (built in), and MiniLM through the transformers extension, which in this
// monorepo resolves as a workspace package (in a real install it's a separate `npm install -g`).
const REAL_MODELS_TIMEOUT = 180_000;

let dir;

beforeEach(async () => {
	dir = await makeTempDir('mnemonad-cli-models-');
});

afterEach(async () => {
	await cleanupDir(dir);
});

/** The flags buildIndex/search read, and nothing chain-related. */
function args(extra = {}) {
	return {
		path: dir, model: null, rebuild: false, searchDb: null, exclude: null,
		chunkSize: null, chunkOverlap: null, limit: null, query: null, ...extra,
	};
}

const meta = () => VectorIndex.readMeta(join(dir, 'search_index.db'));

describe('choosing the embedding model', () => {
	it('defaults a new index to the built-in potion model', async () => {
		await writeTestFile(dir, 'a.txt', 'Foxes and dogs are common household pets.');
		expect(chooseModel(dir, args())).toMatchObject({ model: 'minishlab/potion-base-8M' });

		await captureLogs(() => buildIndex(args()));
		expect(meta()).toMatchObject({ model: 'minishlab/potion-base-8M', embedder: 'model2vec', dimension: '256' });
	}, REAL_MODELS_TIMEOUT);

	it('builds with MiniLM on request, then keeps it when --model is left off', async () => {
		await writeTestFile(dir, 'a.txt', 'Foxes and dogs are common household pets.');
		await captureLogs(() => buildIndex(args({ model: 'minilm' })));
		expect(meta()).toMatchObject({ model: 'Xenova/all-MiniLM-L6-v2', embedder: 'transformers', dtype: 'q8', dimension: '384' });

		// No --model: the index's own model, not the built-in default — and no mismatch.
		await writeTestFile(dir, 'b.txt', 'The stock market fell sharply on inflation data.');
		const { lines } = await captureLogs(() => buildIndex(args()));
		expect(lines.some((l) => l.includes('Xenova/all-MiniLM-L6-v2'))).toBe(true);
		expect(meta()).toMatchObject({ model: 'Xenova/all-MiniLM-L6-v2', dimension: '384' });

		// And a search on it runs through the extension, from the index's own record.
		const { lines: hits } = await captureLogs(() => search(args({ query: 'money and the economy', limit: 1 })));
		expect(hits.find((l) => /^\n1\. /.test(l))).toContain('b.txt');
	}, REAL_MODELS_TIMEOUT);

	it('refuses to mix models in one index, and switches with --rebuild', async () => {
		await writeTestFile(dir, 'a.txt', 'Foxes and dogs are common household pets.');
		await captureLogs(() => buildIndex(args({ model: 'minilm' })));

		await expect(captureLogs(() => buildIndex(args({ model: 'potion' }))))
			.rejects.toThrow(/built with Xenova\/all-MiniLM-L6-v2, but this run asked for minishlab\/potion-base-8M[\s\S]*--rebuild/);
		expect(meta().model).toBe('Xenova/all-MiniLM-L6-v2');

		const { lines } = await captureLogs(() => buildIndex(args({ model: 'potion', rebuild: true })));
		expect(lines.some((l) => l.includes('rebuilding search_index.db'))).toBe(true);
		expect(meta()).toMatchObject({ model: 'minishlab/potion-base-8M', dimension: '256' });
	}, REAL_MODELS_TIMEOUT);

	it('--rebuild with no --model goes back to the built-in default', async () => {
		await writeTestFile(dir, 'a.txt', 'Foxes and dogs are common household pets.');
		await captureLogs(() => buildIndex(args({ model: 'minilm' })));
		expect(chooseModel(dir, args({ rebuild: true }))).toMatchObject({ model: 'minishlab/potion-base-8M' });
	}, REAL_MODELS_TIMEOUT);

	it('search names a --model that disagrees with the index instead of ignoring it', async () => {
		await writeTestFile(dir, 'a.txt', 'Foxes and dogs are common household pets.');
		await captureLogs(() => buildIndex(args()));
		await expect(search(args({ query: 'pets', model: 'minilm' })))
			.rejects.toThrow(/built with minishlab\/potion-base-8M; a search has to use the same model/);
	}, REAL_MODELS_TIMEOUT);
});
