import { describe, it, expect, beforeAll } from 'vitest';
import { apiVersion, createProvider, DEFAULT_MODEL, DEFAULT_DTYPE, TransformersEmbeddingProvider } from '../index.js';

// Real model, real download/cache on first run — slower and network-dependent by nature.
const REAL_MODEL_TIMEOUT = 120_000;

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('the interface mnemonad-cli relies on', () => {
	it('declares its API version and builds providers', () => {
		expect(apiVersion).toBe(1);
		const provider = createProvider({ model: 'some/model', dtype: 'fp32' });
		expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
		expect(provider.modelId).toBe('some/model');
		expect(provider.dtype).toBe('fp32');
		expect(provider.embedder).toBe('transformers');
		expect(provider.isLoaded).toBe(false);
	});

	it('defaults to MiniLM at q8', () => {
		const provider = createProvider();
		expect(provider.modelId).toBe(DEFAULT_MODEL);
		expect(DEFAULT_MODEL).toBe('Xenova/all-MiniLM-L6-v2');
		expect(provider.dtype).toBe(DEFAULT_DTYPE);
		expect(DEFAULT_DTYPE).toBe('q8');
	});
});

describe('TransformersEmbeddingProvider (real MiniLM)', () => {
	let provider;
	beforeAll(async () => {
		provider = createProvider();
		await provider.load();
	}, REAL_MODEL_TIMEOUT);

	it('embeds into unit-length 384-d vectors', async () => {
		const [v] = await provider.embed(['foxes and dogs']);
		expect(v).toHaveLength(384);
		expect(provider.dimension).toBe(384);
		expect(Math.sqrt(dot(v, v))).toBeCloseTo(1, 4);
	});

	it('ranks the semantically closer text first, with no words in common', async () => {
		const [query, animals, finance] = await provider.embed([
			'pets and household animals',
			'The quick brown fox jumps over the lazy dog. Foxes are known for their agility and cunning.',
			'The stock market experienced significant volatility yesterday as investors reacted to inflation data.',
		]);
		expect(dot(query, animals)).toBeGreaterThan(dot(query, finance));
	});
});
