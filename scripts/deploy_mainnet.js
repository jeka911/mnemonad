#!/usr/bin/env node
/**
 * Deploys the Mnemonad registry to Monad mainnet.
 *
 *   CONFIRM_MAINNET_DEPLOY=1 node deploy_mainnet.js [--max-chunk-bytes N] [--fee-recipient 0x...]
 *
 * Requires PRIVATE_KEY in contracts/.env (or already exported), funded with real MON. The
 * CONFIRM_MAINNET_DEPLOY guard exists so this can never fire from a stray or copy-pasted
 * command — mainnet deployment is real, immutable, and spends real funds. Per PLAN.md
 * §0/§4, this is deliberately a V2-and-later step: testnet first.
 */
import { deployToNetwork, parseDeployArgs } from './deploy.js';

if (process.env.CONFIRM_MAINNET_DEPLOY !== '1') {
	console.error(
		'deploy: refusing to deploy to Monad mainnet without CONFIRM_MAINNET_DEPLOY=1. ' +
			'This spends real funds and cannot be undone — set the env var only once you mean it.'
	);
	process.exitCode = 1;
} else {
	deployToNetwork('monad', parseDeployArgs(process.argv.slice(2))).catch((err) => {
		console.error(err.message);
		process.exitCode = 1;
	});
}
