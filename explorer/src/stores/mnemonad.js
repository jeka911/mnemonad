import { defineStore } from 'pinia';
import { getPublicClient, getWalletClient } from '@wagmi/core';
import Mnemonad, { MnemonadUploadGateway, mnemonadAbi, ids as mnemonadIds } from '@mnemonad';
import { config } from '../wagmi';
import { getActiveNetwork } from '../settings.js';

// ids.js keys by contract-key name ('monadTestnet'/'monadMainnet'), settings.js keys by a
// different name ('testnet'/'mainnet') — matching on chainId instead of threading one
// naming convention into the other.
const ACTIVE_CHAIN = getActiveNetwork().chain;
const ENTRY = Object.values(mnemonadIds).find((e) => e.chainId === ACTIVE_CHAIN.id) || null;
const MNEMONAD_ADDRESS = ENTRY ? ENTRY.contractAddress : null;

// Monad testnet's public RPC 429s under a burst of individual eth_calls, and this app's own
// pattern (hydrate N owned vectors, each several reads, all via Promise.all) produces
// exactly that burst on a single page load. Passed to every Mnemonad call site in this file
// and in pages/Vector.vue — the SDK shares one budget across all of them for the same rate
// + chain, so the cap holds across the whole fan-out, not per call site. Not a tuned
// number; raise it if this still 429s, or once the RPC's real limit is known.
export const MAX_RPC_REQUESTS_PER_SECOND = 8;

export const useMnemonadStore = defineStore('mnemonad', {
	state: () => ({
		vectors: [],
		loading: false,
		creating: false,
		error: null,
		/**
		 * The paid-upload gateway this registry honours, or null when none is wired.
		 * Registry-level rather than per-vector, which is why it lives here and not on
		 * pages/Vector.vue — and read from the contract rather than configured client-side,
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
		 * Lists the given owner's vectors and hydrates just enough per vector to render a
		 * row (item count, encrypted flag) — cheap for a personal list, which is what this
		 * is; a global "browse all vectors" view would need to page instead.
		 */
		async fetchOwnedVectors(owner) {
			if (!MNEMONAD_ADDRESS || !owner) {
				this.vectors = [];
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
					MAX_RPC_REQUESTS_PER_SECOND
				);
				this.vectors = await Promise.all(
					ids.map(async (id) => {
						const v = new Mnemonad({
							publicClient,
							contractAddress: MNEMONAD_ADDRESS,
							id,
							maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
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
				this.error = e?.shortMessage || e?.message || 'Failed to load vectors';
				this.vectors = [];
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
				const publicClient = getPublicClient(config);
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
		 * @param {string} [params.name] - optional label, stored as UTF-8 vector metadata
		 * @returns {Promise<Mnemonad>}
		 */
		async createVector(params = {}) {
			if (!MNEMONAD_ADDRESS) throw new Error('Mnemonad is not deployed on this network');
			this.creating = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);
				const meta = params.name ? new TextEncoder().encode(params.name) : undefined;
				const vector = await Mnemonad.create({
					publicClient,
					walletClient,
					contractAddress: MNEMONAD_ADDRESS,
					meta,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
				});
				// Append locally rather than re-running the whole list — this vector is
				// known-fresh (just minted), no need to re-fetch it.
				this.vectors.push({ id: vector.id, length: 0, encrypted: false });
				return vector;
			} finally {
				this.creating = false;
			}
		},
	},
});
