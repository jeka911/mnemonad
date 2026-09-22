#!/usr/bin/env node
/**
 * Pushes the sample dataset into the stream it already lives in on Monad testnet, as an
 * incremental diff — the everyday companion to push_dataset_testnet.js, which mints a new
 * stream every time it runs.
 *
 *   node update_dataset_testnet.js [--dir sample_datasets/text] [--manifest]
 *                                 [--force-snapshot] [--exclude p1,p2]
 *
 * Nothing is written when the folder matches what's already on chain, so this is safe to
 * re-run. Requires PRIVATE_KEY in contracts/.env to be the stream's owner (see below).
 */
import { pushDatasetToNetwork, parsePushDatasetArgs } from './push_dataset.js';
// Monorepo-internal import, the same arrangement cli/test and monadsync/test already use
// for js/test/fixture.js. The explorer owns this list because it's what surfaces these
// streams to anyone (see /select's "Sample streams"); importing it rather than repeating an
// id here means re-creating a dataset is one edit, not two kept in step by hand.
import { sampleStreamsFor } from '../explorer/src/mnemonad/sampleStreams.js';

/** Matched by the `source` path, so this keeps pointing at the right stream if more are added. */
const DATASET_SOURCE = 'sample_datasets/text';

/**
 * The testnet stream `sample_datasets/text` lives in, created by push_dataset_testnet.js.
 *
 * Owned by 0xbdE936AFf3eb3464971eeFD7dFE6F7dE4AC3E92C — only that account can push to it;
 * the contract rejects writes from anyone else, and the CLI checks before spending any gas.
 * Replacing this dataset wholesale means running push_dataset_testnet.js again and putting
 * the new id in explorer/src/mnemonad/sampleStreams.js.
 */
const DATASET_STREAM_ID = sampleStreamsFor('testnet').find((s) => s.source === DATASET_SOURCE)?.id;

try {
	if (!DATASET_STREAM_ID) {
		throw new Error(
			`update-dataset: no testnet sample stream with source '${DATASET_SOURCE}' in ` +
			'explorer/src/mnemonad/sampleStreams.js — run push_dataset_testnet.js to create one ' +
			'and record its id there.'
		);
	}
	const args = parsePushDatasetArgs(process.argv.slice(2));
	// The point of this script is that the id isn't a decision to make per run — so an
	// explicit one is a mistake worth naming rather than quietly honouring or discarding.
	if (args.streamId) {
		throw new Error(
			'update-dataset: this script always pushes to its own recorded stream ' +
			`(${DATASET_STREAM_ID}) — use push_dataset_testnet.js --stream-id to target another.`
		);
	}
	await pushDatasetToNetwork('monadTestnet', { ...args, streamId: DATASET_STREAM_ID });
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
}
