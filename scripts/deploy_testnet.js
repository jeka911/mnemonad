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

deployToNetwork('monadTestnet', parseDeployArgs(process.argv.slice(2))).catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
});
