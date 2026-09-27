// The search engine behind `mnemonad index` / `search` / `--index` — Node side. The browser
// half (for the explorer) is ./browser.js, which must stay free of native and `node:*` imports.
export { default as VectorIndex } from './VectorIndex.js';
export { default as Indexer, ModelMismatchError } from './Indexer.js';
export { default as Searcher, describeIndexModel } from './Searcher.js';
export { default as EmbeddingProvider } from './embeddings/EmbeddingProvider.js';
export { default as StaticEmbeddingProvider } from './embeddings/StaticEmbeddingProvider.js';
export { nodeModelFiles } from './embeddings/modelFiles.node.js';
export { default as ChunkingStrategy } from './chunking/ChunkingStrategy.js';
export { default as TextWindowChunkingStrategy } from './chunking/TextWindowChunkingStrategy.js';
export {
	createProvider, loadTransformersExtension, findTransformersExtension, MissingExtensionError,
	EXTENSION_PACKAGE, EXTENSION_INSTALL,
} from './providers.js';
export {
	DEFAULT_DB_NAME, DEFAULT_MODEL, MODEL_ALIASES, resolveModelName, embedderForModel, embedderOfIndex,
	EMBEDDER_STATIC, EMBEDDER_TRANSFORMERS,
} from './schema.js';
