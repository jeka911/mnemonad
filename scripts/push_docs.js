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
 *
 * Before any of that, copySubprojectReadmes() copies every subproject's own README.md into
 * docs/<name>/README.md (rewriting its relative links along the way — see relinkReadme) so
 * each one becomes a real page in the docs stream, always current with what's on disk at
 * push time. Unlike search_index.db/.mnemonad, these copies ARE committed — they're meant to
 * read in a PR diff like the rest of docs/, not be rebuilt-and-ignored.
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

/**
 * Subprojects skipped by copySubprojectReadmes() even though they have their own README.md.
 * `explorer` is the dApp this docs stream is served *from* — copying its README into its own
 * docs would be circular. A const array, not a single hardcoded name check, so skipping
 * another one later is a one-line change here rather than a new branch in the function.
 */
export const SKIP_SUBPROJECT_DOCS = ['explorer'];

/**
 * Every top-level subproject with its own README.md, minus `docs/` itself (the destination)
 * and anything in SKIP_SUBPROJECT_DOCS. Discovered from disk rather than hand-maintained as a
 * second list to keep in sync — a new package's README starts showing up here the moment the
 * package exists, with nothing to remember to update.
 *
 * @returns {string[]} subproject directory names, e.g. ['cli', 'contracts', 'js', ...]
 */
function findSubprojectReadmes() {
	return fs.readdirSync(REPO_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => !name.startsWith('.') && name !== 'node_modules' && name !== DOCS_DIR)
		.filter((name) => !SKIP_SUBPROJECT_DOCS.includes(name))
		.filter((name) => fs.existsSync(path.join(REPO_ROOT, name, 'README.md')))
		.sort();
}

/**
 * Rewrites a subproject README's relative links so they still resolve once the file moves
 * from `<name>/README.md` to `docs/<name>/README.md` — one level deeper, and in a different
 * branch of the repo tree than where every link in it was written to be read from. The
 * explorer's docs renderer (explorer/src/mnemonad/docs/markdown.js) resolves a relative link
 * against the *file's own path inside the pushed stream*, so this has to happen at copy time,
 * not be left for that renderer to guess at.
 *
 * Every link in every subproject README today is either absolute (a URI scheme, e.g.
 * `https://`/`mailto:`), an in-page `#anchor`, or `../`-relative — nothing `./`-relative or
 * same-directory, so that's the only shape handled; anything else is left exactly as written
 * rather than guessed at.
 *
 *   - `../docs/X` → `../X`: this already climbed to repo root and back down into `docs/` to
 *     reach X. From inside `docs/<name>/` now, X is just one level up — and this turns what
 *     used to be a GitHub round-trip into a real link to another page in this same stream.
 *   - `../<other-subproject>` (bare, naming exactly one of the *other* packages this same
 *     function is copying in) → `../<other-subproject>/README.md`: that package's own README
 *     is right there in the stream now too, so this becomes a real in-app link to it instead
 *     of leaving for GitHub — e.g. `cli/README.md`'s `../js` (the SDK) now points at
 *     `js/README.md`'s own page, not a directory listing on GitHub.
 *   - any other `../X` (the root README, a source file, a subproject not being copied) →
 *     `../../X`: it used to climb one level to reach repo root; from `docs/<name>/`, that
 *     climb is now one level short.
 *
 * @param {string} markdown
 * @param {string[]} subprojects - every subproject name being copied this run (see
 *   findSubprojectReadmes) — what distinguishes the second case above from the third.
 * @returns {string}
 */
export function relinkReadme(markdown, subprojects) {
	return markdown.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (whole, open, href, close) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return whole;
		if (href.startsWith('../docs/')) return open + '../' + href.slice('../docs/'.length) + close;
		if (href.startsWith('../')) {
			const bare = href.slice('../'.length).replace(/\/$/, '');
			if (subprojects.includes(bare)) return open + `../${bare}/README.md` + close;
			return open + '../' + href + close;
		}
		return whole;
	});
}

function copySubprojectReadmes() {
	const subprojects = findSubprojectReadmes();
	for (const name of subprojects) {
		const src = path.join(REPO_ROOT, name, 'README.md');
		const destDir = path.join(REPO_ROOT, DOCS_DIR, name);
		fs.mkdirSync(destDir, { recursive: true });
		fs.writeFileSync(path.join(destDir, 'README.md'), relinkReadme(fs.readFileSync(src, 'utf8'), subprojects));
	}
}

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

	// Before indexing/pushing anything, so both --dry-run and a real push always reflect
	// today's README content rather than whatever was copied last time this ran.
	copySubprojectReadmes();

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
