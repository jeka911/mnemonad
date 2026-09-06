#!/usr/bin/env node
/**
 * Collects protocol revenue on Monad testnet.
 *
 *   node collect_fees_testnet.js                    # dry run — reports, sends nothing
 *   node collect_fees_testnet.js --execute
 *   node collect_fees_testnet.js --execute --to 0x... [--gateway-only|--registry-only]
 *
 * Requires PRIVATE_KEY in contracts/.env (or already exported). The gateway's
 * `withdrawRevenue` is onlyOwner, so that key must own the gateway; the registry's
 * `withdrawFees` is permissionless but always pays `feeRecipient`, which `--to` cannot
 * change.
 */
import { collectFees, parseCollectArgs } from './collect_fees.js';

// try/catch rather than `.catch()`: argument parsing throws *synchronously*, before a
// promise exists to attach a handler to, so a bad flag would otherwise print a stack trace
// instead of the message the parser carefully wrote.
try {
	await collectFees('monadTestnet', parseCollectArgs(process.argv.slice(2)));
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
}
