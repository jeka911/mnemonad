<template>
	<div>
		<router-link to="/" class="back-link">
			<q-icon name="arrow_back" size="16px" />
			My streams
		</router-link>

		<div class="stream-layout">
			<div class="stream-layout__sidebar">
				<GradientPanel always-expanded dense variant="fill" title="Stream">
					<template #body>
						<div v-if="!mnemonadStore.isDeployed" class="state">
							<p>Mnemonad isn't deployed on {{ activeNetwork.label }}.</p>
						</div>
						<div v-else-if="!validId" class="state">
							<p>Not a valid stream id.</p>
						</div>
						<div v-else-if="loading" class="state">
							<q-spinner color="primary" size="28px" />
						</div>
						<div v-else-if="error" class="state">
							<p>{{ error }}</p>
							<GradientButton label="Retry" size="sm" @click="load" />
						</div>
						<StreamSummary
							v-else-if="stream"
							:stream="stream"
							:contract-address="mnemonadStore.contractAddress"
							:chain="activeNetwork.chain"
							:loaded-items="loadedItemsCount"
							:loaded-binary-length="loadedBinaryLength"
						/>
					</template>
				</GradientPanel>
				<DebugPanel />
			</div>

			<div v-if="stream" class="stream-layout__main">
				<GradientPanel always-expanded dense variant="corner" title="Items">
					<template #actions>
						<span v-if="loadStrategyLabel" class="items-panel__strategy">{{ loadStrategyLabel }}</span>
					</template>
					<template #body>
						<ItemList
							:items="items"
							:loading="itemsLoading"
							:omitted="omitted"
							:load-bytes="loadItemBytes"
							:is-loaded="isItemLoaded"
						/>
					</template>
				</GradientPanel>

				<JPanel
					icon="add"
					title="Add"
					class="q-mt-md add-panel presentation-dim"
					:class="{ 'presentation-dim--active': debugStore.presentationMode }"
				>
					<template #header>
						<q-tabs
							v-model="addTab"
							dense
							align="left"
							class="add-panel__tabs"
							active-color="primary"
							indicator-color="primary"
						>
							<q-tab name="random" label="Random bytes" />
							<q-tab name="text" label="Text" />
							<q-tab name="offload" label="IPFS" />
						</q-tabs>
					</template>
					<!-- Tabs stay at full brightness (they're harmless to click either way —
					     every form underneath is gated the same way regardless of which one
					     shows); only the form content itself dims, with one overlay message
					     covering all three tabs uniformly. Today only AddTextChunk/OffloadUpload
					     take a `hint` prop of their own, so AddRandomBytes silently showed
					     disabled controls with no explanation at all — this fixes that too. -->
					<div class="add-panel__panel-wrap">
						<!-- Plain v-show, not <q-tab-panels>: that component left both panels
						     rendered with display:block simultaneously in this app (likely the
						     two-Quasar-instances issue already documented in GradientPanel.vue) —
						     confirmed live, not assumed. v-show keeps each form's own state
						     intact when switching tabs, same as q-tab-panels would have. -->
						<div class="add-panel__panel q-pa-md" :class="{ 'add-panel__panel--disabled': !canWrite }">
							<AddRandomBytes
								v-show="addTab === 'random'"
								:disable="!canWrite"
								:loading="pushingRandom"
								:max-bytes="stream.maxChunkBytes"
								@submit="onAddRandomBytes"
							/>
							<AddTextChunk
								v-show="addTab === 'text'"
								:disable="!canWrite"
								:hint="writeHint"
								:loading="pushing"
								:max-bytes="stream.maxChunkBytes"
								:can-offload="presignConfigured"
								:estimate="estimateCost"
								@submit="onAddText"
							/>
							<OffloadUpload
								v-show="addTab === 'offload'"
								:active="addTab === 'offload'"
								:disable="!canWrite || !presignConfigured"
								:hint="offloadHint"
								:loading="offloading"
								:max-chunk-bytes="stream.maxChunkBytes"
								:gateway="mnemonadStore.gateway"
								:quote-for="quoteOffload"
								@submit="onOffloadUpload"
							/>
						</div>
						<!-- Sibling of the dimmed content above, not a descendant — CSS opacity
						     applies to every descendant with no way to opt a child back out, so
						     this has to sit outside `.add-panel__panel` to stay readable. -->
						<div v-if="!canWrite" class="add-panel__overlay">
							<q-icon name="lock" size="20px" class="add-panel__overlay-icon" />
							<p class="add-panel__overlay-title">Connect as the owner to manage this stream</p>
							<p class="add-panel__overlay-hint">{{ writeHint }}</p>
						</div>
					</div>
				</JPanel>
			</div>
		</div>
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import { getPublicClient, getWalletClient } from '@wagmi/core';
import Mnemonad, { MnemonadUploadGateway } from '@mnemonad';
import { config } from '../wagmi';
import { getActiveNetwork } from '../settings.js';
import { useWalletStore } from '../stores/wallet.js';
import { useMnemonadStore, MAX_RPC_REQUESTS_PER_SECOND, RPC_RETRY } from '../stores/mnemonad.js';
import { useDebugStore } from '../stores/debug.js';
import { createPresignProvider, presignConfigured, presignServerUrl } from '../mnemonad/presignProvider.js';
import { JPanel } from 'themed_varmory';
import GradientPanel from '../components/GradientPanel.vue';
import GradientButton from '../components/GradientButton.vue';
import StreamSummary from '../mnemonad/StreamSummary.vue';
import ItemList from '../mnemonad/ItemList.vue';
import AddTextChunk from '../mnemonad/AddTextChunk.vue';
import AddRandomBytes from '../mnemonad/AddRandomBytes.vue';
import OffloadUpload from '../mnemonad/OffloadUpload.vue';
import DebugPanel from '../mnemonad/DebugPanel.vue';

