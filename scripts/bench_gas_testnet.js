#!/usr/bin/env node
/**
 * Measures storage, code and registry gas on Monad testnet under MIP-8 — see bench_gas.js.
 * Sends no transactions and needs no key.
 *
 *   node bench_gas_testnet.js [--stream <id>] [--read-stream <id>]... [--out report.md] [--json result.json] [--skip-existing]
 *
 * --stream picks the stream for the existing-stream and read sections (default: the docs
 * stream from explorer/src/mnemonad/docsStream.json). --read-stream adds more streams to
 * read from — any stream, owned by anyone.
 */
import { benchGasCli } from './bench_gas.js';

try {
	await benchGasCli('monadTestnet', process.argv.slice(2));
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
}
