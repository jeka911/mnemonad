#!/usr/bin/env node
/**
 * Deploys the Mnemonad registry to Monad testnet.
 *
 *   node deploy_testnet.js [--max-chunk-bytes N] [--fee-recipient 0x...]
 *
 * Requires PRIVATE_KEY in contracts/.env (or already exported), belonging to a testnet
 * address funded from https://faucet.monad.xyz/.
 */
import { deployToNetwork, parseDeployArgs } from './deploy.js';

// try/catch rather than `.catch()`: argument parsing throws *synchronously*, before a
// promise exists to attach a handler to, so a bad flag would otherwise print a stack trace
// instead of the message the parser carefully wrote.
try {
	await deployToNetwork('monadTestnet', parseDeployArgs(process.argv.slice(2)));
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
}
