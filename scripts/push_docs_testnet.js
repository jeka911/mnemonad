#!/usr/bin/env node
/**
 * Publishes docs/ to its stream on Monad testnet — creates the stream on the first run and
 * records its id in explorer/src/mnemonad/docsStream.json, pushes a diff on every later one.
 *
 *   node push_docs_testnet.js [--dry-run] [--force-snapshot] [--rebuild]
 *
 * --dry-run indexes and prints what would change, without writing anything on chain.
 * --rebuild starts the search index over (to switch it to the CLI's current default model).
 *
 * Requires PRIVATE_KEY in contracts/.env (or already exported). After the first run it must be
 * the docs stream's owner — the contract rejects pushes from anyone else.
 */
import { pushDocsToNetwork, parsePushDocsArgs } from './push_docs.js';

try {
	await pushDocsToNetwork('monadTestnet', parsePushDocsArgs(process.argv.slice(2)));
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
}
