import { defineStore } from 'pinia';

/**
 * In-memory cache of unwrapped data keys for password-encrypted streams, keyed by stream id
 * (as a string — Pinia state can't hold a `Map` of `bigint` keys reliably across reactivity,
 * and a decimal string round-trips a `bigint` losslessly).
 *
 * Deliberately NOT persisted to sessionStorage the way `debug.js`'s flags are. A reload is
 * meant to forget every unlocked key and re-prompt for the password — the whole point of
 * "session-only" here is "while this tab stays open in memory", not "survives a reload". See
 * `docs/caching.md`'s stance on never persisting post-decryption plaintext; the key itself is
 * held to the same standard, more strictly.
 */
export const useStreamKeysStore = defineStore('streamKeys', {
	state: () => ({
		/** @type {Object<string, Uint8Array>} */
		keys: {},
	}),
	getters: {
		hasKey: (state) => (streamId) => !!state.keys[String(streamId)],
	},
	actions: {
		/**
		 * @param {bigint|string} streamId
		 * @returns {?Uint8Array}
		 */
		getKey(streamId) {
			return this.keys[String(streamId)] || null;
		},
		/**
		 * @param {bigint|string} streamId
		 * @param {Uint8Array} key
		 */
		setKey(streamId, key) {
			// A plain object keyed by string, not a real Map — Pinia's devtools/reactivity
			// diffing handles a plain object far better than a Map, and nothing here needs
			// Map's iteration order or non-string keys.
			this.keys = { ...this.keys, [String(streamId)]: key };
		},
		/** @param {bigint|string} streamId */
		clearKey(streamId) {
			const { [String(streamId)]: _removed, ...rest } = this.keys;
			this.keys = rest;
		},
		/** Drops every cached key — e.g. on wallet disconnect. */
		clearAll() {
			this.keys = {};
		},
	},
});
