/**
 * Test fixture for monadsync — a thin wrapper around mnemonad's own local-node harness
 * (`../../js/test/fixture.js`), which this package's tests reuse directly rather than
 * duplicating: it's a dev-only, monorepo-internal import (not part of either package's
 * published `files`), so there's no dependency-boundary concern, only one Hardhat-node
 * harness to keep correct.
 */
import Mnemonad from 'mnemonad';
import { startNode, makeClients, deployRegistry, makeBytes } from '../../js/test/fixture.js';

export { startNode, makeClients, makeBytes };

/**
 * Deploys a fresh registry and mints a brand-new writable stream on it.
 *
 * @param {Object} clients - from makeClients()
 * @param {Object} [params={}] - forwarded to `deployRegistry` (e.g. `maxChunkBytes`)
 * @returns {Promise<{mn: Mnemonad, contractAddress: string}>}
 */
export async function createMn(clients, params = {}) {
	const contractAddress = await deployRegistry(clients, params);
	const mn = await Mnemonad.create({
		publicClient: clients.publicClient,
		walletClient: clients.walletClient,
		contractAddress,
	});
	return { mn, contractAddress };
}

/**
 * Wraps an existing stream id for a fresh reader/writer instance.
 *
 * @param {Object} clients - from makeClients()
 * @param {string} contractAddress
 * @param {bigint} id
 * @returns {Mnemonad}
 */
export function makeMn(clients, contractAddress, id) {
	return new Mnemonad({
		publicClient: clients.publicClient,
		walletClient: clients.walletClient,
		contractAddress,
		id,
	});
}
