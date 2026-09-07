import { defineStore } from 'pinia';

// sessionStorage, not localStorage: these are debug toggles for "right now", not saved
// preferences like the network choice (settings.js) — they should reset the next time the
// browser is actually restarted, not linger silently forever.
const STORAGE_KEY = 'mnemonad_debug_caching_disabled';
const PRESENTATION_STORAGE_KEY = 'mnemonad_debug_presentation_mode';

function readInitial() {
	try {
		return sessionStorage.getItem(STORAGE_KEY) === 'true';
	} catch {
		return false; // sessionStorage unavailable — default to caching on, as if this store didn't exist
	}
}

function readInitialPresentationMode() {
	try {
		return sessionStorage.getItem(PRESENTATION_STORAGE_KEY) === 'true';
	} catch {
		return false;
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
		/**
		 * When true, non-essential chrome around the actual demo content — the app header,
		 * footer, and the "Add" panel on a vector page — dims to a low opacity. For screen
		 * recordings/live demos: nothing to disable or hide outright (a stray click still
		 * works exactly as before), just visually de-emphasized so the audience's eye goes
		 * to the vector/items instead of the surrounding nav chrome.
		 */
		presentationMode: readInitialPresentationMode(),
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
		setPresentationMode(value) {
			this.presentationMode = !!value;
			try {
				sessionStorage.setItem(PRESENTATION_STORAGE_KEY, String(this.presentationMode));
			} catch {
				// Best-effort persistence only, same as setCachingDisabled above.
			}
		},
	},
});
