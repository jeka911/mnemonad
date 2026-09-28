import { connect, getAccount } from '@wagmi/core';
import { config } from '../wagmi.js';
import { getActiveNetwork } from '../settings.js';
import { passkeyConnector } from './passkeyConnector.js';

/**
 * Connects the passkey connector for either mode. One function, called from
 * `PasskeyCard.vue`'s two buttons, so there's exactly one place that builds the connector —
 * same reasoning `connectLocalSigner.js` documents for its own single entry point.
 *
 * Unlike Local Signer, this isn't restricted to testnet: a passkey account is a real account
 * meant to hold real value, not a burner-key testing convenience.
 *
 * @param {'create'|'signin'} mode
 * @returns {Promise<string>} the connected address
 */
export async function connectPasskeySigner(mode) {
	const activeNetwork = getActiveNetwork();
	const connector = passkeyConnector({ mode, chainId: activeNetwork.chain.id });
	await connect(config, { connector });
	return getAccount(config).address;
}
