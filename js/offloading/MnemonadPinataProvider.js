import MnemonadIpfs from './MnemonadIpfs.js';

/** Pinata's classic pinning API. Same endpoint `MnemonadIpfs._putViaPinningUrl` already
 *  expects — its `IpfsHash` response field is one of the names already recognized. */
const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
/**
 * Pinata's own shared gateway, not a public one — reads what Pinata pinned without
 * waiting on public-DHT propagation, and (confirmed against a real account) actually
 * answers Range requests with a genuine 206.
 *
 * **Only a default because there is no account-independent alternative — override it for
 * anything beyond occasional reads.** This gateway is shared across all of Pinata's free
 * traffic and rate-limits hard: measured at 429 on five consecutive reads of a
 * freshly-pinned CID, where the same account's *dedicated* gateway answered all five 200.
 * Pass `gatewayUrl: 'https://<name>.mypinata.cloud/ipfs/'` instead; list your gateways
 * with `GET https://api.pinata.cloud/v3/ipfs/gateways`.
 */
const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
const PINATA_UNPIN_URL = 'https://api.pinata.cloud/pinning/unpin/';
const PINATA_GENERATE_KEY_URL = 'https://api.pinata.cloud/users/generateApiKey';

/**
 * Pinata preset of `MnemonadIpfs` — its endpoint URLs baked in as defaults, so a caller
 * only needs to supply `pinningJwt`. Everything `MnemonadIpfs` does (hash-verified reads,
 * ranged reads, `verifyAvailability`, `repin`) works unchanged; this class only adds
 * Pinata-specific convenience on top (`unpin`, matching its DELETE endpoint) and the
 * defaults below.
 *
 * ```js
 * new Mnemonad({
 *     ...,
 *     offloadingProvider: new MnemonadPinataProvider({ pinningJwt: process.env.PINATA_JWT_TOKEN }),
 * });
 * ```
 *
 * A key with just pinning-write scope is enough (see Pinata's key-permission settings);
 * the plain, static-JWT constructor param here is deliberately the same shape
 * `MnemonadIpfs` already accepts — nothing new to learn.
 *
 * For a frontend, that static JWT is still a standing credential shipped wherever the
 * code runs. `pinningJwtProvider` (inherited from `MnemonadIpfs`) plus this class's
 * `mintUploadJwt` static method implement Pinata's documented signed-upload pattern
 * instead — a narrow, single-use key minted fresh per upload:
 *
 * ```js
 * // server-only — never in a browser bundle:
 * app.post('/api/pinata-temp-key', async (req, res) => {
 *     const jwt = await MnemonadPinataProvider.mintUploadJwt(process.env.PINATA_ADMIN_JWT);
 *     res.json({ jwt });
 * });
 *
 * // frontend:
 * const provider = new MnemonadPinataProvider({
 *     pinningJwtProvider: () => fetch('/api/pinata-temp-key').then((r) => r.json()).then((j) => j.jwt),
 * });
 * ```
 *
 * `mintUploadJwt` itself makes a plain `fetch` — nothing about the function stops it being
 * called from a browser, which is exactly the mistake this pattern exists to avoid. Its
 * safety depends entirely on *where* it's called: only ever pass it the real admin JWT
 * from server-side code that already keeps that secret out of any bundle.
 */
export default class MnemonadPinataProvider extends MnemonadIpfs {
	/**
	 * @param {Object} [params={}]
	 * @param {?import('./Mnemonad.js').default} [params.mnemonad] - parent Mnemonad, if
	 *   already constructed; otherwise call `attach(mnemonad)` once one exists
	 * @param {string} params.pinningJwt - a Pinata API key/JWT with pinning-write scope
	 * @param {?string} [params.gatewayUrl] - override the default Pinata gateway
	 * @param {?string} [params.pinningUrl] - override the default Pinata pin endpoint
	 */
	constructor(params = {}) {
		super({
			gatewayUrl: PINATA_GATEWAY,
			pinningUrl: PINATA_PIN_URL,
			...params,
		});
	}

	/**
	 * Unpins a CID this provider (or anything else in the same Pinata account) previously
	 * pinned. Not part of `MnemonadOffloadingProvider`'s base contract — most backends have
	 * no equivalent of "delete", and this one deliberately doesn't pretend to reclaim
	 * anything on-chain; it only stops Pinata from continuing to serve the content.
	 *
	 * @param {string} cid
	 * @returns {Promise<void>}
	 */
	async unpin(cid) {
		const res = await fetch(`${PINATA_UNPIN_URL}${cid}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${this._pinningJwt}` },
		});
		if (!res.ok && res.status !== 404) {
			throw new Error(`pinata: unpin failed for ${cid} (HTTP ${res.status})`);
		}
	}

	/**
	 * **Server-only.** Mints a narrow, disposable Pinata JWT using the real, full-access
	 * admin JWT — Pinata's own documented signed-upload pattern
	 * (https://pinata.cloud/blog/how-to-upload-to-ipfs-from-the-frontend-with-signed-jwts/).
	 * The returned JWT is scoped to `pinFileToIPFS` only (no unpin, no listing, no admin
	 * surface) and single-use by default, so intercepting it in flight is worth at most one
	 * upload rather than standing access to the account.
	 *
	 * `adminJwt` must never reach a browser bundle. Call this from wherever your own backend
	 * already keeps that secret — an env var on a serverless function, a Node service — and
	 * hand the *result* to the frontend, typically via a `pinningJwtProvider` callback.
	 *
	 * @param {string} adminJwt - the real, full-access Pinata JWT
	 * @param {Object} [options={}]
	 * @param {number} [options.maxUses=1] - Pinata invalidates the key after this many uses
	 * @param {?string} [options.keyName] - defaults to a timestamped name
	 * @returns {Promise<string>} a temporary JWT scoped to pinFileToIPFS only
	 */
	static async mintUploadJwt(adminJwt, options = {}) {
		const res = await fetch(PINATA_GENERATE_KEY_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${adminJwt}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				keyName: options.keyName || `mnemonad-upload-${Date.now()}`,
				maxUses: options.maxUses ?? 1,
				permissions: {
					endpoints: {
						data: { pinList: false, userPinnedDataTotal: false },
						pinning: {
							pinFileToIPFS: true,
							pinJSONToIPFS: false,
							pinJobs: false,
							unpin: false,
							userPinPolicy: false,
						},
					},
				},
			}),
		});
		if (!res.ok) {
			throw new Error(`pinata: failed to mint a signed upload JWT (HTTP ${res.status})`);
		}
		const json = await res.json();
		if (!json.JWT) {
			throw new Error('pinata: generateApiKey did not return a JWT');
		}
		return json.JWT;
	}
}
