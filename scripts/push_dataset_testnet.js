#!/usr/bin/env node
/**
 * Pushes a sample dataset folder into a Mnemonad stream on Monad testnet.
 *
 *   node push_dataset_testnet.js [--dir sample_datasets/text] [--stream-id N]
 *                               [--manifest] [--force-snapshot] [--exclude p1,p2]
 *
 * With no --stream-id it creates a new stream and prints its id; pass that id back on a
 * later run to push an incremental diff into the same stream instead of a fresh one.
 *
 * Requires PRIVATE_KEY in contracts/.env (or already exported), belonging to a testnet
 * address funded from https://faucet.monad.xyz/.
 */
import { pushDatasetToNetwork, parsePushDatasetArgs } from './push_dataset.js';

// try/catch rather than `.catch()`: argument parsing throws *synchronously*, before a
// promise exists to attach a handler to, so a bad flag would otherwise print a stack trace
// instead of the message the parser carefully wrote.
try {
	await pushDatasetToNetwork('monadTestnet', parsePushDatasetArgs(process.argv.slice(2)));
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
}
