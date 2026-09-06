import { sha256 } from '@noble/hashes/sha2.js';
import MnemonadOffloadingProvider, { bytesToHex } from './MnemonadOffloadingProvider.js';

/**
 * @typedef {import('./Mnemonad.js').default} Mnemonad
 */

/** Pointer codecs. Reserved so new backends need no contract change. */
export const Codec = {
	IPFS: 0,
	ARWEAVE: 1,
	HTTPS: 2,
};

/**
 * Generic IPFS offloading provider — any pinning-service HTTP API (Pinata, web3.storage,
 * Filebase, a self-hosted kubo node) fits via `pinningUrl`/`pinningJwt`, or supply a fully
 * custom `ipfsClient` transport. `MnemonadPinataProvider` is a thin preset of this for
 * Pinata specifically, when you'd rather not type its URLs out.
 *
 * Attached as `mnemonad.offloadingProvider` on every instance by default (see `Mnemonad`'s
 * constructor); only "enabled" when a gateway, pinning endpoint or custom client is
 * supplied.
 *
 * IPFS has no on-chain rent and no expiry — availability depends entirely on someone
 * continuing to pin the data. Two consequences worth knowing:
 *
 *   - There is deliberately **no** on-chain-managed extension mechanism. Nothing on-chain
 *     can be extended. `verifyAvailability()` and `repin()` are the honest substitutes,
 *     and they are off-chain operations with no guarantees behind them.
 *   - Every read is **hash-verified** before being returned. A gateway is an untrusted
 *     intermediary that could return anything, so the contract stores a sha256 of the
 *     payload and reads check it.
 *
 * Availability here is only as strong as "someone is still pinning this" — an off-chain
 * promise, not an on-chain guarantee. That is a real limitation, not a detail.
 */
export default class MnemonadIpfs extends MnemonadOffloadingProvider {
	/**
	 * @param {Object} [params={}]
	 * @param {?Mnemonad} [params.mnemonad] - parent Mnemonad, if already constructed; otherwise
	 *   call `attach(mnemonad)` once one exists
	 * @param {?string} [params.gatewayUrl] - HTTP gateway for reads, e.g. https://ipfs.io/ipfs/
	 * @param {?string} [params.pinningUrl] - HTTP endpoint for pinning uploads
	 * @param {?string} [params.pinningJwt] - static bearer token for the pinning endpoint
	 * @param {?() => Promise<string>} [params.pinningJwtProvider] - resolved fresh before
	 *   every upload, instead of a static `pinningJwt` — the browser-safe half of a
	 *   pre-signed/temporary-JWT flow (see `MnemonadPinataProvider.mintUploadJwt`, the
	 *   server-only half). Takes priority over `pinningJwt` when both are given.
	 * @param {?Object} [params.ipfsClient] - custom transport: `{ put(bytes), get(cid) }`
	 */
	constructor(params = {}) {
		super();
		if (params.mnemonad) this.attach(params.mnemonad);
		/** @type {?string} */
		this._gatewayUrl = params.gatewayUrl || null;
		/** @type {?string} */
		this._pinningUrl = params.pinningUrl || null;
		/** @type {?string} */
		this._pinningJwt = params.pinningJwt || null;
		/** @type {?() => Promise<string>} */
		this._pinningJwtProvider = params.pinningJwtProvider || null;
		/** @type {?Object} */
		this._ipfsClient = params.ipfsClient || null;
	}

	static get codec() {
		return Codec.IPFS;
	}

	/** @returns {boolean} True iff any IPFS transport was configured. */
	get isEnabled() {
		return !!(this._ipfsClient || this._gatewayUrl || this._pinningUrl);
	}

	/** @returns {boolean} True iff this companion can upload, not merely read. */
	get canWrite() {
		return !!(this._ipfsClient?.put || this._pinningUrl);
	}

	/**
	 * @returns {Promise<?string>} the JWT for the *next* pinning-URL upload — from
	 *   `pinningJwtProvider` if one is configured (called fresh, not cached, so a
	 *   single-use temporary key is naturally re-minted per attempt rather than reused
	 *   after it's spent), otherwise the static `pinningJwt`.
	 */
	async _resolvePinningJwt() {
		if (this._pinningJwtProvider) return await this._pinningJwtProvider();
		return this._pinningJwt;
	}

