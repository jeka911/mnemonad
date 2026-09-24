import { defineStore } from 'pinia';
import { getPublicClient, getWalletClient } from '@wagmi/core';
import { getAddress } from 'viem';
import Mnemonad, { MnemonadUploadGateway, mnemonadAbi, ids as mnemonadIds } from '@mnemonad';
import { config } from '../wagmi';
import { getActiveNetwork } from '../settings.js';
import { useDebugStore } from './debug.js';
import { createPresignProvider } from '../mnemonad/presignProvider.js';

// ids.js keys by contract-key name ('monadTestnet'/'monadMainnet'), settings.js keys by a
// different name ('testnet'/'mainnet') — matching on chainId instead of threading one
// naming convention into the other.
const ACTIVE_CHAIN = getActiveNetwork().chain;
const ENTRY = Object.values(mnemonadIds).find((e) => e.chainId === ACTIVE_CHAIN.id) || null;
const MNEMONAD_ADDRESS = ENTRY ? ENTRY.contractAddress : null;

/**
 * Live Mnemonad instances for the "stream detail" page, keyed by `String(id)` — a plain
 * module-level Map, not Pinia state: an instance holding viem clients (and, once unlocked,
 * an actual decryption key) has no business being wrapped in a Vue reactivity proxy, same
 * reasoning Stream.vue's own `_stream` and AddPanel's own `writable` are kept off their
 * components' `data()` too. Caching it here — rather than pages/Stream.vue building a fresh
 * one on every visit — is what lets navigating back to an already-loaded stream cost zero
 * RPC calls (see `loadStream` below), and lets a password-unlocked key survive that
 * navigation with no separate key-only store needed to bridge the two: the SAME instance,
 * `crypto` included, is just handed back.
 * @type {Map<string, Mnemonad>}
 */
const streamCache = new Map();

// Companion caches to `streamCache`, same module-level lifetime and same reason not to be
// Pinia state (plain values, not reactivity-worthy, and read far more often than written).
// Neither `owner` nor `canWrite` has an invalidation path in this app — there is no transfer
// or setWriterApproval UI here — so both are cached for the life of the session, same as
// `streamCache` itself, and dropped together with it in `clearStreamCache()`.
/** @type {Map<string, string>} streamId -> owner address */
const ownerCache = new Map();
/** @type {Map<string, boolean>} `${streamId}:${address}` -> canWrite */
const canWriteCache = new Map();

// Monad testnet's public RPC 429s under a burst of individual eth_calls, and this app's own
// pattern (hydrate N owned streams, each several reads, all via Promise.all) produces
// exactly that burst on a single page load. Passed to every Mnemonad call site in this file
// and in pages/Stream.vue — the SDK shares one budget across all of them for the same rate
// + chain, so the cap holds across the whole fan-out, not per call site. Not a tuned
// number; raise it if this still 429s, or once the RPC's real limit is known.
export const MAX_RPC_REQUESTS_PER_SECOND = 8;

// More generous than MnemonadRateLimiter's own defaults (4 attempts, ~1.75s total backoff).
// Monad's public testnet RPC can stay rate-limited longer than that under a real burst —
// several streams' worth of concurrent reads all sharing the one 8/sec budget above — and a
// visible "RPC Request failed" toast for what's really just transient congestion is worse
// than waiting a bit longer. Still bounded, not infinite: worst case here is ~24s
// (250+500+1000+2000+4000+8000+8000ms across the 7 backoffs before the 8th/final attempt)
// before a genuinely dead endpoint surfaces as a real failure — a caller stuck retrying
// forever with no way to cancel would be worse than an eventual, honest error.
export const RPC_RETRY = { attempts: 8, maxDelayMs: 8000 };

