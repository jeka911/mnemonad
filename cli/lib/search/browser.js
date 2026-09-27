// Browser-safe entry (the explorer imports this through a Vite alias): nothing here imports
// better-sqlite3, the native sqlite-vector extension or any `node:*` module. Searching only —
// building an index stays a Node job (`mnemonad index`), since that's where the folder's files
// live on disk and where embedding the whole corpus belongs; the browser only ever embeds a
// query string.
export { default as WasmIndexReader } from './browser/WasmIndexReader.js';
export { default as BrowserSearcher } from './browser/BrowserSearcher.js';
export { default as EmbeddingProvider } from './embeddings/EmbeddingProvider.js';
export { default as StaticEmbeddingProvider } from './embeddings/StaticEmbeddingProvider.js';
export { browserModelFiles } from './embeddings/modelFiles.browser.js';
export {
	DEFAULT_DB_NAME, DEFAULT_MODEL, LEGACY_DTYPE, EMBEDDER_STATIC, EMBEDDER_TRANSFORMERS, embedderOfIndex,
} from './schema.js';
