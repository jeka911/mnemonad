import { createConnector } from '@wagmi/core';
import { createWalletClient, http } from 'viem';
import {
	createPasskeyWithPrfOutput,
	getPasskeyPrfOutput,
	createSecp256k1SigningSession,
	isMeraError,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';

/**
 * The connector's `id`/`name`, exported so other components can recognize a passkey session
 * (e.g. to render a badge) without hardcoding a copy of the string that could drift from
 * this file — same reasoning `localSignerConnector.js` documents for its own constants.
 */
export const PASSKEY_CONNECTOR_ID = 'mera-passkey';
export const PASSKEY_CONNECTOR_NAME = 'Passkey';

/** Shown to the authenticator; not secret, and never used to look anything up. */
const RELYING_PARTY_NAME = 'Mnemonad';

/**
 * WebAuthn requires `rp.id` to equal, or be a registrable-domain suffix of, the calling
 * origin's hostname — so it can't be a fixed production string: that would make the ceremony
 * fail outright (not just fragment accounts) on localhost and on every Vercel preview
 * deployment, which sit on a different registrable domain (`vercel.app` is a public-suffix
 * boundary, so `mnemonad.vercel.app` and `mnemonad-git-branch.vercel.app` don't share one).
 * Using the live hostname is always spec-valid; the cost is that preview deployments and
 * production don't share passkey accounts — acceptable, since real funds have no business on
 * a preview URL anyway. The one real consequence: moving the production deployment to a new
 * domain later starts everyone's passkey account over — there is no migration path, by the
 * nature of what rp.id is.
 */
function relyingPartyId() {
	return window.location.hostname;
}

/** One passkey is meant to hold one Mnemonad account; not user-facing beyond the
 *  authenticator's own UI, which may show it. */
const USER_NAME = 'mnemonad-account';

/**
 * A wagmi connector backed by a WebAuthn passkey instead of a browser wallet extension or a
 * typed-in private key — see docs/wallet/passkey-accounts.md for the full derivation and its
 * one real caveat (no recovery path if the passkey and every synced copy of it are lost).
 *
 * Structurally this is `localSignerConnector.js` with one difference: that connector already
 * has its account at factory-call time (the key was just typed in), so its `connect()` is
 * synchronous. Here the account doesn't exist until the WebAuthn ceremony completes, so
 * `connect()` itself runs it — the natural place, since every other wagmi connector
 * (WalletConnect, an injected extension) already does its own async prompting there.
 *
 * @param {Object} params
 * @param {'create'|'signin'} params.mode - 'create' registers a brand-new passkey (and,
 *   on an authenticator that doesn't evaluate PRF at creation time, runs a second ceremony
 *   automatically — see createPasskeyWithPrfOutput's own doc); 'signin' reproduces an
 *   existing one via a single assertion. Two distinct, real actions — not merged into one,
 *   the same way a plain "sign in" page doesn't secretly offer to register you.
 * @param {number} params.chainId - the only chain this connector will operate on. Not
 *   inferred from `config.chains[0]` inside the factory — same reasoning
 *   `localSignerConnector.js` documents for its own copy of this parameter.
 */
export function passkeyConnector({ mode, chainId }) {
	return createConnector((config) => {
		const chain = config.chains.find((c) => c.id === chainId);
		if (!chain) {
			throw new Error(`passkeyConnector: chain ${chainId} is not in this app's wagmi config`);
		}

		/** @type {ReturnType<typeof createSecp256k1SigningSession> | null} */
		let session = null;
		/** @type {import('viem').WalletClient | null} */
		let client = null;

		return {
			id: PASSKEY_CONNECTOR_ID,
			name: PASSKEY_CONNECTOR_NAME,
			type: 'passkey',

			/**
			 * Runs the WebAuthn ceremony, derives the secp256k1 account from the PRF output
			 * (directly — Mera's own session API accepts it as the private key as-is; the
			 * mnemonic/HD-derivation step in Mera's own getting-started example is for
			 * *multiple* accounts from one passkey, which this connector doesn't need), and
			 * builds the walletClient other methods below serve. `prfSalt` is deliberately
			 * never passed — the library's own fixed default
			 * (`sha256("mera.prf.salt.v1")`, documented stable across its versions) is what
			 * we rely on; passing a custom one here would be one more constant this project
			 * would then have to pin and never change, for no benefit at the one-account-per-
			 * passkey scope this connector covers.
			 */
			async connect() {
				try {
					const rp = { id: relyingPartyId(), name: RELYING_PARTY_NAME };
					const { prfOutput } = mode === 'create'
						? await createPasskeyWithPrfOutput({ rp, user: { name: USER_NAME, displayName: USER_NAME } })
						: await getPasskeyPrfOutput({ rpId: rp.id });

					session = createSecp256k1SigningSession({ privateKey: prfOutput });
					prfOutput.fill(0);

					// Everything past this point is local, synchronous viem plumbing around an
					// already-live session — if any of it threw with the session left assigned,
					// disconnect() would never run to end() it (wagmi never calls disconnect()
					// on a connect() that itself failed), leaking a live, unzeroed key for the
					// lifetime of this closure. Ending it here on the way out is what actually
					// closes that gap, not merely satisfying a lint rule.
					const account = toViemAccount(session);
					client = createWalletClient({ account, chain, transport: http() });
					return { accounts: [account.address], chainId: chain.id };
				} catch (error) {
					session?.end();
					session = null;
					client = null;
					throw describeError(error);
				}
			},

			async disconnect() {
				// Actually zeroes the key (see session.js in the library) — a real guarantee
				// `localSignerConnector.js` can't make about a plain string falling out of scope.
				session?.end();
				session = null;
				client = null;
			},

			async getAccounts() {
				if (!client?.account) return [];
				return [client.account.address];
			},

			async getChainId() {
				return chain.id;
			},

			/**
			 * Always false — same reasoning as `localSignerConnector.js`'s copy of this
			 * method: never registered in wagmi's static `connectors` list (built and
			 * connected ad hoc only when the card's own button is clicked), so there is
			 * nothing to reconnect *to* after a reload regardless. A passkey ceremony also
			 * isn't something to run silently on page load even if it could be — that's
			 * exactly the kind of unattended authenticator prompt a browser would (rightly)
			 * refuse to allow anyway.
			 */
			async isAuthorized() {
				return false;
			},

			async switchChain({ chainId: requested }) {
				if (requested === chain.id) return chain;
				throw new Error('passkeyConnector: cannot switch chain — reconnect with a different chain instead.');
			},

			async getClient({ chainId: requested } = {}) {
				if (requested !== undefined && requested !== chain.id) {
					throw new Error(`passkeyConnector: no client for chain ${requested} (connected to ${chain.id})`);
				}
				if (!client) throw new Error('passkeyConnector: not connected');
				return client;
			},

			/**
			 * Never actually called by anything in this app — see `localSignerConnector.js`'s
			 * identical note on why `getClient` is what every write/sign call site reaches
			 * for, and why forwarding a signing method here would be actively wrong rather
			 * than merely redundant.
			 */
			async getProvider() {
				return {
					request: async ({ method, params }) => {
						switch (method) {
							case 'eth_requestAccounts':
							case 'eth_accounts':
								return client?.account ? [client.account.address] : [];
							case 'eth_chainId':
								return `0x${chain.id.toString(16)}`;
							case 'wallet_switchEthereumChain': {
								const requested = parseInt(params[0].chainId, 16);
								if (requested !== chain.id) {
									throw new Error('passkeyConnector: cannot switch chain on this provider shim.');
								}
								return null;
							}
							default:
								throw new Error(
									`passkeyConnector: '${method}' is not served by getProvider — ` +
									'this connector signs only through getClient().'
								);
						}
					},
				};
			},

			onAccountsChanged() {},
			onChainChanged() {},
			onDisconnect() {},
		};
	});
}

/**
 * Turns a MeraError into a message worth showing someone, distinguishing "you cancelled or
 * your authenticator can't do this" from an actual bug — the same split
 * `WalletConnect.vue` already makes for a rejected extension connection (its
 * `UserRejectedRequestError`/code 4001 check), just one level further in since this failure
 * comes from `navigator.credentials` instead of an injected provider.
 *
 * `PASSKEY_OPERATION_FAILED` is Mera's own catch-all — `createPasskeyWithPrfOutput`/
 * `getPasskeyPrfOutput` wrap *any* thrown error into it (see passkey.ts), from the user
 * dismissing the prompt to the browser refusing the call outright for a reason that has
 * nothing to do with the user's choice (insecure origin, no authenticator configured, …).
 * `error.cause` is where the real DOMException actually is; always logged, and folded into
 * the message too, since a blank "cancelled or unavailable" for every one of those cases
 * left both the user and whoever's debugging it with nothing to go on.
 */
function describeError(error) {
	if (isMeraError(error)) {
		console.error('[passkeyConnector]', error.code, error.message, error.cause);
		const causeDetail = error.cause instanceof Error ? ` (${error.cause.name}: ${error.cause.message})` : '';
		if (error.code === 'PRF_UNAVAILABLE') {
			return new Error("This authenticator doesn't support the security feature passkey accounts need here.");
		}
		if (error.code === 'PASSKEY_OPERATION_FAILED') {
			return new Error(`Passkey request cancelled or unavailable.${causeDetail}`);
		}
		if (error.code === 'CRYPTO_UNAVAILABLE') {
			return new Error('This browser is missing a required security feature (Web Crypto).');
		}
	}
	return error;
}
