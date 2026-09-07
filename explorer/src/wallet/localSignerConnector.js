import { createConnector } from '@wagmi/core';
import { createWalletClient, http, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The connector's `id`/`name`, exported so other components can recognize a local-signer
 * session (e.g. to render a warning badge) without hardcoding a copy of the string that
 * could drift from this file.
 */
export const LOCAL_SIGNER_CONNECTOR_ID = 'local-signer';
export const LOCAL_SIGNER_CONNECTOR_NAME = 'Local Private Key';

/**
 * A wagmi connector backed by a raw private key instead of a browser wallet extension.
 *
 * Exists for two things a real wallet extension makes tedious: exercising the paid-upload
 * path (create → push → pay → offload → settle) without confirming a transaction popup for
 * every step, and driving the explorer as an unattended test/agent account. Real wallet
 * extensions are still the only sane way to hold funds you care about; this is a burner-key
 * convenience, gated behind `VITE_ENABLE_LOCAL_SIGNER` for exactly that reason (see
 * `LocalSignerCard.vue`).
 *
 * The reason this is a *connector* rather than, say, a walletClient swapped in ad hoc: every
 * write in the app goes through `getWalletClient(config)` / `signTypedData(config, ...)`,
 * both of which resolve through wagmi's `getConnectorClient`. That function prefers a
 * connector's own `getClient()` over building a client from `getProvider()` — so returning a
 * real local-account `WalletClient` from `getClient` makes every existing call site work
 * completely unchanged. No SDK code, no store, no other component needs to know the
 * connected account isn't a browser extension.
 *
 * A side effect worth relying on rather than working around: viem signs locally and submits
 * via `eth_sendRawTransaction`, which a public RPC accepts — unlike `eth_sendTransaction`,
 * which `Mnemonad._write` already had to special-case for injected wallets (see that file's
 * comment on `account` dispatch). A raw private key sidesteps that entirely.
 *
 * @param {Object} params
 * @param {string} params.privateKey - 0x-prefixed 32-byte hex. Never persisted by this
 *   module — see `LocalSignerCard.vue` for what "never persisted" covers.
 * @param {number} params.chainId - the only chain this connector will operate on. Not
 *   inferred from `config.chains[0]` inside the factory, so the caller's own guard (testnet
 *   only, see the card) is what actually decided this, not a default this file would invent.
 */
export function localSignerConnector({ privateKey, chainId }) {
	// Constructed once, outside `createConnector`'s inner function, so every method below
	// closes over the same account/client rather than re-deriving it (and so a bad key
	// throws here, at connect time, instead of surfacing later from an arbitrary method).
	const account = privateKeyToAccount(normalizeKey(privateKey));

	return createConnector((config) => {
		const chain = config.chains.find((c) => c.id === chainId);
		if (!chain) {
			// Not reachable through the UI as written (the card only ever offers the app's
			// single active chain), but a connector factory is cheap to make foolproof and
			// expensive to debug blind if this invariant ever drifts.
			throw new Error(`localSignerConnector: chain ${chainId} is not in this app's wagmi config`);
		}

		/** @type {import('viem').WalletClient | null} */
		let client = null;
		function getWalletClientOnce() {
			// Built lazily rather than at factory scope: `createWalletClient` is cheap, but
			// building it before `connect()` has run would mean a client existing for an
			// account the connector hasn't actually reported as connected yet.
			if (!client) {
				client = createWalletClient({ account, chain, transport: http() });
			}
			return client;
		}

		return {
			id: LOCAL_SIGNER_CONNECTOR_ID,
			name: LOCAL_SIGNER_CONNECTOR_NAME,
			type: 'localSigner',

			async connect() {
				return { accounts: [account.address], chainId: chain.id };
			},

			async disconnect() {
				// The private key dies with this closure regardless — dropping every
				// reference to the connector (see the card's disconnect handler) is what
				// actually frees it for GC. This only satisfies the interface and drops our
				// own client, so a stale one can't outlive a disconnect/reconnect cycle.
				client = null;
			},

			async getAccounts() {
				return [account.address];
			},

			async getChainId() {
				return chain.id;
			},

			/**
			 * Always false — this connector is never registered in wagmi's static
			 * `connectors` list (see `WalletConnect.vue`: it's built and connected ad hoc,
			 * only when the card's form is submitted), so there's nothing to reconnect *to*
			 * after a reload even before this runs. Returning false anyway keeps the
			 * connector honest on its own terms, rather than relying on being unreachable.
			 */
			async isAuthorized() {
				return false;
			},

			/**
			 * The one wagmi contract member with no honest implementation: this connector
			 * serves exactly one account on exactly one chain, chosen at connect time by the
			 * card, not switchable afterward. Rather than silently no-op (which would let a
			 * caller believe a switch happened), fail loudly — `wallet.js`'s
			 * `switchToActiveChain` already handles a rejected switch by showing a manual-
			 * switch message, so this degrades exactly like a wallet that refuses the
			 * request, not like a crash.
			 */
			async switchChain({ chainId: requested }) {
				if (requested === chain.id) return chain;
				throw new Error('localSignerConnector: cannot switch chain — reconnect with a different chain instead.');
			},

			/**
			 * The chokepoint that makes every existing write/sign call site work unchanged
			 * — see the file-level comment. `chainId` is accepted (and ignored beyond the
			 * equality check) only to satisfy the shape `getConnectorClient` calls this
			 * with; there is only ever one chain to serve.
			 */
			async getClient({ chainId: requested } = {}) {
				if (requested !== undefined && requested !== chain.id) {
					throw new Error(`localSignerConnector: no client for chain ${requested} (connected to ${chain.id})`);
				}
				return getWalletClientOnce();
			},

			/**
			 * Never actually called by anything in this app — every write and every sign
			 * goes through `getClient` above, which `getConnectorClient` prefers
			 * unconditionally (confirmed against the installed wagmi version: it checks
			 * `connector.getClient` before ever building a client from a provider). This
			 * exists only because the wagmi type contract makes `getProvider` non-optional.
			 *
			 * Deliberately covers only the read-only methods (`eth_accounts`, `eth_chainId`,
			 * a same-chain-only `wallet_switchEthereumChain`) and refuses anything that would
			 * need to sign. The tempting alternative — forwarding `eth_signTypedData_v4` or
			 * `eth_sendTransaction` to this walletClient's own `.request()` — is actively
			 * wrong: that method hits the RPC transport directly, and the public node has no
			 * way to sign with an account it never held the key for. Failing loudly here beats
			 * failing silently against a node that just doesn't have this account.
			 */
			async getProvider() {
				return {
					request: async ({ method, params }) => {
						switch (method) {
							case 'eth_requestAccounts':
							case 'eth_accounts':
								return [account.address];
							case 'eth_chainId':
								return `0x${chain.id.toString(16)}`;
							case 'wallet_switchEthereumChain': {
								const requested = parseInt(params[0].chainId, 16);
								if (requested !== chain.id) {
									throw new Error('localSignerConnector: cannot switch chain on this provider shim.');
								}
								return null;
							}
							default:
								throw new Error(
									`localSignerConnector: '${method}' is not served by getProvider — ` +
									'this connector signs only through getClient().'
								);
						}
					},
				};
			},

			// No underlying wallet ever emits these — there is nothing to listen to, and
			// nothing about this connector's account or chain can change without a fresh
			// connect(). Present only because the interface expects the methods to exist.
			onAccountsChanged() {},
			onChainChanged() {},
			onDisconnect() {},
		};
	});
}

/** Accepts a key with or without the `0x` prefix; rejects anything that isn't 32 bytes of hex. */
function normalizeKey(privateKey) {
	const key = privateKey.trim();
	const prefixed = key.startsWith('0x') ? key : `0x${key}`;
	if (!isHex(prefixed) || prefixed.length !== 66) {
		throw new Error('Private key must be 32 bytes of hex (64 characters), with or without 0x.');
	}
	return prefixed;
}
