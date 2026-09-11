import { defineStore } from 'pinia';
import { getPublicClient, getWalletClient } from '@wagmi/core';
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
		 * see `Mnemonad._afterWrite`), a real fetch on a genuine miss. `owner()` always
		 * runs live either way — ownership can genuinely change via transfer, and it's one
		 * cheap read, not worth caching separately just to shave one call off an
		 * already-cached visit.
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
			// Run together, not sequentially — on a cache miss, owner() doesn't depend on
			// initialize()'s result, and firing both in the same tick lets the transport's
			// JSON-RPC batching (see wagmi.js) fold owner() into the same HTTP request as
			// initialize()'s own reads instead of a separate round trip for it alone.
			const [, owner] = await Promise.all([stream.initialize(), stream.owner()]);
			return { stream, owner };
		},
		/**
		 * Drops every cached stream instance — and with it, any unwrapped password key one
		 * was holding. Called on wallet disconnect (see wallet.js), the same "a shared/
		 * public machine disconnecting shouldn't leave decrypted keys resident" reasoning
		 * the old streamKeysStore existed for; caching a stream is only meant to save RPC
		 * calls within one connected session, not to survive past it.
		 */
		clearStreamCache() {
			streamCache.clear();
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
		 * @param {string} [params.password] - if given, the stream is created encrypted,
		 *   password-protected. `Mnemonad.create()` itself derives the salt, picks the
		 *   shipped default iteration count, and publishes both (in the clear, alongside
		 *   `name`) in the stream's own metadata — see `MnemonadCrypto.getPasswordKek`'s own
		 *   doc — so this never has to build that block itself, and a later reader only
		 *   needs the password, never anything out of band.
		 * @returns {Promise<Mnemonad>}
		 */
		async createStream(params = {}) {
			if (!MNEMONAD_ADDRESS) throw new Error('Mnemonad is not deployed on this network');
			this.creating = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);

				const password = params.password || null;
				const stream = await Mnemonad.create({
					publicClient,
					walletClient,
					contractAddress: MNEMONAD_ADDRESS,
					name: params.name || undefined,
					encrypt: !!password,
					password: password || undefined,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
					// Same read-only provider loadStream() builds its own instances with —
					// this one becomes that same cached read instance below the moment the
					// creator navigates to it, so it needs to be just as capable of reading
					// an external item back, even though create() itself never routes one.
					offloadingProvider: createPresignProvider({}),
				});

				// Cached immediately — already-unwrapped key included, if this was a password
				// stream — so if the creator now navigates to it, loadStream() finds this
				// exact instance and costs no RPC calls, no re-prompt for the password they
				// just typed, and no separate key-only store needed to bridge the two.
				streamCache.set(String(stream.id), stream);

				// Append locally rather than re-running the whole list — this stream is
				// known-fresh (just minted), no need to re-fetch it.
				this.streams.push({ id: stream.id, length: 0, encrypted: !!password });
				return stream;
			} finally {
				this.creating = false;
			}
		},
	},
});