export const useMnemonadStore = defineStore('mnemonad', {
	state: () => ({
		streams: [],
		// Which owner `streams` currently reflects, or `null` before the first successful
		// fetch — lets fetchOwnedStreams tell "never fetched" apart from "fetched and
		// genuinely empty", and a same-owner refetch (skippable unless `force`) apart from
		// a different-owner one (always fetched — a different owner is always a cache
		// miss on its own, no explicit invalidation needed for an account switch).
		streamsOwner: null,
		loading: false,
		creating: false,
		error: null,
		/**
		 * The paid-upload gateway this registry honours, or null when none is wired.
		 * Registry-level rather than per-stream, which is why it lives here and not on
		 * pages/Stream.vue — and read from the contract rather than configured client-side,
		 * so it can never name a gateway `pushExternal` would ignore.
		 */
		gateway: null,
	}),
	getters: {
		contractAddress: () => MNEMONAD_ADDRESS,
		// Mirrors Home.vue's existing not-deployed pattern: a null address on this
		// network is a real, renderable state, not an error.
		isDeployed: () => !!MNEMONAD_ADDRESS,
	},
	actions: {
		/**
		 * Lists the given owner's streams and hydrates just enough per stream to render a
		 * row (item count, encrypted flag) — cheap for a personal list, which is what this
		 * is; a global "browse all streams" view would need to page instead.
		 *
		 * Cached by owner: a second call for the same owner reuses `this.streams` with no
		 * RPC calls at all, unless `force` is set. The cache has no way to notice a change
		 * from outside this session (a stream created elsewhere, a transfer, a burn) — that
		 * is exactly what `force` is for; `MyStreams.vue`'s own "Refresh" button is that
		 * escape hatch. The `walletStore.connectionId` watcher that calls this on every
		 * connect/account-switch/chain-switch never needs `force` itself, since a different
		 * owner always misses the cache on its own.
		 *
		 * @param {string} owner
		 * @param {Object} [options={}]
		 * @param {boolean} [options.force=false] - bypass the cache and re-fetch regardless
		 * @throws {Error} Only when `force` refetches an owner this already has a good list
		 *   for and the refetch itself fails — deliberately, so a transient failure never
		 *   wipes out perfectly good existing data behind a blocking `error` state; the
		 *   caller decides how to surface that (a toast, typically). A first-ever fetch (or
		 *   one for a different/new owner) failing never throws — it sets `error` instead,
		 *   the existing blocking behavior, since there is no good data to protect.
		 */
		async fetchOwnedStreams(owner, { force = false } = {}) {
			if (!MNEMONAD_ADDRESS || !owner) {
				this.streams = [];
				this.streamsOwner = null;
				return;
			}
			if (!force && this.streamsOwner === owner) return;
			const hadGoodData = this.streamsOwner === owner;
			if (!hadGoodData) this.error = null;
			this.loading = true;
			try {
				const publicClient = getPublicClient(config);
				const ids = await Mnemonad.listOwned(
					publicClient,
					MNEMONAD_ADDRESS,
					owner,
					MAX_RPC_REQUESTS_PER_SECOND,
					RPC_RETRY
				);
				this.streams = await Promise.all(
					ids.map(async (id) => {
						const v = new Mnemonad({
							publicClient,
							contractAddress: MNEMONAD_ADDRESS,
							id,
							maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
							rpcRetry: RPC_RETRY,
							// A Pinia store, not a component — no `this.debugStore`/`mapStores`
							// here, so the debug store is pulled directly (Pinia stores can call
							// other stores this way). Same false/undefined resolution as
							// Stream.vue's `cacheParam`.
							cache: useDebugStore().cachingDisabled ? false : undefined,
							debug: true,
						});
						await v.initialize();
						return {
							id,
							length: v.length,
							encrypted: !!(v.encKeyWrapped && v.encKeyWrapped.length),
						};
					})
				);
				this.streamsOwner = owner;
			} catch (e) {
				const message = e?.shortMessage || e?.message || 'Failed to load streams';
				if (hadGoodData) throw new Error(message);
				this.error = message;
				this.streams = [];
			} finally {
				this.loading = false;
			}
		},
		/**
		 * The live Mnemonad instance for `id`, for the stream detail page — from cache if
		 * this session already loaded it (zero RPC calls, including whatever key it was
		 * unlocked with, since the exact same instance is handed back rather than a fresh
		 * one), built and cached otherwise.
		 *
		 * `initialize()` is always (re-)awaited regardless of cache status: a no-op on a
		 * cache hit unless something `reInitialize()`d it since (a push, most commonly —
		 * see `Mnemonad._afterWrite`), a real fetch on a genuine miss. `owner()` is cached
		 * too (`ownerCache`, keyed by id) — this app has no transfer-ownership UI, so
		 * there's nothing that could make a cached owner stale within a session.
		 *
		 * @param {bigint} id
		 * @returns {Promise<{stream: Mnemonad, owner: string}>}
		 */
		async loadStream(id) {
			const key = String(id);
			let stream = streamCache.get(key);
			if (!stream) {
				stream = new Mnemonad({
					publicClient: getPublicClient(config),
					contractAddress: MNEMONAD_ADDRESS,
					id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
					offloadingProvider: createPresignProvider({}),
					cache: useDebugStore().cachingDisabled ? false : undefined,
					debug: true,
				});
				streamCache.set(key, stream);
			}
			const cachedOwner = ownerCache.get(key);
			// Run together, not sequentially — on a genuine owner-cache miss, owner() doesn't
			// depend on initialize()'s result, and firing both in the same tick lets the
			// transport's JSON-RPC batching (see wagmi.js) fold owner() into the same HTTP
			// request as initialize()'s own reads instead of a separate round trip for it
			// alone. On an owner-cache hit this just awaits the cached value alongside.
			const [, owner] = await Promise.all([
				stream.initialize(),
				cachedOwner !== undefined ? Promise.resolve(cachedOwner) : stream.owner(),
			]);
			if (cachedOwner === undefined) ownerCache.set(key, owner);
			return { stream, owner };
		},
		/**
		 * Unlocks a wallet-encrypted stream by asking the connected account for the one
		 * signature its key-encryption key derives from, adopting the key onto the cached
		 * instance — so it survives navigation exactly like a password unlock does, and is
		 * dropped by the same `clearStreamCache()`.
		 *
		 * Checks ownership *before* prompting. Any wallet can produce a signature and derive
		 * *a* key; only the owner's derives the right one, and everything else fails as an
		 * opaque AES-GCM tag mismatch after the user has already approved a popup. The owner
		 * is exactly the right test here because the contract refuses to transfer an
		 * encrypted stream and only the owner may rewrap it.
		 *
		 * @param {bigint} id
		 * @param {?string} address - the connected account, passed in rather than read from
		 *   the wallet store to keep these two stores from importing each other
		 * @returns {Promise<Uint8Array>} the unwrapped data key
		 */
		async unlockStreamWithWallet(id, address) {
			const key = String(id);
			const stream = streamCache.get(key);
			if (!stream) throw new Error('Open the stream before unlocking it');

			const owner = ownerCache.get(key);
			if (!address) {
				throw new Error('Connect the owner\'s wallet to unlock this stream');
			}
			if (owner && getAddress(owner) !== getAddress(address)) {
				throw new Error(
					`This stream is encrypted to ${owner}. Connect that wallet to unlock it.`
				);
			}

			const walletClient = await getWalletClient(config);
			return await stream.unlockWithSignature(walletClient);
		},
		/**
		 * Whether `address` can write to stream `id` — cached (`canWriteCache`, keyed by
		 * `${id}:${address}`) for the same reason `owner` is: this app has no
		 * setWriterApproval UI, so nothing can make a cached answer stale within a session.
		 * Keying by address (not just id) means an account switch is naturally a cache miss
		 * rather than needing its own explicit invalidation.
		 *
		 * @param {bigint} id
		 * @param {string} address
		 * @returns {Promise<boolean>}
		 */
		async checkCanWrite(id, address) {
			const key = `${id}:${address}`;
			if (canWriteCache.has(key)) return canWriteCache.get(key);
			const stream = streamCache.get(String(id));
			if (!stream) return false; // loadStream() always runs first in practice
			const canWrite = await stream.canWrite(address);
			canWriteCache.set(key, canWrite);
			return canWrite;
		},
		/**
		 * Drops every cached stream instance — and with it, any unwrapped password key one
		 * was holding, plus the companion `ownerCache`/`canWriteCache` entries. Called on
		 * wallet disconnect (see wallet.js), the same "a shared/public machine disconnecting
		 * shouldn't leave decrypted keys resident" reasoning the old streamKeysStore existed
		 * for; caching a stream is only meant to save RPC calls within one connected
		 * session, not to survive past it.
		 */
		clearStreamCache() {
			streamCache.clear();
			ownerCache.clear();
			canWriteCache.clear();
		},
		/**
		 * Discovers the wired gateway and reads its pricing. Safe to call unconditionally:
		 * no gateway, or an oracle the gateway itself won't quote against, both resolve to a
		 * renderable state rather than throwing.
		 */
		async fetchGateway() {
			if (!MNEMONAD_ADDRESS) {
				this.gateway = null;
				return;
			}
			try {
				// Wrapped rather than raw: these reads bypass any Mnemonad instance, so
				// without this they would be the one path in the app that is neither paced
				// against the shared budget nor retried when the endpoint is busy.
				const publicClient = Mnemonad.wrapClient(
					getPublicClient(config),
					MAX_RPC_REQUESTS_PER_SECOND,
					RPC_RETRY
				);
				const address = await publicClient.readContract({
					address: MNEMONAD_ADDRESS,
					abi: mnemonadAbi,
					functionName: 'uploadGateway',
				});
				if (!address || /^0x0+$/i.test(address)) {
					this.gateway = null;
					return;
				}

				const gw = new MnemonadUploadGateway({ publicClient, address });
				const [cfg, rate] = await Promise.all([
					gw.config(),
					// Reverts when the price is stale, non-positive, too uncertain or outside
					// the configured band. That is a real state the UI has to show — "the
					// gateway exists but cannot quote right now" — not an error to swallow.
					gw.weiPerMiB().catch(() => null),
				]);

				this.gateway = {
					address,
					usdCentsPerMiB: Number(cfg.usdCentsPerMiB),
					minChargeWei: cfg.minChargeWei,
					requestTtl: Number(cfg.requestTtl),
					paused: cfg.paused,
					weiPerMiB: rate,
				};
			} catch {
				this.gateway = null;
			}
		},
		/**
		 * @param {Object} [params={}]
		 * @param {string} [params.name] - optional label, stored in stream metadata
		 * @param {?('password'|'wallet')} [params.encryptWith] - how to key the stream, or
		 *   omitted/null to leave it unencrypted. `password` needs `params.password`;
		 *   `wallet` keys it to the connected account's own signature, which means one
		 *   extra wallet prompt before the create transaction and no way for any other
		 *   wallet to ever decrypt it.
		 * @param {string} [params.password] - required by `encryptWith: 'password'`.
		 *   `Mnemonad.create()` itself derives the salt, picks the shipped default iteration
		 *   count, and publishes both (in the clear, alongside `name`) in the stream's own
		 *   metadata, so a later reader only needs the password, never anything out of band.
		 * @param {(step: 'sign'|'tx') => void} [params.onStep] - called as the flow moves
		 *   between wallet prompts, so the dialog can say which one is on screen.
		 * @returns {Promise<Mnemonad>}
		 */
		async createStream(params = {}) {
			if (!MNEMONAD_ADDRESS) throw new Error('Mnemonad is not deployed on this network');
			this.creating = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);

				const method = params.encryptWith || (params.password ? 'password' : null);
				const password = method === 'password' ? params.password : null;
				const onStep = params.onStep || (() => {});

				// Wrapped around the wallet client rather than handed the raw one: the KEK
				// signature and the create transaction are two separate prompts, and without
				// this the second one looks like a bug ("why is it asking again?"). The SDK
				// only needs `signMessage`/`account` here — see MnemonadCrypto._signMessage.
				const signer = method === 'wallet'
					? {
						account: walletClient.account,
						signMessage: (args) => {
							onStep('sign');
							return walletClient.signMessage(args).finally(() => onStep('tx'));
						},
					}
					: undefined;
				if (method !== 'wallet') onStep('tx');

				const stream = await Mnemonad.create({
					publicClient,
					walletClient,
					contractAddress: MNEMONAD_ADDRESS,
					name: params.name || undefined,
					encrypt: !!method,
					password: password || undefined,
					signer,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
					// Same read-only provider loadStream() builds its own instances with —
					// this one becomes that same cached read instance below the moment the
					// creator navigates to it, so it needs to be just as capable of reading
					// an external item back, even though create() itself never routes one.
					offloadingProvider: createPresignProvider({}),
				});

				// Cached immediately — already-unwrapped key included, whichever method keyed
				// it — so if the creator now navigates to it, loadStream() finds this
				// exact instance and costs no RPC calls, no re-prompt for the password they
				// just typed, and no separate key-only store needed to bridge the two. The
				// creator is the owner by construction, so ownerCache is seeded the same way
				// — loadStream() then finds that cached too, no owner() call either.
				streamCache.set(String(stream.id), stream);
				ownerCache.set(String(stream.id), walletClient.account.address);

				// Append locally rather than re-running the whole list — this stream is
				// known-fresh (just minted), no need to re-fetch it.
				this.streams.push({ id: stream.id, length: 0, encrypted: !!method });
				return stream;
			} finally {
				this.creating = false;
			}
		},
		/**
		 * Permanently destroys stream `id` (`contracts/src/Mnemonad.sol`'s own `burn()` —
		 * owner-only, irreversible). A throwaway writable instance rather than reusing
		 * whatever's in `streamCache`: burn touches no crypto/item state at all, so there's
		 * nothing to carry over from an already-unlocked read instance, and building a
		 * fresh one keeps this action independent of whether the caller has ever loaded the
		 * stream in this session.
		 *
		 * @param {bigint|string} id
		 * @returns {Promise<boolean>}
		 */
		async burnStream(id) {
			if (!MNEMONAD_ADDRESS) throw new Error('Mnemonad is not deployed on this network');
			const publicClient = getPublicClient(config);
			const walletClient = await getWalletClient(config);
			const writable = new Mnemonad({
				publicClient,
				walletClient,
				contractAddress: MNEMONAD_ADDRESS,
				id,
			});
			await writable.burn();

			// Every cache entry for this id is now describing a token that no longer
			// exists — dropped rather than left stale, same reasoning clearStreamCache()
			// documents for a wallet disconnect. canWriteCache is keyed `${id}:${address}`
			// (no cheap way to target just this id's entries), so it's cleared in full —
			// harmless, since nothing here queries canWrite at any real frequency.
			const key = String(id);
			streamCache.delete(key);
			ownerCache.delete(key);
			canWriteCache.clear();
			this.streams = this.streams.filter((s) => String(s.id) !== key);
			return true;
		},
	},
});
