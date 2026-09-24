/**
 * Test fixture for the CLI — a thin wrapper around mnemonad's own local-node harness
 * (`../../js/test/fixture.js`), the same way `monadsync/test/fixture.js` reuses it: a
 * dev-only, monorepo-internal import, so there's no dependency-boundary concern, only one
 * Hardhat-node harness to keep correct.
 *
 * Unlike monadsync's fixture (which hands tests a ready-made `Mnemonad` instance), the CLI's
 * command functions build their own chain client internally from a plain `args` object
 * (`lib/chainClient.js`'s `makeChainClient`). So what this fixture provides is a way to
 * build that `args` object against a real local node + freshly-deployed registry, plus
 * small fs helpers for writing/reading the temp folders push/pull operate on.
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNode, makeClients, deployRegistry, makeBytes, getRpcUrl, DEV_KEYS } from '../../js/test/fixture.js';

export { startNode, makeClients, makeBytes };

/**
 * Deploys a fresh registry on the running local node and returns the base `args` object
 * every command function expects, pre-filled for `--chain local` against it. Individual
 * tests spread this and override just the fields they care about (`streamId`, `path`, …).
 *
 * @param {Object} [params={}] - forwarded to `deployRegistry` (e.g. `maxChunkBytes`)
 * @returns {Promise<Object>} args, plus `{contractAddress, accountAddress}` for convenience
 */
export async function makeBaseArgs(params = {}) {
	const clients = makeClients();
	const contractAddress = await deployRegistry(clients, params);
	return {
		command: null,
		streamId: null,
		// Matches the real CLI's own default (bin/mnemonad.js): never falls back to cwd.
		// Every test overrides this explicitly with its own temp dir.
		path: null,
		chain: 'local',
		rpcUrl: getRpcUrl(),
		contractAddress,
		// null (not the real CLI's public-gateway default) — nothing in this suite pushes
		// externally-offloaded items, so no test needs real network access to read one back.
		gatewayUrl: null,
		key: DEV_KEYS[0],
		phrase: null,
		version: null,
		exclude: null,
		compress: 'gzip',
		encrypt: false,
		encryptWith: null,
		password: null,
		pinataJwt: null,
		manifest: false,
		forceSnapshot: false,
		pollInterval: 2,
		debounce: 1000,
		pushOnly: false,
		pullOnly: false,
		yes: false,
		// Not part of the real CLI's args shape — convenience for tests only.
		accountAddress: clients.account.address,
	};
}

/** Creates a fresh empty temp directory under the OS tmpdir, cleaned up by `cleanupDir`. */
export async function makeTempDir(prefix = 'mnemonad-cli-test-') {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(dir) {
	await rm(dir, { recursive: true, force: true });
}

/** Writes `content` (string or Uint8Array) to `relPath` inside `dir`, creating parent dirs. */
export async function writeTestFile(dir, relPath, content) {
	const full = join(dir, relPath);
	await mkdir(join(full, '..'), { recursive: true });
	await writeFile(full, content);
}

export async function readTestFile(dir, relPath) {
	return readFile(join(dir, relPath));
}

/**
 * Runs `fn`, capturing everything it wrote via `console.log` as an array of lines (each
 * call's args joined with a space, matching what would actually print). The command
 * functions communicate their results (a created stream id, a pushed version number) only
 * through console output, exactly like a real terminal session — this lets tests assert on
 * that output the same way a person reading the CLI's own stdout would, without needing the
 * command functions to also return structured data just for testability.
 *
 * @param {() => Promise<any>} fn
 * @returns {Promise<{result: any, lines: string[], text: string}>}
 */
export async function captureLogs(fn) {
	const lines = [];
	const original = console.log;
	console.log = (...args) => { lines.push(args.map(String).join(' ')); };
	try {
		const result = await fn();
		return { result, lines, text: lines.join('\n') };
	} finally {
		console.log = original;
	}
}

/**
 * Reads every regular file under `dir` (skipping the excludes any real push/pull would
 * skip too) and returns `{relPath: Buffer}`, for asserting a folder's full contents at
 * once rather than file-by-file.
 */
export async function readTree(dir, excludes = ['.mnemonad', '.git', 'node_modules']) {
	const { readdir } = await import('node:fs/promises');
	const out = {};
	async function walk(sub) {
		const entries = await readdir(join(dir, sub), { withFileTypes: true });
		for (const entry of entries) {
			if (excludes.includes(entry.name)) continue;
			const relPath = sub ? `${sub}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(relPath);
			} else if (entry.isFile()) {
				out[relPath] = await readFile(join(dir, relPath));
			}
		}
	}
	await walk('');
	return out;
}