/** Items beyond this are counted, never silently dropped — see ItemList's `omitted`. */
const ITEM_DISPLAY_CAP = 50;
/** Pause between each incrementally-loaded item, or between batches — see loadItems(). */
const ITEM_LOAD_DELAY_MS = 10;
/** Items fetched concurrently per group under the 'batches' load strategy — see loadItems(). */
const ITEM_LOAD_BATCH_SIZE = 6;

const LOAD_STRATEGIES = ['asc', 'desc', 'random', 'batches'];
/** Persists which strategy was used last, so the rotation survives a real browser reload —
 *  not just navigation within the app, which keeps this module's state anyway. */
const LOAD_STRATEGY_STORAGE_KEY = 'mnemonad_load_strategy_index';

/**
 * Picks how this page load reveals its items — cycling through all four strategies in a
 * fixed loop, one step per call, rather than randomly, so a demo visibly rotates through
 * every mode in turn instead of repeating one by chance. Purely cosmetic either way: item
 * *positions* on screen never move (`this.items` stays index-ordered, row #0 always above
 * row #1) — only how fast, and in what order, each placeholder resolves into real data.
 *
 * @returns {'asc'|'desc'|'random'|'batches'}
 */
function pickLoadStrategy() {
	let previous = -1;
	try {
		const stored = parseInt(localStorage.getItem(LOAD_STRATEGY_STORAGE_KEY), 10);
		if (Number.isFinite(stored)) previous = stored;
	} catch {
		// localStorage unavailable — falls through to always starting the loop from 0.
	}
	const index = (previous + 1) % LOAD_STRATEGIES.length;
	try {
		localStorage.setItem(LOAD_STRATEGY_STORAGE_KEY, String(index));
	} catch {
		// Best-effort persistence only — the loop still advances within this session
		// either way, it just won't survive a reload without storage to remember it in.
	}
	return LOAD_STRATEGIES[index];
}

/**
 * Fetch order for the three one-at-a-time strategies. 'batches' isn't built here — it
 * doesn't have a single order, it fetches several indices at once; see loadItems().
 *
 * @param {number} count
 * @param {'asc'|'desc'|'random'} strategy
 * @returns {number[]} indices 0..count-1, in the order they should be fetched
 */
function buildLoadOrder(count, strategy) {
	const indices = Array.from({ length: count }, (_, i) => i);
	if (strategy === 'desc') return indices.reverse();
	if (strategy === 'random') {
		// Fisher-Yates. Order only matters for the visible reveal, never for correctness —
		// each index still lands in its own slot in `this.items` regardless of fetch order.
		for (let i = indices.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[indices[i], indices[j]] = [indices[j], indices[i]];
		}
	}
	return indices; // 'asc', or 'random' after shuffling in place above
}

