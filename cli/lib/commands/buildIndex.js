import { join } from 'node:path';
import {
	Indexer, TextWindowChunkingStrategy, VectorIndex, DEFAULT_DB_NAME, DEFAULT_MODEL,
	createProvider, resolveModelName, embedderOfIndex, ModelMismatchError, MissingExtensionError,
} from '../search/index.js';
import { FSFolder } from '../FSFolder.js';
import { resolvePath, DEFAULT_FS_EXCLUDES, userError } from './shared.js';

/**
 * The vector index, shared by `mnemonad index` and by `push --index` / `watch --index`.
 * Kept in one place so all three agree on which file it is, which files it covers, and how
 * they're chunked and embedded — an index built by `push --index` is the same index
 * `mnemonad index` would have built.
 *
 * The default filename is at the folder root and not dot-prefixed: unlike `.mnemonad`, it's
 * meant to be pushed and pulled like any other file, so a pull is searchable immediately.
 */

/** @returns {string} the index's filename (`--db`, default `search_index.db`). */
export function indexDbName(args) {
	return args.searchDb || DEFAULT_DB_NAME;
}

/** @returns {string[]} what the index skips: the push's own excludes, plus the index file.
 *  The index file itself must never be walked as content to embed — explicit, not left to
 *  chance: a SQLite file's own header/padding bytes are plausible-looking text in places,
 *  so relying on the binary-content sniff alone to skip it would be fragile. */
export function indexExcludes(args) {
	const excludes = [...DEFAULT_FS_EXCLUDES, indexDbName(args)];
	if (args.exclude) excludes.push(...args.exclude.split(',').map((s) => s.trim()));
	return excludes;
}

function chunkingFrom(args) {
	return new TextWindowChunkingStrategy({
		size: args.chunkSize ?? 1000,
		overlap: args.chunkOverlap ?? 150,
	});
}

/**
 * Which model to index `destPath` with. An explicit `--model` wins (an alias like `minilm`, or
 * a full id). Without one, an existing index keeps the model it was built with — so re-indexing
 * a folder someone indexed with MiniLM just works — and only a new index (or `--rebuild`)
 * gets the built-in default.
 *
 * @returns {{model: string, embedder: ?string, dtype: ?string}}
 */
export function chooseModel(destPath, args) {
	if (args.model) return { model: resolveModelName(args.model), embedder: null, dtype: null };
	const meta = args.rebuild ? null : VectorIndex.readMeta(join(destPath, indexDbName(args)));
	if (meta?.model) {
		return { model: meta.model, embedder: embedderOfIndex(meta), dtype: meta.dtype || null };
	}
	return { model: DEFAULT_MODEL, embedder: null, dtype: null };
}

/**
 * An Indexer configured from the CLI flags. Hold on to it across runs (as `watch --index`
 * does) and the embedding model loads once, on first use, instead of on every run.
 * Rejects straight away on bad chunking flags or a missing extension, before anything is
 * read or written.
 */
export async function makeIndexer(destPath, args) {
	const chunkingStrategy = chunkingFrom(args);
	const { model, embedder, dtype } = chooseModel(destPath, args);
	let embeddingProvider;
	try {
		embeddingProvider = await createProvider({ model, ...(embedder ? { embedder } : {}), dtype });
	} catch (err) {
		throw explainIndexError(err, destPath, args);
	}
	return new Indexer({ embeddingProvider, chunkingStrategy });
}

/**
 * Builds or updates `destPath`'s index, printing the same summary `mnemonad index` does.
 *
 * @param {string} destPath - resolved folder path
 * @param {Object} args - parsed CLI args (`rebuild` starts the index over)
 * @param {Object} [opts]
 * @param {Indexer} [opts.indexer] - reuse one (and its loaded model) across calls
 * @param {boolean} [opts.quiet] - one summary line instead of the full report
 * @param {boolean} [opts.rebuild] - overrides `args.rebuild` (watch rebuilds only once)
 * @returns {Promise<{filesChanged: number, filesSkipped: number, filesRemoved: number, chunksAdded: number}>}
 */
export async function updateIndex(destPath, args, { indexer = null, quiet = false, rebuild = args.rebuild } = {}) {
	indexer = indexer || await makeIndexer(destPath, { ...args, rebuild });
	const dbName = indexDbName(args);
	const fsFolder = new FSFolder(destPath, indexExcludes(args));

	if (!quiet) {
		console.log('  embedding model:', indexer.embeddingProvider.modelId, '(downloads and caches on first use)');
		if (rebuild) console.log(`  rebuilding ${dbName} from scratch`);
		console.log('  scanning for changed files...');
	}
	let result;
	try {
		result = await indexer.index(fsFolder, join(destPath, dbName), { rebuild: !!rebuild });
	} catch (err) {
		throw explainIndexError(err, destPath, args);
	}

	if (quiet) {
		const changed = result.filesChanged + result.filesRemoved;
		console.log(changed
			? `  index: ${result.filesChanged} file(s) re-embedded, ${result.filesRemoved} removed (${result.chunksAdded} chunks)`
			: '  index: up to date');
	} else {
		console.log('  files changed:', result.filesChanged);
		console.log('  files skipped:', result.filesSkipped, '(content unchanged since last index)');
		console.log('  files removed:', result.filesRemoved);
		console.log('  chunks added: ', result.chunksAdded);
	}
	return result;
}

/**
 * How far `destPath`'s index has drifted from its files, without updating it — no model is
 * loaded (not even the extension looked up) and the index is opened read-only (see
 * Indexer.status()). Null when there's no index.
 *
 * @returns {Promise<?{changed: string[], added: string[], removed: string[], total: number}>}
 */
export async function checkIndex(destPath, args) {
	const fsFolder = new FSFolder(destPath, indexExcludes(args));
	// Chunking decides which files count (an empty one is never indexed), so it's configured
	// exactly as for a real run; status() never embeds, so no provider is needed.
	const indexer = new Indexer({ embeddingProvider: null, chunkingStrategy: chunkingFrom(args) });
	const status = await indexer.status(fsFolder, join(destPath, indexDbName(args)));
	if (!status) return null;
	return { ...status, total: status.changed.length + status.added.length + status.removed.length };
}

/** Turns the two errors a user can act on into CLI messages that say what to do. */
function explainIndexError(err, destPath, args) {
	if (err instanceof MissingExtensionError) {
		const lines = [err.message];
		if (!args.model) {
			lines.push(
				'  Or rebuild the index with the built-in model instead:',
				`    mnemonad index ${destPath} --rebuild`,
			);
		}
		return userError(lines.join('\n'));
	}
	if (err instanceof ModelMismatchError) {
		return userError(
			`${indexDbName(args)} was built with ${err.indexModel}, but this run asked for ${err.providerModel} —\n` +
			'  one index can\'t mix two models. Either drop --model to keep using the index\'s own model, or\n' +
			`  add --rebuild to re-embed every file with ${err.providerModel} (the next push then uploads the\n` +
			'  whole index again).'
		);
	}
	return err;
}

/** `mnemonad index <path>` */
export async function buildIndex(args) {
	const destPath = resolvePath(args.path, { mustExist: true });
	const result = await updateIndex(destPath, args);

	if (result.filesChanged > 0 || result.filesRemoved > 0) {
		// Said explicitly rather than left implicit: unlike `.mnemonad`, this file is not
		// dot-prefixed, so the very next `push` from this folder includes it automatically —
		// worth knowing before that push happens, not after.
		console.log(`\n  note: ${indexDbName(args)} will be included in the next \`mnemonad push\` from this folder`);
	} else {
		console.log('\n  no changes — nothing new to push');
	}
}
