import { sha256 } from '@noble/hashes/sha2.js';
import MnemonadIpfs, { Codec } from './MnemonadIpfs.js';
import { bytesToHex } from './MnemonadOffloadingProvider.js';

/**
 * Uploads through a **presigned URL obtained from your own server**, holding no pinning
 * credential itself.
 *
 * This is the provider a browser should use. The alternatives both put a credential in the
 * client bundle: `pinningJwt` ships a standing key that anyone who opens devtools can
 * reuse, and `pinningJwtProvider` + `mintUploadJwt` still needs the *admin* key present to
 * mint from. Here the client holds nothing — it asks a server for a one-shot URL, and the
 * server decides whether it has earned one (see `presign-server/`, which gates on paid
 * escrow).
 *
 * Reads are inherited unchanged: a public IPFS gateway needs no credential, so
 * `readPointerBytes`/`readPointerRange` and their hash verification work exactly as in
 * `MnemonadIpfs`.
 *
 * The hash is computed once here and handed to `requestUploadUrl`, rather than letting the
 * callback recompute it — the server needs it to look up the escrow, and hashing a payload
 * twice for the same push is pure waste.
 */
export default class MnemonadPresignProvider extends MnemonadIpfs {
	/**
	 * @param {Object} params - everything `MnemonadIpfs` takes, plus:
	 * @param {(req: {hash: string, size: number}) => Promise<{url: string}>} params.requestUploadUrl
	 *   Asks your server for a presigned upload URL for this exact payload. Throwing here
	 *   aborts the push, which is the right behaviour: better to fail before uploading than
	 *   to upload somewhere unaccounted for.
	 * @param {?string} [params.fileFieldName='file'] - multipart field the endpoint expects.
	 */
	constructor(params = {}) {
		super(params);
		this._requestUploadUrl = params.requestUploadUrl || null;
		this._fileFieldName = params.fileFieldName || 'file';
	}

	/**
	 * @returns {boolean} Writable on having a URL source — not on holding a credential,
	 *   which it never does.
	 */
	get canWrite() {
		return !!this._requestUploadUrl;
	}

	/** @returns {boolean} */
	get isEnabled() {
		return !!(this._requestUploadUrl || super.isEnabled);
	}

	/**
	 * @param {Uint8Array} data
	 * @returns {Promise<{hash: string, size: bigint, codec: number, locator: string}>}
	 */
	async putBytes(data) {
		if (!this._requestUploadUrl) {
			throw new Error('presign: requestUploadUrl is required to upload');
		}

		const hash = bytesToHex(sha256(data));
		const size = data.length;

		const issued = await this._requestUploadUrl({ hash, size });
		const url = typeof issued === 'string' ? issued : issued?.url;
		if (!url) throw new Error('presign: requestUploadUrl did not return a URL');

		const cid = await this._uploadTo(url, data);
		return { hash, size: BigInt(size), codec: Codec.IPFS, locator: cid };
	}

	/**
	 * POSTs the payload as multipart form data to a presigned URL.
	 *
	 * No Authorization header, deliberately — the URL *is* the authorisation, and attaching
	 * a token would defeat the point of the client holding none.
	 */
	async _uploadTo(url, data) {
		const form = new FormData();
		form.append(this._fileFieldName, new Blob([data]), 'payload.bin');

		const res = await fetch(url, { method: 'POST', body: form });
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`presign: upload failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
		}

		let body;
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error(`presign: upload returned non-JSON: ${text.slice(0, 160)}`);
		}

		// Pinata v3 presigned uploads answer `{ data: { cid, ... } }`. `IpfsHash` is accepted
		// too so a different presign backend can be dropped in without a subclass.
		const cid = body?.data?.cid || body?.cid || body?.IpfsHash;
		if (!cid || typeof cid !== 'string') {
			throw new Error(`presign: upload response had no CID: ${text.slice(0, 200)}`);
		}
		return cid;
	}
}