export default {
	name: 'Stream',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/stream/:id',
	title: 'Stream',
	components: {
		JPanel, GradientPanel, GradientButton, StreamSummary,
		ItemList, AddTextChunk, AddRandomBytes, OffloadUpload, DebugPanel,
	},
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			presignConfigured,
			presignServerUrl,
			stream: null,
			items: [],
			omitted: 0,
			loading: false,
			// Separate from `loading`: that one covers the initial stream fetch, gating the
			// whole sidebar+items column. This one covers the narrower gap right after —
			// stream metadata is in hand (so the column has mounted) but `loadItems()`
			// hasn't populated `this.items` yet. Without it, ItemList briefly sees an empty
			// array and shows "No items yet." for a stream that's still finding out how many
			// items it actually has. True until loadItems() has synchronously built its
			// placeholders (or established there really are none).
			itemsLoading: true,
			pushing: false,
			pushingRandom: false,
			offloading: false,
			// Which of the "Add" panel's two forms is showing — random bytes first, since
			// that's the quicker way to generate test data.
			addTab: 'random',
			error: null,
			canWrite: false,
			// How many of the loaded rows already have their payload resident in memory,
			// and how many bytes that adds up to — see recomputeLoaded(). Both start at 0
			// on every fresh stream load, since a brand new Mnemonad instance's cache is
			// always empty (nothing pre-fetches payloads anymore; see loadOneItem below).
			loadedItemsCount: 0,
			loadedBinaryLength: 0,
			// Which of the four strategies (see pickLoadStrategy) is currently populating
			// `items`. Set when the per-item loop starts, cleared when it ends — so the
			// header label below only shows while that loop is genuinely still running, not
			// for the whole page-load window `itemsLoading` covers.
			loadStrategy: null,
		};
	},
	computed: {
		...mapStores(useWalletStore, useMnemonadStore, useDebugStore),
		// Passed as every Mnemonad's `cache` param below — `false` disables caching outright
		// (see MnemonadChunkCache), `undefined` leaves the SDK's own default (the shared
		// cache) untouched. Never write `!this.debugStore.cachingDisabled` directly as the
		// param value: that would be `true` when caching is enabled, and `true` isn't one of
		// the values `Mnemonad`'s constructor treats specially (see its own doc comment) —
		// only `false`/`null`/an object are.
		cacheParam: function() {
			return this.debugStore.cachingDisabled ? false : undefined;
		},
		loadStrategyLabel: function() {
			const labels = {
				asc: 'loading in order',
				desc: 'loading newest-first',
				random: 'loading shuffled',
				batches: 'loading in batches',
			};
			return this.loadStrategy ? labels[this.loadStrategy] : '';
		},
		validId: function() {
			try {
				BigInt(this.$route.params.id);
				return true;
			} catch {
				return false;
			}
		},
		offloadHint: function() {
			if (!this.presignConfigured) return 'Set VITE_PRESIGN_URL to the sign server to enable IPFS uploads.';
			return this.writeHint;
		},
		writeHint: function() {
			if (!this.walletStore.isConnected) return 'Connect a wallet to add items.';
			if (this.walletStore.wrongNetwork) return `Switch to ${this.activeNetwork.label} to add items.`;
			if (!this.canWrite) return "Only the stream's owner or an approved writer can add items.";
			return '';
		},
	},
	watch: {
		'walletStore.connectionId': function() {
			this.checkCanWrite();
		},
	},
	created() {
		// Kept off `data()` deliberately: a live SDK instance holding viem clients has no
		// business being wrapped in a Vue reactivity proxy (same reasoning as
		// stores/wallet.js keeping its estimator/timer handles outside Pinia state).
		this._stream = null;
		// Timer handle for the "loaded items/size" poll — same reasoning, a plain interval
		// id has no business in reactive state either.
		this._loadedPollTimer = null;
	},
	mounted() {
		this.load();
		// Registry-level, so it does not depend on the stream resolving.
		this.mnemonadStore.fetchGateway();
	},
	beforeUnmount() {
		clearInterval(this._loadedPollTimer);
	},
	methods: {
		async load() {
			if (!this.mnemonadStore.isDeployed || !this.validId) return;
			this.loading = true;
			this.itemsLoading = true;
			this.error = null;
			try {
				const publicClient = getPublicClient(config);
				const id = BigInt(this.$route.params.id);
				const v = new Mnemonad({
					publicClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
					offloadingProvider: createPresignProvider({}),
					cache: this.cacheParam,
					debug: true,
				});
				// Run together, not sequentially — owner() doesn't depend on initialize()'s
				// result, and firing both in the same tick lets the transport's JSON-RPC
				// batching (see wagmi.js) fold owner() into the same HTTP request as
				// initialize()'s own reads instead of a separate round trip for it alone.
				const [, owner] = await Promise.all([v.initialize(), v.owner()]);
				this._stream = v;

				this.stream = {
					id: v.id,
					owner,
					length: v.length,
					binaryLength: v.binaryLength,
					encrypted: !!(v.encKeyWrapped && v.encKeyWrapped.length),
					madeWithVersion: v.madeWithVersion,
					firstAvailableIndex: v.firstAvailableIndex,
					maxChunkBytes: v.maxChunkBytes,
				};

				// Fired before checkCanWrite (an unrelated read — write permission has nothing
				// to do with item listing) and deliberately not awaited — see loadItems()'s
				// own comment on why it streams items in one at a time instead of loading
				// them all before returning. Both together mean this.items gets its
				// placeholders in the same tick `this.stream` is set, with no gap where the
				// Items panel has mounted but doesn't yet know whether there's anything to
				// show — see `itemsLoading`.
				this.loadItems();
				await this.checkCanWrite();
				this.startLoadedPoll();
			} catch (e) {
				this.error = e?.shortMessage || e?.message || 'Failed to load stream';
				this.stream = null;
			} finally {
				this.loading = false;
			}
		},
		async loadItems() {
			if (!this._stream || !this.stream) return;
			const total = this.stream.length;
			const cap = Math.min(total, ITEM_DISPLAY_CAP);
			this.omitted = total - cap;

			// The stream's total item count is already known (`total`, above) the instant
			// initialize() resolves, well before any individual item's tier/size/pointer
			// is — so every slot's final shape can be shown right away as a 'pending'
			// placeholder (see ItemListItem), instead of growing the grid one row at a
			// time or showing an unrelated generic skeleton. Each placeholder is then
			// replaced by its real row in place as loadOneItem resolves.
			this.items = Array.from({ length: cap }, (_, index) => ({
				index,
				tier: 'pending',
				size: 0,
				locator: null,
				hash: null,
			}));
			// Only now do we actually know whether there's anything to show — flips
			// ItemList from its loading skeleton to either real placeholders or a genuine
			// "No items yet." (cap === 0), never the wrong one of those two.
			this.itemsLoading = false;
			if (cap === 0) return; // nothing to fetch, so no strategy to report either

			// Rerolled each load — see pickLoadStrategy. Three strategies fetch one index at
			// a time in a different order (see buildLoadOrder); 'batches' fetches several at
			// once instead, which is the odd one out and handled separately below. Exposed
			// via `loadStrategyLabel` for the header while this loop is running (cleared in
			// `finally` below, win or lose).
			const strategy = pickLoadStrategy();
			this.loadStrategy = strategy;
			try {
				if (strategy === 'batches') {
					// Several items fetched in ONE contract call per group (loadItemsBatch,
					// backed by Mnemonad.itemsAt / getItemRefsBatch), not one call per item.
					// Stronger than merely firing several individual calls within the same
					// tick: that only coalesces at the HTTP transport (see wagmi.js), while a
					// client-side rate limiter still counts each individual call against its
					// own budget regardless — this collapses the whole group to exactly one
					// call at every layer: the limiter, the node, and the wire. A batch
					// resolves as one cluster (one contract call, one response), not a
					// staggered trickle — the trade the other three strategies deliberately
					// don't take (see their comment below).
					for (let start = 0; start < cap; start += ITEM_LOAD_BATCH_SIZE) {
						const batch = [];
						for (let index = start; index < Math.min(start + ITEM_LOAD_BATCH_SIZE, cap); index++) {
							batch.push(index);
						}
						const rows = await this.loadItemsBatch(batch);
						for (const index of batch) this.items[index] = rows[index];
						if (start + ITEM_LOAD_BATCH_SIZE < cap) await sleep(ITEM_LOAD_DELAY_MS);
					}
				} else {
					// Loaded one at a time, with a short pause before starting the next — not a
					// Promise.all. Deliberately trades away the transport's JSON-RPC batching
					// (see wagmi.js) consolidating these into one HTTP request — sequential
					// awaited calls with a real gap between them don't share a batching window —
					// in exchange for a visible, paced reveal instead of a long wait followed by
					// everything appearing at once. ('batches' above takes the opposite trade,
					// explicitly, for speed instead of pacing.)
					const order = buildLoadOrder(cap, strategy);
					for (let i = 0; i < order.length; i++) {
						const index = order[i];
						this.items[index] = await this.loadOneItem(index);
						if (i < order.length - 1) await sleep(ITEM_LOAD_DELAY_MS);
					}
				}
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.shortMessage || e?.message || 'Failed to load some items',
					position: 'top',
				});
			} finally {
				this.loadStrategy = null;
			}
		},
		async loadOneItem(index) {
			if (index < this.stream.firstAvailableIndex) {
				return { index, tier: 'truncated', size: 0, locator: null, hash: null };
			}
			// Tier/size/pointer only — no payload fetch here. Content is hidden by default
			// and loaded on demand (see loadItemBytes below), so listing N items never pulls
			// N payloads just to render a row.
			const item = await this._stream.itemAt(index);
			const pointer = item.isExternal ? item.pointerData() : null;
			return {
				index,
				tier: item.storeName,
				size: item.size,
				locator: pointer?.locator ?? null,
				hash: pointer?.hash ?? null,
			};
		},
		/**
		 * Batched form of `loadOneItem`: every index in `indices`, one contract call via
		 * `Mnemonad.itemsAt` (see loadItems()'s 'batches' branch for why that's a stronger
		 * win than firing the same N calls concurrently). Truncated indices are filtered out
		 * before the call — the same "no fetch needed" case `loadOneItem` also short-circuits
		 * on — so a batch never asks the chain about an index that can't answer.
		 *
		 * @param {number[]} indices
		 * @returns {Promise<Object<number, Object>>} row per index, keyed by index
		 */
		async loadItemsBatch(indices) {
			const rows = {};
			const toFetch = [];
			for (const index of indices) {
				if (index < this.stream.firstAvailableIndex) {
					rows[index] = { index, tier: 'truncated', size: 0, locator: null, hash: null };
				} else {
					toFetch.push(index);
				}
			}
			if (toFetch.length) {
				const items = await this._stream.itemsAt(toFetch);
				toFetch.forEach((index, k) => {
					const item = items[k];
					const pointer = item.isExternal ? item.pointerData() : null;
					rows[index] = {
						index,
						tier: item.storeName,
						size: item.size,
						locator: pointer?.locator ?? null,
						hash: pointer?.hash ?? null,
					};
				});
			}
			return rows;
		},
		/**
		 * Fetches one item's raw bytes on demand — called by ItemList's view/download
		 * actions, never during the initial list load. Both `itemAt` (the metadata) and
		 * `bytes()` (the payload) cache per item, so a repeat call after the first is free.
		 * @param {number} index
		 * @returns {Promise<Uint8Array>}
		 */
		async loadItemBytes(index) {
			const item = await this._stream.itemAt(index);
			return await item.bytes();
		},
		/**
		 * Synchronous, fetch-free cache peek — lets ItemList style an item's size by
		 * whether its payload is already resident in memory, without keeping its own
		 * loaded/not-loaded flag (the SDK already knows this; see `Mnemonad.isItemLoaded`).
		 * @param {number} index
		 * @returns {boolean}
		 */
		isItemLoaded(index) {
			return this._stream?.isItemLoaded(index) ?? false;
		},
		/**
		 * Starts (restarting if one's already running) a light poll recomputing how many
		 * displayed items are loaded — polled rather than pushed, since an item can become
		 * "loaded" from deep inside ItemList/ItemListItem (a preview click, View, or
		 * Download) with no event wired all the way back up to this component; this is the
		 * SDK's own cache, never a flag Stream.vue tracks on its own behalf.
		 */
		startLoadedPoll() {
			clearInterval(this._loadedPollTimer);
			this.recomputeLoaded();
			this._loadedPollTimer = setInterval(() => this.recomputeLoaded(), 750);
		},
		/** How many displayed items already have their payload cached, and how many bytes. */
		recomputeLoaded() {
			let count = 0;
			let bytes = 0;
			for (const item of this.items) {
				if (item.tier === 'truncated') continue;
				if (this.isItemLoaded(item.index)) {
					count++;
					bytes += item.size;
				}
			}
			this.loadedItemsCount = count;
			this.loadedBinaryLength = bytes;
		},
		async checkCanWrite() {
			// Needs the loaded instance (its id, its already-rate-limited publicClient) —
			// load() calls this again once `this._stream` is set, so there is nothing else
			// to do here if it isn't yet.
			if (!this.walletStore.isConnected || !this._stream) {
				this.canWrite = false;
				return;
			}
			try {
				this.canWrite = await this._stream.canWrite(this.walletStore.address);
			} catch {
				this.canWrite = false;
			}
		},
		/**
		 * @param {string} text
		 * @returns {Promise<?import('@mnemonad').CostEstimate>} null if there's nothing
		 *   loaded yet to estimate against — AddTextChunk treats that as "show nothing".
		 */
		async estimateCost(text) {
			if (!this._stream || !this.walletStore.isConnected) return null;
			const estimator = new Mnemonad({
				// Reuses the already-rate-limited client from load() rather than asking the
				// constructor to wrap it a second time.
				publicClient: this._stream.publicClient,
				contractAddress: this.mnemonadStore.contractAddress,
				id: this._stream.id,
				senderAddress: this.walletStore.address,
				// Only its `canWrite` matters here: estimatePushCost uses it to decide
				// whether an oversized item routes off-chain, and never uploads anything.
				offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
				cache: this.cacheParam,
				debug: true,
			});
			return await estimator.estimatePushCost(new TextEncoder().encode(text));
		},
		async onAddText(text) {
			if (!this._stream) return;
			this.pushing = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);
				const writable = new Mnemonad({
					publicClient,
					walletClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id: this._stream.id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
					offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
					cache: this.cacheParam,
					debug: true,
				});
				await writable.push(new TextEncoder().encode(text));
				await this.load();
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.shortMessage || e?.message || 'Failed to add item',
					position: 'top',
				});
			} finally {
				this.pushing = false;
			}
		},
		/**
		 * @param {Object} params
		 * @param {number} params.count
		 * @param {number} params.chunkSize
		 */
		async onAddRandomBytes({ count, chunkSize }) {
			if (!this._stream) return;
			this.pushingRandom = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);
				const writable = new Mnemonad({
					publicClient,
					walletClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id: this._stream.id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
					offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
					cache: this.cacheParam,
					debug: true,
				});
				const chunks = Array.from({ length: count }, () => randomBytes(chunkSize));
				await writable.push(chunks);
				await this.load();
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.shortMessage || e?.message || 'Failed to add random bytes',
					position: 'top',
				});
			} finally {
				this.pushingRandom = false;
			}
		},
		/**
		 * Gateway quote for an off-chain payload of `size` bytes.
		 * @param {number} size
		 * @returns {Promise<?bigint>} null when no gateway is wired; rejects when one is but
		 *   currently refuses to quote (stale/uncertain oracle), which the tab renders.
		 */
		async quoteOffload(size) {
			if (!this._stream) return null;
			const gw = await MnemonadUploadGateway.fromMnemonad(this._stream);
			if (!gw) return null;
			return await gw.quote(size);
		},
		/**
		 * The full paid-upload path: escrow, upload, settle.
		 *
		 * Two transactions by necessity, not by choice — the escrow has to exist on-chain
		 * before the pointer commit can find it. The second one carries no `value`: the
		 * registry sees a matching escrow and waives its EXTERNAL fee.
		 *
		 * @param {{size: number}} param0
		 */
		async onOffloadUpload({ size }) {
			if (!this._stream) return;
			this.offloading = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);
				const writable = new Mnemonad({
					publicClient,
					walletClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id: this._stream.id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					rpcRetry: RPC_RETRY,
					offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
					cache: this.cacheParam,
					debug: true,
				});

				const data = randomBytes(size);
				// Commit to the exact bytes that will be uploaded. Throws on an encrypted
				// stream rather than committing a hash push() could never reproduce.
				const { hash, size: commitSize } = await writable.offloadCommitment(data);

				const gw = await MnemonadUploadGateway.fromMnemonad(writable, { walletClient });
				if (!gw) throw new Error('No upload gateway is wired to this registry.');

				// No explicit value: the SDK re-quotes immediately before sending. Passing a
				// padded amount would avoid a rare price-movement revert, but overpayment is
				// swept into gateway revenue on settlement rather than refunded — so paying
				// the exact quote is the honest default.
				await gw.payForUpload(hash, commitSize);
				await writable.push(data);

				await this.load();
				await this.mnemonadStore.fetchGateway();
				this.$q.notify({
					type: 'positive',
					message: `Uploaded ${size} bytes to IPFS — registry fee waived by prepaid escrow.`,
					position: 'top',
				});
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.shortMessage || e?.message || 'Paid upload failed',
					position: 'top',
				});
			} finally {
				this.offloading = false;
			}
		},
	},
};

