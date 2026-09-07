import { defineStore } from 'pinia';

// sessionStorage, not localStorage: this is a debug toggle for "right now", not a saved
// preference like the network choice (settings.js) — it should reset the next time the
// browser is actually restarted, not linger silently forever.
const STORAGE_KEY = 'mnemonad_debug_caching_disabled';

function readInitial() {
	try {
		return sessionStorage.getItem(STORAGE_KEY) === 'true';
	} catch {
		return false; // sessionStorage unavailable — default to caching on, as if this store didn't exist
	}
}

/**
 * Debug-only session state. Currently just the one toggle, but deliberately its own store
 * rather than folded into `useMnemonadStore` — this is explicitly transient/session-scoped,
 * unlike everything else that store holds, and keeping it separate means a future debug knob
 * has an obvious place to go without further muddying the "real" app state.
 */
export const useDebugStore = defineStore('debug', {
	state: () => ({
		/**
		 * When true, every `Mnemonad` instance constructed anywhere in the app is built with
		 * `cache: false` (see stores/mnemonad.js and pages/Vector.vue) — every read hits the
		 * chain/IPFS directly, no IndexedDB or in-memory cache involved at any layer. See
		 * docs/caching.md.
		 */
		cachingDisabled: readInitial(),
	}),
	actions: {
		setCachingDisabled(value) {
			this.cachingDisabled = !!value;
			try {
				sessionStorage.setItem(STORAGE_KEY, String(this.cachingDisabled));
			} catch {
				// Best-effort persistence only — the toggle still works for the rest of this
				// page's life either way, it just won't survive a reload without storage.
			}
		},
	},
});
