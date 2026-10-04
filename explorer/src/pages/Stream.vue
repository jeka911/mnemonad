<template>
	<div>
		<!-- /select, not / — the streams list moved there when the landing page became the
		     marketing hero, and this link kept pointing at a page that no longer lists
		     anything. "Streams" rather than "My streams" because that page now shows the
		     sample streams alongside the connected wallet's own. -->
		<router-link to="/select" class="back-link">
			<q-icon name="arrow_back" size="16px" />
			Streams
		</router-link>

		<div class="stream-layout">
			<div class="stream-layout__sidebar">
				<GradientPanel always-expanded dense variant="fill" title="Stream">
					<template #body>
						<div v-if="!mnemonadStore.isDeployed && !switchingNetwork" class="state">
							<p>Mnemonad isn't deployed on {{ activeNetwork.label }}.</p>
							<GradientButton
								v-if="activeNetwork.id !== 'testnet'"
								label="Switch to Testnet"
								size="sm"
								outline
								@click="setActiveNetworkId('testnet')"
							/>
						</div>
						<div v-else-if="switchingNetwork" class="state">
							<q-spinner color="primary" size="28px" />
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
							v-else-if="streamInfo"
							:stream="streamInfo"
							:contract-address="mnemonadStore.contractAddress"
							:chain="activeNetwork.chain"
							:loaded-items="loadedItemsCount"
							:loaded-binary-length="loadedBinaryLength"
						/>
					</template>
				</GradientPanel>
				<DebugPanel
					v-if="streamInfo"
					:stream-id="streamInfo.id"
					:owner="streamInfo.owner"
					:length="streamInfo.length"
					:binary-length="streamInfo.binaryLength"
					@burned="onBurned"
				/>
				<DebugPanel v-else />
			</div>

			<div v-if="streamInfo" class="stream-layout__main">
				<GradientPanel always-expanded dense variant="corner" title="Items">
					<template #actions>
						<span
							v-if="isLocked"
							class="items-panel__strategy items-panel__strategy--locked"
							role="button"
							tabindex="0"
							@click="openUnlock"
							@keyup.enter="openUnlock"
						>
							<q-icon name="lock" size="12px" /> encrypted — click to unlock
						</span>
						<span v-else-if="loadStrategyLabel" class="items-panel__strategy">{{ loadStrategyLabel }}</span>
					</template>
					<template #body>
						<ItemList
							:items="items"
							:loading="itemsLoading"
							:omitted="omitted"
							:load-bytes="loadItemBytes"
							:load-refs="loadItemRefs"
							:is-loaded="isItemLoaded"
							:locked="isLocked"
							:chain="activeNetwork.chain"
							@unlock-requested="openUnlock"
						/>
					</template>
				</GradientPanel>

				<AddPanel :stream="_stream" :unlocked="unlocked" @added="load" @unlock-requested="openUnlock" />
			</div>
		</div>

		<UnlockStreamDialog
			v-model="unlockDialog"
			:stream="_stream"
			purpose="view its items"
			@unlocked="onUnlocked"
		/>
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import { getActiveNetwork, setActiveNetworkId } from '../settings.js';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { parseStreamRouteId, syncStreamRouteNetwork } from '../includes/streamRoute.js';
import GradientPanel from '../components/GradientPanel.vue';
import GradientButton from '../components/GradientButton.vue';
import StreamSummary from '../mnemonad/StreamSummary.vue';
import ItemList from '../mnemonad/ItemList.vue';
import AddPanel from '../mnemonad/explorer/add/AddPanel.vue';
import DebugPanel from '../mnemonad/DebugPanel.vue';
import UnlockStreamDialog from '../mnemonad/UnlockStreamDialog.vue';

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
		GradientPanel, GradientButton, StreamSummary,
		ItemList, AddPanel, DebugPanel, UnlockStreamDialog,
	},
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			streamInfo: null,
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
			error: null,
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
			// Whether UnlockStreamDialog.vue is open — see openUnlock/onUnlocked. Shared
			// across every item card the same way ItemList's own "View" dialog is: only one
			// can be open at a time, and unlocking is stream-wide (one key), not per-item.
			unlockDialog: false,
			// Mirrors whether `this._stream.crypto` actually has a usable key, refreshed at
			// load time (mnemonadStore.loadStream() may hand back an already-unlocked cached
			// instance from earlier this session) and flipped true the moment UnlockStreamDialog
			// emits `unlocked` (see onUnlocked). A plain reactive boolean, not a re-derivation
			// of `_stream.crypto` state on every read: `_stream` itself is deliberately non-reactive (see
			// created() below), so isLocked (and AddPanel's own copy, via its `unlocked`
			// prop) need an actual reactive value to depend on, not a live object it can't
			// see mutate.
			unlocked: false,
		};
	},
	computed: {
		...mapStores(useMnemonadStore),
		loadStrategyLabel: function() {
			const labels = {
				asc: 'loading in order',
				desc: 'loading newest-first',
				random: 'loading shuffled',
				batches: 'loading in batches',
			};
			return this.loadStrategy ? labels[this.loadStrategy] : '';
		},
		// `{networkId, id}` for the `<network>-0x…` param in this page's URL, or null when the
		// param isn't a stream id at all. The network half is acted on in load() — see
		// syncStreamRouteNetwork.
		routeStream: function() {
			return parseStreamRouteId(this.$route.params.id);
		},
		validId: function() {
			return !!this.routeStream;
		},
		streamId: function() {
			return this.routeStream?.id ?? null;
		},
		// True while the URL names a specific network other than the one the app booted on —
		// load() is about to call setActiveNetworkId() (a full reload) to fix that, so
		// `!mnemonadStore.isDeployed` below would otherwise flash the *old* network's verdict
		// for a moment, even when the URL's network is the one that's actually deployed.
		// Available synchronously (routeStream/activeNetwork both are), so it's correct from
		// the very first render — no need to wait for load()'s async body.
		switchingNetwork: function() {
			return !!(this.routeStream?.networkId && this.routeStream.networkId !== this.activeNetwork.id);
		},
		// True when this stream is encrypted and this session doesn't have a usable key for
		// it yet (see `unlocked` in data()) — method-agnostic, because both methods have an
		// unlock affordance now. UnlockStreamDialog.vue decides which credential to ask for.
		//
		// `this.streamInfo.encrypted` and `this.unlocked` are both reactive data (also what
		// makes this computed re-run at all on load/unload/unlock — `this._stream` alone is
		// deliberately non-reactive, see created() below).
		isLocked: function() {
			return !!(this.streamInfo?.encrypted && !this.unlocked);
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
		// Exposed for the template: an Options-API render function can't see module imports.
		setActiveNetworkId,
		// The stream this page was showing no longer exists — nothing left here to stay
		// on. /select, same destination the header's own back link already uses, is where
		// you'd pick a different one.
		onBurned() {
			this.$q.notify({
				type: 'positive',
				message: 'Stream burned.',
				position: 'top',
			});
			this.$router.push('/select');
		},
		async load() {
			if (!this.validId) return;
			// The URL names a network as well as a stream. If it disagrees with the app's,
			// this rewrites or reloads and the page renders again against the corrected URL —
			// nothing to load in this pass. Checked before isDeployed: the network the app
			// happens to be on might have no contract at all, which must not block switching
			// to the one the URL actually asks for.
			if (syncStreamRouteNetwork(this.$route, this.$router, this.routeStream)) return;
			if (!this.mnemonadStore.isDeployed) return;
			this.loading = true;
			this.itemsLoading = true;
			this.error = null;
			try {
				const id = this.streamId;
				// The store owns the live instance now — cached across visits (and across
				// the refresh-after-push this same method triggers via AddPanel's `added`
				// event), so revisiting an already-loaded stream costs no RPC calls at all,
				// and an already-unlocked key (this session's, or from just having created
				// it) survives right along with the instance — see loadStream's own doc.
				const { stream: v, owner } = await this.mnemonadStore.loadStream(id);
				this._stream = v;
				this.unlocked = !!v.crypto.getAesKey();

				this.streamInfo = {
					id: v.id,
					owner,
					length: v.length,
					binaryLength: v.binaryLength,
					encrypted: !!(v.encKeyWrapped && v.encKeyWrapped.length),
					madeWithVersion: v.madeWithVersion,
					firstAvailableIndex: v.firstAvailableIndex,
					maxChunkBytes: v.maxChunkBytes,
					name: v.streamMeta.name,
					// kek deliberately not copied here — nothing reads it off streamInfo
					// anymore. `isLocked` below only needs `encrypted`; which credential to ask
					// for is UnlockStreamDialog.vue's own concern now, reading the live
					// `this._stream.streamMeta.kek` directly off the `stream` prop it's handed,
					// same as AddPanel's own `kek` computed already does off its own `stream` prop.
				};

				// Deliberately not awaited — see loadItems()'s own comment on why it streams
				// items in one at a time instead of loading them all before returning. This
				// means this.items gets its placeholders in the same tick `this.streamInfo` is
				// set, with no gap where the Items panel has mounted but doesn't yet know
				// whether there's anything to show — see `itemsLoading`.
				this.loadItems();
				this.startLoadedPoll();
			} catch (e) {
				this.error = e?.shortMessage || e?.message || 'Failed to load stream';
				this.streamInfo = null;
			} finally {
				this.loading = false;
			}
		},
		async loadItems() {
			if (!this._stream || !this.streamInfo) return;
			const total = this.streamInfo.length;
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
				name: null,
				chunkAddress: null,
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
			if (index < this.streamInfo.firstAvailableIndex) {
				return { index, tier: 'truncated', size: 0, locator: null, hash: null, name: null, chunkAddress: null };
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
				// Already fetched as part of itemAt()'s own refs read — decoding it costs
				// nothing extra. null for anything not pushed with itemMeta (every tab but
				// File) or pushed before this format existed; ItemListItem falls back to a
				// generic label either way.
				name: item.itemMeta.name,
				// The deployed chunk this item's bytes live in — only CODE items have one at
				// all (SLOT is packed into the Item struct's own slot; EXTERNAL lives off
				// -chain), and only this one matters for "does this item share a chunk with
				// its neighbor" (ItemList's connector line): a pushMany batch packs into
				// exactly one chunk per item, never spanning, so `chunks[0]` alone is enough
				// to detect real sharing without also querying a staged item's own extra
				// chunks. `getItemRefs` is a cache hit here — `itemAt()` just above already
				// populated this exact entry; itemAt()/itemsAt() just never carry it forward
				// onto MnemonadItem (see Mnemonad.js's own doc on why).
				chunkAddress: item.storeName === 'code' ? (await this._stream.getItemRefs(index)).chunks[0] ?? null : null,
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
				if (index < this.streamInfo.firstAvailableIndex) {
					rows[index] = { index, tier: 'truncated', size: 0, locator: null, hash: null, name: null, chunkAddress: null };
				} else {
					toFetch.push(index);
				}
			}
			if (toFetch.length) {
				const items = await this._stream.itemsAt(toFetch);
				// Cache hits, same reasoning as loadOneItem's own getItemRefs call — itemsAt()
				// just above already populated every one of these entries; only fetched again
				// here for the chunks[] field it discards (see Mnemonad.js's own doc on why).
				const refs = await this._stream.getItemRefsBatch(toFetch);
				toFetch.forEach((index, k) => {
					const item = items[k];
					const pointer = item.isExternal ? item.pointerData() : null;
					rows[index] = {
						index,
						tier: item.storeName,
						size: item.size,
						locator: pointer?.locator ?? null,
						hash: pointer?.hash ?? null,
						name: item.itemMeta.name,
						chunkAddress: item.storeName === 'code' ? (refs[k].chunks[0] ?? null) : null,
					};
				});
			}
			return rows;
		},
		/**
		 * Fetches one item's plaintext bytes on demand — called by ItemList's view/download
		 * actions, never during the initial list load. Never called while locked (ItemList/
		 * ItemListItem gate every read behind `isLocked`; see the `:locked` prop) — this is
		 * a defensive check, not the primary guard.
		 *
		 * `itemAt(index).bytes()` now decrypts correctly regardless of encryption —
		 * `MnemonadItem.bytes()` delegates to `Mnemonad.at()` internally (see
		 * `MnemonadItem.js`'s own doc) — so this is the one path for every stream, same as
		 * before encryption ever needed special-casing here.
		 * @param {number} index
		 * @returns {Promise<Uint8Array>}
		 */
		async loadItemBytes(index) {
			if (this.isLocked) throw new Error('Stream is locked');
			const item = await this._stream.itemAt(index);
			return await item.bytes();
		},
		/**
		 * Raw on-chain layout for item `index` -- tier, size, its packed offset within a
		 * shared chunk (meaningful for CODE only -- see `getItemRefs`'s own doc), and the
		 * deployed chunk address(es) actually holding its bytes. Deliberately NOT gated
		 * behind `isLocked` the way `loadItemBytes` is: this is public on-chain metadata,
		 * never the item's content, so it's exactly as visible on a locked stream as the
		 * tier/size already shown on every card face -- encryption has nothing to say
		 * about where bytes are stored, only what they say.
		 * @param {number} index
		 * @returns {Promise<{store: number, chunks: string[], offset: number, size: number}>}
		 */
		async loadItemRefs(index) {
			return await this._stream.getItemRefs(index);
		},
		/**
		 * Synchronous, fetch-free cache peek — lets ItemList style an item's size by
		 * whether its payload is already resident in memory. The SDK's own cache
		 * (`Mnemonad.isItemLoaded`) now reflects this correctly for every item regardless
		 * of encryption, so this needs no local tracking of its own.
		 * @param {number} index
		 * @returns {boolean}
		 */
		isItemLoaded(index) {
			return this._stream?.isItemLoaded(index) ?? false;
		},
		/** Opens the shared unlock dialog — triggered by any locked item's click. */
		openUnlock() {
			this.unlockDialog = true;
		},
		onUnlocked() {
			this.unlocked = true;
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
	},
};

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

.items-panel__strategy--locked {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--q-primary);
	cursor: pointer;
}

.items-panel__strategy--locked:hover {
	text-decoration: underline;
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