/**
 * `crypto.getRandomValues` rejects requests over 65536 bytes (a real Web Crypto spec
 * limit) — chunkSize can run up to the stream's maxChunkBytes, which is often well past
 * that, so this fills in 64 KB slices rather than one call on the whole buffer.
 * @param {number} length
 * @returns {Uint8Array}
 */
function randomBytes(length) {
	const bytes = new Uint8Array(length);
	const MAX_PER_CALL = 65536;
	for (let offset = 0; offset < length; offset += MAX_PER_CALL) {
		crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + MAX_PER_CALL, length)));
	}
	return bytes;
}

/** @param {number} ms */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
</script>

<style scoped>
/* Right-aligned for free: GradientPanel's #actions slot sits in a `justify-content:
   space-between` row alongside the title, so this needs no positioning of its own. */
.items-panel__strategy {
	font-size: 12px;
	color: #d3dcee;
	white-space: nowrap;
}

/* Sits in JPanel's header slot, alongside the "Add" title — see the template. */
.add-panel__tabs {
	margin-left: 8px;
}

/* Positions the overlay below against the dimmed form content, not the page. */
.add-panel__panel-wrap {
	position: relative;
}

/* Dims and disables the form content — tabs stay bright, see the template comment.
   The individual `:disable` props on each form are still there underneath (belt and
   suspenders: this is only a visual/pointer-events treatment, not the actual guard). */
