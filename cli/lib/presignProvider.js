/**
 * Node/viem port of explorer/src/mnemonad/presignProvider.js's `createPresignProvider`.
 *
 * Same off-chain-upload flow, same server (see `presign-server/README.md`'s diagram): a
 * paid on-chain escrow (handled automatically by Mnemonad's own `push()` — see
 * `Mnemonad._pushExternalAuto`) is proven with an EIP-712 signature, the server checks it
 * against the escrow and hands back a one-shot Pinata upload URL. No Pinata credential ever
 * touches this process, unlike `--pinata-jwt`.
 *
 * The only real difference from the browser version: the explorer signs with `wagmi`'s
 * `signTypedData` against a connected wallet; here the CLI already holds a local viem
 * account (from `chainClient.js`), and viem's local accounts sign EIP-712 data directly via
 * `account.signTypedData(...)` — no wallet client or connected extension needed.
 */
import { MnemonadPresignProvider } from 'mnemonad';

const SIGNATURE_TTL_SECONDS = 120;

/**
 * @param {Object} params
 * @param {string} params.presignUrl - base URL of the presign server (no trailing slash)
 * @param {string} params.gatewayUrl - public IPFS gateway for reads (same one every other
 *   read path in this CLI uses — see chainClient.js's own default)
 * @param {import('viem/accounts').LocalAccount} params.account - signs the upload request;
 *   must be the same address that paid the on-chain escrow (`payer` in the signed message)
 * @returns {MnemonadPresignProvider}
 */
export function createPresignProvider({ presignUrl, gatewayUrl, account }) {
	const baseUrl = presignUrl.replace(/\/$/, '');
	let configPromise = null;

	function fetchConfig() {
		if (!configPromise) {
			configPromise = fetch(`${baseUrl}/config`)
				.then(async (res) => {
					if (!res.ok) throw new Error(`presign server /config failed (HTTP ${res.status})`);
					return await res.json();
				})
				.catch((err) => {
					configPromise = null; // don't cache a failure — the server may just be starting
					throw err;
				});
		}
		return configPromise;
	}

	return new MnemonadPresignProvider({
		gatewayUrl,
		requestUploadUrl: async ({ hash, size }) => {
			const serverConfig = await fetchConfig();
			const deadline = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS;

			// Signed with the domain/types the server published, not a local copy — see
			// presign-server/README.md's own reasoning for why (drift between two hardcoded
			// copies would eventually produce signature failures that look like account bugs).
			const signature = await account.signTypedData({
				domain: serverConfig.eip712.domain,
				types: serverConfig.eip712.types,
				primaryType: serverConfig.eip712.primaryType,
				message: {
					payer: account.address,
					contentHash: hash,
					size: BigInt(size),
					deadline: BigInt(deadline),
				},
			});

			const res = await fetch(`${baseUrl}/upload-url`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ payer: account.address, contentHash: hash, size, deadline, signature }),
			});

			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				// The server's error codes are actionable (e.g. "no_escrow" means the payment
				// step was skipped) — surface its message rather than a generic failure.
				throw new Error(body.message || `presign server refused the upload (HTTP ${res.status})`);
			}
			return { url: body.url };
		},
	});
}
