/**
 * Pushes a local folder into a Mnemonad stream on a live network, as a versioned, diffed
 * filesystem — the same shape the explorer's file browser reads back.
 *
 * Runs the `mnemonad` CLI (cli/bin/mnemonad.js) as a subprocess rather than importing its
 * internals: the CLI is the supported interface for this, so a dataset push exercises the
 * exact same argument parsing, defaults (presign server, IPFS gateway — see
 * cli/mnemonad.config.js) and exit codes an operator would get typing the command by hand.
 * Folder walking, CDC diffing against the last on-chain version, IPFS offload for anything
 * over the registry's maxChunkBytes, ownership checks and the `.mnemonad` manifest all live
 * there; nothing here reimplements them.
 *
 * What this adds is only this repo's own operator conventions: the key comes from
 * `PRIVATE_KEY` in contracts/.env like every other script in this folder (handed to the CLI
 * as its own `MNEMONAD_KEY`), and the dataset directory defaults to `sample_datasets/text`.
 *
 * Encryption is deliberately not exposed here — a shared sample dataset has nothing to
 * encrypt, and `mnemonad push --encrypt --encrypt-with password|wallet` covers that case
 * with better flags than this script would grow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, 'contracts/.env');
const CLI_BIN = path.join(REPO_ROOT, 'cli/bin/mnemonad.js');

/** Default dataset, relative to the repo root. */
const DEFAULT_DIR = 'sample_datasets/text';

/** `deployToNetwork`'s network keys -> the CLI's own `--chain` names. */
const CLI_CHAIN = {
	monadTestnet: 'testnet',
	monad: 'mainnet',
};

/**
 * @param {'monadTestnet'|'monad'} networkKey
 * @param {Object} [opts={}]
 * @param {string} [opts.dir] - folder to push, relative to the repo root (or absolute)
 * @param {string} [opts.streamId] - push into this existing stream; omit to create one
 * @param {boolean} [opts.manifest] - write/use `.mnemonad` for faster change detection
 * @param {boolean} [opts.forceSnapshot] - push a full snapshot instead of a diff
 * @param {string} [opts.exclude] - extra comma-separated exclude patterns
 * @returns {Promise<{streamId: ?string}>} the id the CLI reported, for the caller to print
 *   or chain from; null if its output didn't name one (nothing to push, say).
 */
export async function pushDatasetToNetwork(networkKey, opts = {}) {
	const chain = CLI_CHAIN[networkKey];
	if (!chain) {
		throw new Error(
			`push-dataset: unknown network '${networkKey}', expected one of ${Object.keys(CLI_CHAIN).join(', ')}`
		);
	}
	if (!fs.existsSync(CLI_BIN)) {
		throw new Error(`push-dataset: the CLI is missing at ${CLI_BIN}`);
	}

	const dir = path.resolve(REPO_ROOT, opts.dir || DEFAULT_DIR);
	assertUsableDataset(dir);

	loadEnv();
	const key = normalizeKey(requireEnv('PRIVATE_KEY'));

	// Positional order the CLI expects: `push [stream-id] <path>`.
	const argv = ['push'];
	if (opts.streamId) argv.push(opts.streamId);
	argv.push(dir, '--chain', chain);
	if (opts.manifest) argv.push('--manifest');
	if (opts.forceSnapshot) argv.push('--force-snapshot');
	if (opts.exclude) argv.push('--exclude', opts.exclude);

	console.log(`Pushing ${path.relative(REPO_ROOT, dir) || dir} to ${chain}`);
	console.log(`  $ mnemonad ${argv.join(' ')}`);

	const output = await runCli(argv, key);

	// Known outright when pushing into an existing stream; otherwise read back from the
	// CLI's own `created:` line, which is the only place a freshly minted id is announced.
	// Parsing is confined to that one case on purpose — the id we were handed is never
	// re-derived from output that may or may not mention it (a no-op push doesn't).
	const streamId = opts.streamId || (output.match(/\bcreated:\s*(\d+)/) || [])[1] || null;
	if (streamId && chain === 'testnet') {
		console.log(`  browse:        https://mnemonad.vercel.app/stream/${streamId}/files`);
	}
	return { streamId };
}

/**
 * Minimal `--flag value` parser, matching deploy.js's own so the two scripts feel the same.
 *
 * @param {string[]} argv
 * @returns {{dir?: string, streamId?: string, manifest?: boolean, forceSnapshot?: boolean, exclude?: string}}
 */
export function parsePushDatasetArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dir') {
			out.dir = argv[(i += 1)];
		} else if (arg === '--stream-id') {
			out.streamId = argv[(i += 1)];
		} else if (arg === '--exclude') {
			out.exclude = argv[(i += 1)];
		} else if (arg === '--manifest') {
			out.manifest = true;
		} else if (arg === '--force-snapshot') {
			out.forceSnapshot = true;
		} else {
			throw new Error(`push-dataset: unrecognized argument '${arg}'`);
		}
	}
	return out;
}

/**
 * Runs the CLI, streaming its output through as it arrives *and* keeping a copy — a push
 * takes long enough that swallowing progress until it finished would look like a hang, but
 * the stream id it prints is needed afterwards.
 *
 * The key travels as `MNEMONAD_KEY` in the child's environment rather than as a `--key`
 * argument, so it never appears in a process listing.
 *
 * @param {string[]} argv
 * @param {string} key
 * @returns {Promise<string>} everything the CLI wrote to stdout
 */
function runCli(argv, key) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_BIN, ...argv], {
			env: { ...process.env, MNEMONAD_KEY: key },
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on('data', (chunk) => process.stderr.write(chunk));

		child.on('error', (err) => reject(new Error(`push-dataset: could not run the CLI — ${err.message}`)));
		child.on('close', (code) => {
			if (code === 0) resolve(stdout);
			// The CLI has already printed its own message; this only sets the exit status.
			else reject(new Error(`push-dataset: mnemonad push exited with code ${code}`));
		});
	});
}

/**
 * A dataset that doesn't exist, isn't a directory, or holds nothing would still push
 * "successfully" — creating an empty stream and paying gas for it. Caught here instead.
 */
function assertUsableDataset(dir) {
	if (!fs.existsSync(dir)) {
		throw new Error(`push-dataset: no such directory: ${dir}`);
	}
	if (!fs.statSync(dir).isDirectory()) {
		throw new Error(`push-dataset: not a directory: ${dir}`);
	}
	// Matches what the push itself will walk: dotfiles are excluded by the CLI's own default
	// excludes, so a folder holding only those is empty as far as this is concerned.
	const visible = fs.readdirSync(dir).filter((name) => !name.startsWith('.'));
	if (visible.length === 0) {
		throw new Error(`push-dataset: ${dir} is empty — put the dataset's files there first.`);
	}
}

function loadEnv() {
	try {
		process.loadEnvFile(ENV_PATH);
	} catch {
		// no contracts/.env — fine if PRIVATE_KEY is already exported.
	}
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`push-dataset: ${name} is not set. Add it to contracts/.env or export it before running.`);
	}
	return value;
}

function normalizeKey(key) {
	return key.startsWith('0x') ? key : `0x${key}`;
}
