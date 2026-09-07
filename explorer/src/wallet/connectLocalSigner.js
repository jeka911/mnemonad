import { connect, getAccount } from '@wagmi/core';
import { monadTestnet } from 'viem/chains';
import { config } from '../wagmi.js';
import { getActiveNetwork } from '../settings.js';
import { localSignerConnector } from './localSignerConnector.js';

/**
 * Connects the local-signer connector for a raw private key, enforcing the one safety rule
 * that actually matters: testnet only, regardless of `VITE_ENABLE_LOCAL_SIGNER`.
 *
 * Shared by `LocalSignerCard.vue` and the `window.mnemonadConnectWithKey` console helper
 * (see `main.js`) so the gate lives in exactly one place. Duplicating it per entry point is
 * how a helper added later "for convenience" quietly ships without the check the original
 * had — one function, called from both, makes that impossible by construction.
 *
 * @param {string} privateKey
 * @returns {Promise<string>} the connected address
 */
export async function connectLocalSigner(privateKey) {
	const activeNetwork = getActiveNetwork();
	if (activeNetwork.chain.id !== monadTestnet.id) {
		throw new Error('Local signing only works on Testnet — switch networks first.');
	}
	const connector = localSignerConnector({ privateKey, chainId: activeNetwork.chain.id });
	await connect(config, { connector });
	return getAccount(config).address;
}
