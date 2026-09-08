import { sha256 } from '@noble/hashes/sha2.js';

/**
 * @typedef {import('./Mnemonad.js').default} Mnemonad
 */

/**
 * Base class for an off-chain storage backend a Mnemonad stream can point at — IPFS
 * (`MnemonadIpfs`/`MnemonadPinataProvider`), and anything else with the same shape (a
 * Filecoin deal, Arweave, Walrus, a private bucket). The contract only ever stores a
 * `Pointer {hash, size, codec, locator}` — it has no idea which backend produced it, which
 * is deliberate: `codec` exists precisely so a new backend needs no contract change.
 *
 * A subclass fills in the methods below; everything here that already has a body
 * (`_verify`, `_expectLength`) is backend-agnostic and free to inherit — sha256 doesn't
 * care whether the bytes came from a gateway or a retrieval market.
 *
 * `attach(mnemonad)` — not a constructor param — is what lets a provider be built and
 * configured *before* a `Mnemonad` exists: `new Mnemonad({ offloadingProvider: myProvider })`
 * calls it once `this` is available, rather than requiring the caller to already have a
 * `Mnemonad` instance in hand just to construct their provider.
 */
export default class MnemonadOffloadingProvider {
	constructor() {
		/** @type {?Mnemonad} */
		this._mnemonad = null;
	}

	/**
	 * The on-chain `Pointer.codec` value this provider's pointers use. Two different
	 * providers can legitimately share one (e.g. any IPFS-pinning-service provider reports
	 * `Codec.IPFS`, since retrieval is CID-based regardless of who pinned it) — a genuinely
	 * different retrieval mechanism (a raw Filecoin deal, Walrus) needs its own value.
	 * @returns {number}
	 */
	static get codec() {
		throw new Error('MnemonadOffloadingProvider subclass must define a static codec getter');
	}

	/**
	 * Called once by `Mnemonad`'s constructor. Not meant to be called a second time with a
	 * different instance — a provider is scoped to one stream's lifetime.
	 * @param {Mnemonad} mnemonad
	 * @returns {this}
	 */
	attach(mnemonad) {
		this._mnemonad = mnemonad;
		return this;
	}

	/** @returns {boolean} True iff this provider has enough configuration to read. */
	get isEnabled() {
		throw new Error('not implemented');
	}

	/** @returns {boolean} True iff this provider can upload, not merely read. */
	get canWrite() {
		throw new Error('not implemented');
	}

	/**
	 * Uploads bytes and returns a Pointer struct ready for `pushExternal`.
	 * @param {Uint8Array} data
	 * @returns {Promise<{hash: string, size: bigint, codec: number, locator: string}>}
	 */
	async putBytes(data) {
		throw new Error('not implemented');
	}

	/**
	 * Fetches and verifies the payload behind a Pointer.
	 * @param {Object} pointerData
	 * @returns {Promise<Uint8Array>}
	 */
	async readPointerBytes(pointerData) {
		throw new Error('not implemented');
	}

	/**
	 * Fetches `len` bytes at `start`, without pulling the whole payload where the backend
	 * supports it. See `MnemonadIpfs.readPointerRange`'s doc comment for the verification
	 * asymmetry every implementation of this needs to preserve (encrypted items' frames are
	 * self-authenticating and safe to range; plaintext items are not, since only the whole
	 * blob is hashed).
	 * @param {Object} pointerData
	 * @param {number} start
	 * @param {number} len
	 * @returns {Promise<Uint8Array>}
	 */
	async readPointerRange(pointerData, start, len) {
		throw new Error('not implemented');
	}

	/**
	 * Probes retrievability of every external item in the attached stream. Necessarily
	 * weak — most off-chain backends have no on-chain expiry, so this observes rather than
	 * guarantees.
	 * @param {Object} [params={}]
	 * @returns {Promise<Array<{index: number, locator: string, available: boolean, error: ?string}>>}
	 */
	async verifyAvailability(params = {}) {
		throw new Error('not implemented');
	}

	/**
	 * Re-persists an item's payload with this backend. Use after `verifyAvailability`
	 * reports a gap.
	 * @param {number} index
	 * @returns {Promise<string>} the (possibly unchanged) locator
	 */
	async repin(index) {
		throw new Error('not implemented');
	}

	/**
	 * Checks a fetched payload against the size and hash recorded on-chain. Shared by every
	 * subclass: a backend is an untrusted intermediary that can return anything, so this
	 * hash field is what stands in for its own integrity guarantee, regardless of transport.
	 * @param {Uint8Array} data
	 * @param {Object} pointerData
	 */
	_verify(data, pointerData) {
		const locator = pointerData.locator;
		const expectedSize = Number(pointerData.size ?? 0);
		if (expectedSize && data.length !== expectedSize) {
			throw new Error(
				`offloading: size mismatch for ${locator} — expected ${expectedSize}, got ${data.length}`
			);
		}

		const expectedHash = (pointerData.hash || '').toLowerCase();
		if (expectedHash && expectedHash !== `0x${'0'.repeat(64)}`) {
			const actual = bytesToHex(sha256(data)).toLowerCase();
			if (actual !== expectedHash) {
				throw new Error(
					`offloading: hash mismatch for ${locator} — expected ${expectedHash}, got ${actual}`
				);
			}
		}
	}

	/**
	 * @param {Uint8Array|ArrayLike<number>} part
	 * @param {number} len
	 * @param {string} locator
	 * @returns {Uint8Array}
	 */
	_expectLength(part, len, locator) {
		const data = part instanceof Uint8Array ? part : new Uint8Array(part);
		if (data.length !== len) {
			throw new Error(
				`offloading: ranged read of ${locator} returned ${data.length} bytes, expected ${len}`
			);
		}
		return data;
	}
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} 0x-prefixed hex
 */
export function bytesToHex(bytes) {
	let out = '0x';
	for (let i = 0; i < bytes.length; i += 1) {
		out += bytes[i].toString(16).padStart(2, '0');
	}
	return out;
}
