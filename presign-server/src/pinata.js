/**
 * Mints Pinata presigned upload URLs.
 *
 * **`maxFileSize` is advisory, not enforced.** Verified empirically against the live API:
 * a URL minted with `maxFileSize: 1024` accepted a 2048-byte upload with HTTP 200 and
 * pinned it. The sign endpoint accepts the field and silently drops it — options Pinata
 * *does* honour appear in the signed URL as `X-Upload-Option-*` params
 * (`X-Upload-Option-Network`, `X-Upload-Option-Keyvalue`), and no size param ever appears.
 * It is still sent here: harmless, self-documenting, and it starts working for free if
 * Pinata ever wires it up.
 *
 * So what this actually buys over the explorer's standing JWT is narrower than a byte
 * ceiling, but real: each URL is single-use (a second POST returns 409 "duplicate file
 * id"), short-lived, scoped to one file, and only obtainable by proving a paid escrow.
 * Abuse therefore costs the abuser a real payment per attempt instead of being free and
 * unlimited — it is priced and rate-limited, not prevented. Closing it properly needs
 * either a proxied upload (count bytes as they stream) or post-hoc reconciliation
 * (compare the pinned size against the escrow and unpin overages).
 */
export function createPinata(config, { fetchImpl = fetch } = {}) {
	/**
	 * @param {Object} params
	 * @param {number} params.maxFileSize - hard byte ceiling, enforced by Pinata
	 * @param {number} params.expiresIn - seconds the URL stays usable
	 * @param {Object} [params.keyvalues] - metadata stored on the file, for later auditing
	 * @param {string} [params.name]
	 * @returns {Promise<{url: string, expiresAt: number, maxFileSize: number}>}
	 */
	async function createUploadUrl({ maxFileSize, expiresIn, keyvalues, name }) {
		const signedAt = Math.floor(Date.now() / 1000);

		const res = await fetchImpl(config.pinataSignUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.pinataJwt}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				network: config.pinataNetwork,
				// `date` is required despite being documented as optional — verified against
				// the live API, which 400s with `["body","date"] Required` when it is absent.
				date: signedAt,
				expires: expiresIn,
				maxFileSize,
				...(name ? { name } : {}),
				...(keyvalues ? { keyvalues } : {}),
			}),
		});

		const text = await res.text();
		if (!res.ok) {
			throw new PinataError(`pinata: sign failed (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
		}

		let body;
		try {
			body = JSON.parse(text);
		} catch {
			throw new PinataError(`pinata: sign returned non-JSON: ${text.slice(0, 200)}`, 502);
		}

		// Verified response shape: `{ "data": "<signed url>" }` — a bare string, not an object.
		const url = typeof body?.data === 'string' ? body.data : null;
		if (!url) {
			throw new PinataError(`pinata: sign response had no URL: ${text.slice(0, 200)}`, 502);
		}

		return { url, expiresAt: signedAt + expiresIn, maxFileSize };
	}

	return { createUploadUrl };
}

export class PinataError extends Error {
	constructor(message, status) {
		super(message);
		this.name = 'PinataError';
		this.status = status;
	}
}
