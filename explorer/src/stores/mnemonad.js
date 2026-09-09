import { defineStore } from 'pinia';
import { getPublicClient, getWalletClient } from '@wagmi/core';
import Mnemonad, { MnemonadCrypto, MnemonadUploadGateway, mnemonadAbi, ids as mnemonadIds } from '@mnemonad';
import { config } from '../wagmi';
import { getActiveNetwork } from '../settings.js';
import { useDebugStore } from './debug.js';
import { useStreamKeysStore } from './streamKeys.js';
import { encodeStreamMeta } from '../mnemonad/streamMeta.js';

// ids.js keys by contract-key name ('monadTestnet'/'monadMainnet'), settings.js keys by a
// different name ('testnet'/'mainnet') — matching on chainId instead of threading one
// naming convention into the other.
const ACTIVE_CHAIN = getActiveNetwork().chain;
const ENTRY = Object.values(mnemonadIds).find((e) => e.chainId === ACTIVE_CHAIN.id) || null;
const MNEMONAD_ADDRESS = ENTRY ? ENTRY.contractAddress : null;

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
		 */
		async fetchOwnedStreams(owner) {
			if (!MNEMONAD_ADDRESS || !owner) {
				this.streams = [];
				return;
			}
			this.loading = true;
			this.error = null;
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
			} catch (e) {
				this.error = e?.shortMessage || e?.message || 'Failed to load streams';
				this.streams = [];
			} finally {
				this.loading = false;
			}
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
		 *   password-protected. A fresh salt is generated and stored (in the clear, alongside
		 *   `name`) in the stream's own metadata — see `streamMeta.js` — so a later reader only
		 *   needs the password itself, never anything out of band.
		 * @returns {Promise<Mnemonad>}
		 */
		async createStream(params = {}) {
			if (!MNEMONAD_ADDRESS) throw new Error('Mnemonad is not deployed on this network');
			this.creating = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);

				const password = params.password || null;
				let meta;
				let passwordSalt;
				let passwordIterations;
				if (password) {
					passwordSalt = MnemonadCrypto.generatePasswordSalt();
					passwordIterations = MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS;
					meta = encodeStreamMeta({
						name: params.name || undefined,
						kek: {
							method: 'password',
							salt: MnemonadCrypto.saltToHex(passwordSalt),
							iterations: passwordIterations,
						},
					});
				} else if (params.name) {
					meta = encodeStreamMeta({ name: params.name });
				}

				const stream = await Mnemonad.create({
					publicClient,
					walletClient,
					contractAddress: MNEMONAD_ADDRESS,
					meta,
					encrypt: !!password,
					password: password || undefined,
					passwordSalt,
					passwordIterations,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
				});

				if (password) {
					// Already unwrapped from just having created it — cache it so the creator
					// isn't immediately re-prompted for the password they just typed.
					useStreamKeysStore().setKey(stream.id, stream.crypto.getAesKey());
				}

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