	/**
	 * Uploads bytes and returns a Pointer struct ready for `pushExternal`.
	 *
	 * @param {Uint8Array} data
	 * @returns {Promise<{hash: string, size: bigint, codec: number, locator: string}>}
	 */
	async putBytes(data) {
		if (!this.canWrite) {
			throw new Error(
				'ipfs.putBytes requires ipfsClient.put or pinningUrl to be configured'
			);
		}

		const cid = this._ipfsClient?.put
			? await this._ipfsClient.put(data)
			: await this._putViaPinningUrl(data);

		if (!cid || typeof cid !== 'string') {
			throw new Error('ipfs: upload did not return a CID string');
		}

		return {
			hash: bytesToHex(sha256(data)),
			size: BigInt(data.length),
			codec: Codec.IPFS,
			locator: cid,
		};
	}

	/**
	 * Fetches and verifies the payload behind a Pointer.
	 *
	 * @param {Object} pointerData - decoded on-chain Pointer
	 * @returns {Promise<Uint8Array>}
	 * @throws {Error} If the fetched bytes don't match the recorded size or hash.
	 */
	async readPointerBytes(pointerData) {
		if (!this.isEnabled) {
			throw new Error('ipfs.readPointerBytes requires gatewayUrl or ipfsClient');
		}
		if (!pointerData?.locator) {
			throw new Error('ipfs: pointer has no locator');
		}

		const locator = pointerData.locator;
		const bytes = this._ipfsClient?.get
			? await this._ipfsClient.get(locator)
			: await this._getViaGateway(locator);

		const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		this._verify(data, pointerData);
		return data;
	}

	/**
	 * Fetches `len` bytes at `start` of an off-chain payload, without pulling the whole
	 * thing when the transport can serve a range.
	 *
	 * **Integrity is the caller's problem here**, and deliberately so. The pointer's sha256
	 * covers the entire blob, so a partial fetch cannot be checked against it. Two cases:
	 *
	 *   - Encrypted items: safe. Every frame carries its own GCM tag with its index and
	 *     finality bound into the AAD, so a tampered, reordered or truncated frame fails to
	 *     decrypt. The blob hash adds nothing a frame tag doesn't already give.
	 *   - Plaintext items: NOT verified. `Mnemonad` therefore keeps fetching those
	 *     whole by default, and only ranges them when explicitly allowed.
	 *
	 * Falls back to a whole-payload fetch (verified, then sliced) when the transport has no
	 * ranged read — so behaviour is correct everywhere, just cheaper where supported.
	 *
	 * @param {Object} pointerData
	 * @param {number} start
	 * @param {number} len
	 * @returns {Promise<Uint8Array>}
	 */
	async readPointerRange(pointerData, start, len) {
		if (!this.isEnabled) {
			throw new Error('ipfs.readPointerRange requires gatewayUrl or ipfsClient');
		}
		if (!pointerData?.locator) throw new Error('ipfs: pointer has no locator');
		if (len === 0) return new Uint8Array();

		const locator = pointerData.locator;

		if (this._ipfsClient?.getRange) {
			const part = await this._ipfsClient.getRange(locator, start, len);
			return this._expectLength(part, len, locator);
		}

		if (this._gatewayUrl) {
			const ranged = await this._getRangeViaGateway(locator, start, len);
			if (ranged) return this._expectLength(ranged, len, locator);
		}

		// No ranged transport: fetch whole, verify, slice. Correct but not cheap.
		const whole = await this.readPointerBytes(pointerData);
		return whole.subarray(start, start + len);
	}

	// _verify() and _expectLength() are inherited from MnemonadOffloadingProvider — the
	// hash/size/length checks don't depend on IPFS specifically.

