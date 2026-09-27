import EmbeddingProvider from '../../lib/search/embeddings/EmbeddingProvider.js';

/**
 * Deterministic, model-free stand-in for tests that care about the indexing/query pipeline
 * itself (schema, incremental skip, staleness, chunk offsets) rather than embedding quality —
 * downloading and running the real local model on every test run would make the suite slow
 * and network-dependent for no benefit to what these tests are actually checking. Two texts
 * that share more words land closer together in the fake vector space, so basic "is the more
 * similar one ranked first" assertions still work meaningfully; real semantic-quality checks
 * belong in a test that uses the real `TransformersEmbeddingProvider` instead (see
 * `embeddings.test.js`).
 */
export class FakeEmbeddingProvider extends EmbeddingProvider {
	constructor({ dim = 16 } = {}) {
		super();
		this._dim = dim;
	}

	get dimension() { return this._dim; }
	get modelId() { return 'fake-test-embedder'; }

	async embed(texts) {
		return texts.map((text) => this._embedOne(text));
	}

	_embedOne(text) {
		const vec = new Float32Array(this._dim);
		const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
		for (const word of words) {
			let h = 2166136261;
			for (let i = 0; i < word.length; i++) {
				h ^= word.charCodeAt(i);
				h = Math.imul(h, 16777619);
			}
			vec[Math.abs(h) % this._dim] += 1;
		}
		// Normalize so cosine distance behaves the way a real embedding's would.
		let norm = 0;
		for (const v of vec) norm += v * v;
		norm = Math.sqrt(norm) || 1;
		for (let i = 0; i < vec.length; i++) vec[i] /= norm;
		return vec;
	}
}

/** @param {string[]} names */
export function makeInMemoryFolder(files) {
	// Minimal DoubleSyncFolder-shaped object — just enough for Indexer.index() (walk() + the
	// per-file getContent()/getFingerprint() it calls), without needing real disk I/O.
	return {
		async *walk(prefix = []) {
			for (const [name, content] of Object.entries(files)) {
				const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
				yield {
					path: [...prefix, name],
					file: {
						async getContent() { return bytes; },
						async getFingerprint() {
							const { createHash } = await import('node:crypto');
							return new Uint8Array(createHash('sha256').update(bytes).digest());
						},
					},
				};
			}
		},
	};
}
