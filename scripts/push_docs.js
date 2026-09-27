/**
 * Publishes this repo's docs/ folder as a searchable Mnemonad stream — what the explorer's
 * /docs page loads and renders (explorer/src/mnemonad/docs/StreamDocs.vue).
 *
 * Through the `mnemonad` CLI (see push_dataset.js for why a subprocess):
 *
 *   1. `mnemonad push --index` — updates docs/search_index.db in place (only docs changed since
 *      the last run are embedded again), then pushes: the first run creates a new stream,
 *      every later one pushes a diff into that same stream. Public on purpose: these are the
 *      project's published docs. If indexing fails, the CLI pushes nothing.
 *   2. On create, records the new id in explorer/src/mnemonad/docsStream.json, the one file
 *      the /docs page reads it from.
 *
 * --dry-run runs `mnemonad index` and `mnemonad diff` instead: the index is brought up to date
 * locally and the would-be changes are listed, but nothing is written on chain.
 *
 * docs/search_index.db and docs/.mnemonad are gitignored — only the markdown is committed.
 * On a fresh clone the index is rebuilt from scratch, so that one push carries the whole index
 * file again instead of a diff; at this size that's cheap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushDatasetToNetwork, runCli, CLI_CHAIN } from './push_dataset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

export const DOCS_DIR = 'docs';

/**
 * Left out of both the index and the push — matched by name at any depth, same as the CLI's
 * own `--exclude`. `hackathon/` is internal planning, not documentation.
 */
export const DOCS_EXCLUDE = ['hackathon'];

const RECORD_PATH = path.join(REPO_ROOT, 'explorer/src/mnemonad/docsStream.json');

/** @returns {Record<string, string>} network id ('testnet'/'mainnet') → stream id */
export function readDocsRecord() {
	try {
		return JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8'));
	} catch {
		return {};
	}
}

function writeDocsRecord(record) {
	fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, '\t') + '\n');
}

/**
 * @param {'monadTestnet'|'monad'} networkKey
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] - index, and show what a push would change; write nothing on chain
 * @param {boolean} [opts.forceSnapshot]
 * @param {boolean} [opts.rebuild] - start the search index over (e.g. to switch it to the
 *   CLI's current default model); the push then carries the whole index again
 */
export async function pushDocsToNetwork(networkKey, opts = {}) {
	const chain = CLI_CHAIN[networkKey];
	if (!chain) throw new Error(`push-docs: unknown network '${networkKey}'`);

	const dir = path.join(REPO_ROOT, DOCS_DIR);
	const exclude = DOCS_EXCLUDE.join(',');
	const record = readDocsRecord();
	const streamId = record[chain] || null;

	if (opts.dryRun) {
		console.log(`Indexing ${DOCS_DIR}/ (excluding ${exclude})`);
		await runCli(['index', dir, '--exclude', exclude, ...(opts.rebuild ? ['--rebuild'] : [])]);
		if (streamId) {
			console.log(`\nDry run — changes a push would make to ${chain} stream ${streamId}:`);
			await runCli(['diff', streamId, dir, '--chain', chain, '--exclude', exclude]);
		} else {
			console.log(`\nDry run — no docs stream recorded for ${chain} yet; a real run would create one.`);
		}
		return { streamId };
	}

	const result = await pushDatasetToNetwork(networkKey, {
		dir,
		streamId,
		exclude,
		manifest: true,
		index: true,
		rebuild: opts.rebuild,
		forceSnapshot: opts.forceSnapshot,
	});

	if (!streamId) {
		if (!result.streamId) {
			throw new Error('push-docs: the push reported no new stream id — nothing recorded.');
		}
		writeDocsRecord({ ...record, [chain]: result.streamId });
		console.log(`  recorded:      ${path.relative(REPO_ROOT, RECORD_PATH)} (${chain} → ${result.streamId})`);
	}
	// pushDatasetToNetwork has already printed the stream's file-browser link.
	console.log('  docs page:     https://mnemonad.vercel.app/docs');
	return { streamId: streamId || result.streamId };
}

/** @param {string[]} argv */
export function parsePushDocsArgs(argv) {
	const out = {};
	for (const arg of argv) {
		if (arg === '--dry-run') out.dryRun = true;
		else if (arg === '--force-snapshot') out.forceSnapshot = true;
		else if (arg === '--rebuild') out.rebuild = true;
		else throw new Error(`push-docs: unrecognized argument '${arg}'`);
	}
	return out;
}