.add-panel__panel--disabled {
	opacity: 0.35;
	pointer-events: none;
}

/* Presentation mode: dims the whole "Add" panel for a recording/demo, without disabling it
   — unlike .add-panel__panel--disabled above, this is purely visual, so it deliberately
   skips pointer-events: none. Same class name (and rule, same opacity) also appears in
   layout/Default.vue for the header/footer — not shared via a global stylesheet since every
   other style in this app stays scoped per-component; small enough to duplicate rather than
   break that convention for. */
.presentation-dim {
	transition: opacity 0.2s ease;
}

.presentation-dim--active {
	opacity: 0.35;
}

.add-panel__overlay {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 16px;
	text-align: center;
	/* Not dimmed — a sibling of `.add-panel__panel--disabled`, not a descendant. */
}

.add-panel__overlay-icon {
	color: var(--q-text-muted, #8a94a6);
	opacity: 0.8;
}

.add-panel__overlay-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--q-text-bright, #ffffff);
}

.add-panel__overlay-hint {
	margin: 0;
	font-size: 12px;
	color: var(--q-text-muted, #8a94a6);
}

body.body--light .add-panel__overlay-title {
	color: #2a2440;
}

.stream-layout {
	display: grid;
	grid-template-columns: minmax(260px, 0.85fr) minmax(0, 2fr);
	align-items: start;
	gap: 16px;
}

.stream-layout__sidebar {
	position: sticky;
	top: 16px;
}

@media (max-width: 900px) {
	.stream-layout {
		grid-template-columns: 1fr;
	}

	.stream-layout__sidebar {
		position: static;
	}
}

.back-link {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	margin-bottom: 12px;
	color: var(--q-text-muted, #8a94a6);
	text-decoration: none;
	font-size: 0.9em;
}

.back-link:hover {
	color: var(--q-text-bright, #ffffff);
}

.state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	padding: 24px 0;
	text-align: center;
	color: var(--q-text-muted, #8a94a6);
}

body.body--light .back-link:hover {
	color: #2a2440;
}
</style>
