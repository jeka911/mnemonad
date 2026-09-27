import { signTypedData } from '@wagmi/core';
import { MnemonadPresignProvider } from '@mnemonad';
import { config as wagmiConfig } from '../wagmi';

/**
 * Off-chain uploads via the sign server, with **no Pinata credential in this bundle**.
 *
 * Replaces the `VITE_PINATA_JWT_TOKEN` path, which baked a standing admin key into the
 * compiled JS: anyone who opened devtools on a deployed build got the same upload access
 * the app had. Here the browser holds nothing. It proves who it is with a wallet signature,
 * the server checks that a matching escrow was actually paid, and hands back a one-shot URL.
 *
 * Reads still go straight to a public IPFS gateway, which needs no credential at all — so
 * dropping the JWT costs nothing on the read path.
 */

const PRESIGN_URL = (import.meta.env.VITE_PRESIGN_URL || '').replace(/\/$/, '');

/**
 * Read gateway. Defaults to this project's Pinata **dedicated** gateway
 * (`<name>.mypinata.cloud/ipfs/`), not the shared `gateway.pinata.cloud` — override with
 * VITE_IPFS_GATEWAY if you're running against a different Pinata account's uploads.
 *
 * The shared gateway is aggressively rate-limited and returns 429 for ordinary app traffic —
 * measured live twice now: five consecutive reads of a freshly pinned CID (429 x5 shared,
 * 200 x5 dedicated), and later a 20-request burst (429 x20 shared, 200 x20 dedicated, then
 * 200 x50 at higher burst). The dedicated domain is safe to ship in a client bundle/commit to
 * config: it's a hostname, not a credential, and the content behind it is public IPFS either
 * way. List yours with `GET https://api.pinata.cloud/v3/ipfs/gateways`.
 */
const READ_GATEWAY = import.meta.env.VITE_IPFS_GATEWAY || 'https://azure-casual-firefly-850.mypinata.cloud/ipfs/';

/** How long a request signature stays valid. Short: it is used immediately. */
const SIGNATURE_TTL_SECONDS = 120;

/** True iff a sign server is configured, so callers can gate the offload UI on it. */
export const presignConfigured = !!PRESIGN_URL;

export const presignServerUrl = PRESIGN_URL || null;

/**
 * Cached `/config`. Fetched from the server rather than reconstructed locally so the
 * EIP-712 domain the wallet signs is byte-identical to the one the server verifies — two
 * hardcoded copies would eventually drift and produce signature failures that look like
 * wallet bugs.
 */
let configPromise = null;

export function fetchPresignConfig() {
	if (!PRESIGN_URL) return Promise.reject(new Error('No sign server configured'));
	if (!configPromise) {
		configPromise = fetch(`${PRESIGN_URL}/config`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`sign server /config failed (HTTP ${res.status})`);
				return await res.json();
			})
			.catch((err) => {
				configPromise = null; // don't cache a failure — the server may just be starting
				throw err;
			});
	}
	return configPromise;
}

/**
 * Live liveness check — never cached, unlike `fetchPresignConfig`, since the whole point is
 * "is it up *right now*". The server itself decides what "healthy" means (chain reachable,
 * gateway resolved — see `meta.js`'s own `/health` handler) and reports it as `status: 'ok'`
 * (HTTP 200) or `status: 'degraded'` (HTTP 503, with `error`); this just surfaces whichever it
 * said rather than re-deriving health from the status code alone.
 *
 * @returns {Promise<{status: string, error?: string}>}
 * @throws if unconfigured, unreachable, or the response isn't JSON.
 */
export async function fetchPresignHealth() {
	if (!PRESIGN_URL) throw new Error('No sign server configured');
	const res = await fetch(`${PRESIGN_URL}/health`);
	const body = await res.json().catch(() => ({}));
	// 503 is itself a valid, meaningful "degraded" answer from this endpoint — not a fetch
	// failure — so it's returned like any other body rather than thrown.
	if (res.ok || res.status === 503) return body;
	throw new Error(body.error || `sign server /health failed (HTTP ${res.status})`);
}

/**
 * A provider that asks the sign server for an upload URL per payload.
 *
 * @param {Object} params
 * @param {string} params.account - the address that paid the escrow; must be the signer.
 * @returns {?MnemonadPresignProvider} null when no sign server is configured.
 */
export function createPresignProvider({ account } = {}) {
	if (!PRESIGN_URL) return null;

	return new MnemonadPresignProvider({
		gatewayUrl: READ_GATEWAY,
		requestUploadUrl: async ({ hash, size }) => {
			if (!account) throw new Error('Connect a wallet before uploading.');

			const serverConfig = await fetchPresignConfig();
			const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS;

			// Signed with the domain/types the server published, not a local copy.
			const signature = await signTypedData(wagmiConfig, {
				domain: serverConfig.eip712.domain,
				types: serverConfig.eip712.types,
				primaryType: serverConfig.eip712.primaryType,
				message: {
					payer: account,
					contentHash: hash,
					size: BigInt(size),
					deadline: BigInt(deadline),
				},
			});

			const res = await fetch(`${PRESIGN_URL}/upload-url`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ payer: account, contentHash: hash, size, deadline, signature }),
			});

			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				// The server's error codes are actionable, so surface its message rather than
				// a generic failure — "no_escrow" in particular means the payment step was
				// skipped, which is a different problem from the upload failing.
				throw new Error(body.message || `Sign server refused the upload (HTTP ${res.status})`);
			}
			return { url: body.url };
		},
	});
}
