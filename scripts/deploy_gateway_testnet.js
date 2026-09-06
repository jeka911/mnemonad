#!/usr/bin/env node
/**
 * Deploys MnemonadUploadGateway to Monad testnet and wires it into the registry recorded
 * in js/ids.js.
 *
 *   node deploy_gateway_testnet.js [--registry 0x...] [--pyth 0x...] [--feed-id 0x...]
 *                                  [--owner 0x...] [--no-wire]
 *
 * Requires PRIVATE_KEY in contracts/.env (or already exported). Wiring is `onlyOwner` on the
 * registry, so that key must own it — otherwise pass --no-wire and call setUploadGateway
 * separately.
 *
 * Deploy the registry first: the gateway's `mnemonad` address is immutable.
 */
import { deployGateway, parseGatewayArgs } from './deploy_gateway.js';

// try/catch rather than `.catch()`: argument parsing throws *synchronously*, before a
// promise exists to attach a handler to, so a bad flag would otherwise print a stack trace
// instead of the message the parser carefully wrote.
try {
	await deployGateway('monadTestnet', parseGatewayArgs(process.argv.slice(2)));
} catch (err) {
	console.error(err.message);
	process.exitCode = 1;
}
