#!/usr/bin/env node
/**
 * Deploys MnemonadUploadGateway to Monad mainnet and wires it into the registry recorded
 * in js/ids.js.
 *
 *   node deploy_gateway_mainnet.js --pyth 0x... [--registry 0x...] [--feed-id 0x...]
 *                                  [--owner 0x...] [--no-wire]
 *
 * `--pyth` is REQUIRED here. There is no hardcoded mainnet default on purpose: Pyth's
 * mainnet address must be read off their contract-address list and passed in deliberately,
 * rather than inherited from a testnet constant, because it is the oracle a money-handling
 * contract prices against.
 *   https://docs.pyth.network/price-feeds/core/contract-addresses/evm
 *
 * Requires PRIVATE_KEY in contracts/.env (or already exported), owning the registry.
 */
import { deployGateway, parseGatewayArgs } from './deploy_gateway.js';

deployGateway('monad', parseGatewayArgs(process.argv.slice(2))).catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
});
