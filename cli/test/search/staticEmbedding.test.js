import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import StaticEmbeddingProvider, { readEmbeddings } from '../../lib/search/embeddings/StaticEmbeddingProvider.js';
import { nodeModelFiles, defaultCacheDir } from '../../lib/search/embeddings/modelFiles.node.js';
import { createProvider } from '../../lib/search/providers.js';

// The real potion-base-8M, from the shared model cache — downloaded (~31 MB) on the first run
// only. The one place its actual behaviour is checked; the rest of the suite uses the fake.
const REAL_MODEL_TIMEOUT = 120_000;

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('StaticEmbeddingProvider (potion-base-8M)', () => {
	let provider;
	beforeAll(async () => {
		provider = await createProvider({ model: 'minishlab/potion-base-8M' });
		await provider.load();
	}, REAL_MODEL_TIMEOUT);

	it('describes itself for the index metadata', () => {
		expect(provider.modelId).toBe('minishlab/potion-base-8M');
		expect(provider.embedder).toBe('model2vec');
		expect(provider.dimension).toBe(256);
		expect(provider.isLoaded).toBe(true);
	});

	it('returns one unit-length 256-d vector per text, deterministically', async () => {
		const [a, b, again] = await provider.embed(['foxes and dogs', 'stock markets', 'foxes and dogs']);
		expect(a).toBeInstanceOf(Float32Array);
		expect(a).toHaveLength(256);
		expect(Math.sqrt(dot(a, a))).toBeCloseTo(1, 5);
		expect(Math.sqrt(dot(b, b))).toBeCloseTo(1, 5);
		expect([...again]).toEqual([...a]);
	});

	it('places related texts closer than unrelated ones', async () => {
		const [pets, animals, finance] = await provider.embed([
			'dogs and cats are household pets',
			'animals people keep at home',
			'the stock market fell on inflation data',
		]);
		expect(dot(pets, animals)).toBeGreaterThan(dot(pets, finance));
	});

	it('gives a zero vector, not NaN, for text with no known tokens', async () => {
		const [empty] = await provider.embed(['']);
		expect([...empty].every((x) => x === 0)).toBe(true);
	});
});

describe('nodeModelFiles', () => {
	it('caches under MNEMONAD_CACHE_DIR-style folders, by model id', () => {
		const saved = process.env.MNEMONAD_CACHE_DIR;
		process.env.MNEMONAD_CACHE_DIR = '/tmp/some-cache';
		try {
			expect(defaultCacheDir()).toBe('/tmp/some-cache');
		} finally {
			if (saved === undefined) delete process.env.MNEMONAD_CACHE_DIR;
			else process.env.MNEMONAD_CACHE_DIR = saved;
		}
	});

	it('downloads once, then serves from disk, reporting progress', async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), 'mnemonad-model-cache-'));
		try {
			const events = [];
			const files = nodeModelFiles('minishlab/potion-base-8M', { cacheDir, onProgress: (e) => events.push(e) });
			const first = await files.get('tokenizer_config.json');
			expect(events.some((e) => e.status === 'progress' && e.file === 'tokenizer_config.json')).toBe(true);
			expect(await readdir(join(cacheDir, 'models', 'minishlab', 'potion-base-8M'))).toEqual(['tokenizer_config.json']);

			events.length = 0;
			const second = await files.get('tokenizer_config.json');
			expect(events).toEqual([]);
			expect(Buffer.compare(first, second)).toBe(0);
		} finally {
			await rm(cacheDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe('readEmbeddings', () => {
	/** A minimal safetensors file holding one `embeddings` tensor. */
	function safetensors(dtype, shape, dataBytes, headerPad = '') {
		const header = JSON.stringify({ embeddings: { dtype, shape, data_offsets: [0, dataBytes.byteLength] } }) + headerPad;
		const headerBytes = new TextEncoder().encode(header);
		const out = new Uint8Array(8 + headerBytes.byteLength + dataBytes.byteLength);
		new DataView(out.buffer).setBigUint64(0, BigInt(headerBytes.byteLength), true);
		out.set(headerBytes, 8);
		out.set(dataBytes, 8 + headerBytes.byteLength);
		return out;
	}

	it('reads F32 data even when it starts unaligned', () => {
		const values = new Float32Array([1, 2, 3, 4, 5, 6]);
		// A 1-space pad puts the data at an offset that isn't a multiple of 4.
		const bytes = safetensors('F32', [3, 2], new Uint8Array(values.buffer), ' ');
		const { table, rows, dim } = readEmbeddings(bytes);
		expect({ rows, dim }).toEqual({ rows: 3, dim: 2 });
		expect([...table]).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('widens F16 data to F32', () => {
		// 1.0, -2.0, 0.5, 0 as IEEE half floats.
		const halves = new Uint16Array([0x3c00, 0xc000, 0x3800, 0x0000]);
		const { table } = readEmbeddings(safetensors('F16', [2, 2], new Uint8Array(halves.buffer)));
		expect([...table]).toEqual([1, -2, 0.5, 0]);
	});

	it('refuses a file without an embeddings tensor, or an unsupported dtype', () => {
		expect(() => readEmbeddings(safetensors('I8', [1, 1], new Uint8Array([1])))).toThrow(/unsupported dtype/);
		const other = new TextEncoder().encode(JSON.stringify({ weights: {} }));
		const bytes = new Uint8Array(8 + other.byteLength);
		new DataView(bytes.buffer).setBigUint64(0, BigInt(other.byteLength), true);
		bytes.set(other, 8);
		expect(() => readEmbeddings(bytes)).toThrow(/no `embeddings` tensor/);
	});
});

describe('StaticEmbeddingProvider', () => {
	it('requires a files source', () => {
		expect(() => new StaticEmbeddingProvider({})).toThrow(/files/);
	});
});
