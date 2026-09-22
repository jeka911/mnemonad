// App-wide settings and constants.
import { monad, monadTestnet } from 'viem/chains';

// Product name — shown in the logo and used as the base document title.
export const APP_TITLE = 'Mnemonad';

// Networks the app can run on. Contract addresses are added per feature as it
// gets deployed; a null address means that feature shows a "not deployed" state
// on this network instead of its UI.
export const NETWORKS = {
	testnet: {
		id: 'testnet',
		label: 'Testnet',
		chain: monadTestnet,
		faucetUrl: 'https://faucet.monad.xyz/',
	},
	mainnet: {
		id: 'mainnet',
		label: 'Mainnet',
		chain: monad,
		faucetUrl: null,
	},
};

const NETWORK_STORAGE_KEY = 'mnemonad_network';

// Which network the whole app boots into. Read once at module load (before
// wagmi builds its config), and only ever changed via setActiveNetworkId,
// which reloads the page so every module re-evaluates against the new choice.
export function getActiveNetworkId() {
	const stored = localStorage.getItem(NETWORK_STORAGE_KEY);
	return stored && NETWORKS[stored] ? stored : 'mainnet';
}

export function getActiveNetwork() {
	return NETWORKS[getActiveNetworkId()];
}

/**
 * @param {string} id
 * @param {{redirectTo?: string}} [options] Where to land instead of the current URL. For a
 *   page whose URL names a specific stream on the old network (see includes/streamRoute.js),
 *   reloading in place would just show that stream failing to exist on the new one.
 */
export function setActiveNetworkId(id, { redirectTo = null } = {}) {
	if (!NETWORKS[id] || id === getActiveNetworkId()) {
		return;
	}
	localStorage.setItem(NETWORK_STORAGE_KEY, id);
	// Either way this is a full document load, not a route change: the new network has to be
	// read at module-load time, before wagmi's config is built.
	if (redirectTo) {
		window.location.assign(redirectTo);
	} else {
		window.location.reload();
	}
}