	/**
	 * Checks whether every external item in the vector is currently retrievable.
	 *
	 * Fundamentally weak, by necessity: there is no on-chain expiry to read, so this
	 * probes a network and reports what it observed a moment ago. A `true` here is not a
	 * guarantee of anything.
	 *
	 * @param {Object} [params={}]
	 * @param {boolean} [params.verify=false] - also re-check hashes, not just retrievability
	 * @returns {Promise<Array<{index: number, locator: string, available: boolean, error: ?string}>>}
	 */
	async verifyAvailability(params = {}) {
		const ev = this._mnemonad;
		await ev.initialize();

		const results = [];
		for (let i = ev.firstAvailableIndex; i < ev.length; i += 1) {
			const pointer = await ev.pointerAt(i).catch(() => null);
			if (!pointer) continue; // not an external item

			try {
				if (params.verify) {
					await this.readPointerBytes(pointer);
				} else {
					await this._getViaGateway(pointer.locator);
				}
				results.push({ index: i, locator: pointer.locator, available: true, error: null });
			} catch (e) {
				results.push({
					index: i,
					locator: pointer.locator,
					available: false,
					error: e.message,
				});
			}
		}
		return results;
	}

	/**
	 * Re-uploads an external item's payload to the configured pinning service, keeping the
	 * same CID. Use after `verifyAvailability` reports a gap.
	 *
	 * @param {number} index
	 * @returns {Promise<string>} the CID that was re-pinned
	 */
	async repin(index) {
		const ev = this._mnemonad;
		const pointer = await ev.pointerAt(index);
		const data = await this.readPointerBytes(pointer);
		const fresh = await this.putBytes(data);

		if (fresh.locator !== pointer.locator) {
			throw new Error(
				`ipfs.repin: re-upload produced a different CID (${fresh.locator} vs ${pointer.locator}); ` +
				'the pinning service may be using different chunking or CID settings'
			);
		}
		return fresh.locator;
	}

	/**
	 * @param {Uint8Array} data
	 * @returns {Promise<string>} CID
	 */
	async _putViaPinningUrl(data) {
		const jwt = await this._resolvePinningJwt();
		const headers = {};
		if (jwt) headers.Authorization = `Bearer ${jwt}`;

		const form = new FormData();
		form.append('file', new Blob([data]), 'mnemonad-item.bin');

		const res = await fetch(this._pinningUrl, { method: 'POST', headers, body: form });
		if (!res.ok) {
			throw new Error(`ipfs: pinning upload failed (${res.status} ${res.statusText})`);
		}
		const json = await res.json();
		// Accept the field names used by the common pinning services.
		return json.IpfsHash || json.cid || json.Hash || json.value?.cid || null;
	}

	/**
	 * Attempts an HTTP range request against the gateway.
	 *
	 * @returns {Promise<?Uint8Array>} the range, or null if the gateway ignored it — many
	 *          gateways answer 200 with the full body instead of 206, and silently slicing
	 *          that would hide the fact that nothing was saved.
	 */
	async _getRangeViaGateway(cid, start, len) {
		const base = this._gatewayUrl.endsWith('/') ? this._gatewayUrl : `${this._gatewayUrl}/`;
		const res = await fetch(`${base}${cid}`, {
			headers: { Range: `bytes=${start}-${start + len - 1}` },
		});
		if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
		if (!res.ok) {
			throw new Error(
				`ipfs: ranged gateway fetch failed for ${cid} (${res.status} ${res.statusText})`
			);
		}
		return null; // Range unsupported; caller falls back to a whole-payload fetch.
	}

	/**
	 * @param {string} cid
	 * @returns {Promise<Uint8Array>}
	 */
	async _getViaGateway(cid) {
		if (!this._gatewayUrl) {
			throw new Error('ipfs: gatewayUrl is required to read external items');
		}
		const base = this._gatewayUrl.endsWith('/') ? this._gatewayUrl : `${this._gatewayUrl}/`;
		const res = await fetch(`${base}${cid}`);
		if (!res.ok) {
			throw new Error(`ipfs: gateway fetch failed for ${cid} (${res.status} ${res.statusText})`);
		}
		return new Uint8Array(await res.arrayBuffer());
	}
}
