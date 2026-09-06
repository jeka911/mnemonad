<template>
	<div>
		<router-link to="/" class="back-link">
			<q-icon name="arrow_back" size="16px" />
			My vectors
		</router-link>

		<div class="vector-layout">
			<div class="vector-layout__sidebar">
				<GradientPanel always-expanded dense variant="fill" title="Vector">
					<template #body>
						<div v-if="!mnemonadStore.isDeployed" class="state">
							<p>Mnemonad isn't deployed on {{ activeNetwork.label }}.</p>
						</div>
						<div v-else-if="!validId" class="state">
							<p>Not a valid vector id.</p>
						</div>
						<div v-else-if="loading" class="state">
							<q-spinner color="primary" size="28px" />
						</div>
						<div v-else-if="error" class="state">
							<p>{{ error }}</p>
							<GradientButton label="Retry" size="sm" @click="load" />
						</div>
						<VectorSummary
							v-else-if="vector"
							:vector="vector"
							:chain="activeNetwork.chain"
							:loaded-items="loadedItemsCount"
							:loaded-binary-length="loadedBinaryLength"
						/>
					</template>
				</GradientPanel>
			</div>

			<div v-if="vector" class="vector-layout__main">
				<GradientPanel always-expanded dense variant="corner" title="Items">
					<template #body>
						<ItemList
							:items="items"
							:omitted="omitted"
							:load-bytes="loadItemBytes"
							:is-loaded="isItemLoaded"
						/>
					</template>
				</GradientPanel>

				<JPanel  icon="add" title="Add" class="q-mt-md add-panel">
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
					<!-- Plain v-show, not <q-tab-panels>: that component left both panels
					     rendered with display:block simultaneously in this app (likely the
					     two-Quasar-instances issue already documented in GradientPanel.vue) —
					     confirmed live, not assumed. v-show keeps each form's own state
					     intact when switching tabs, same as q-tab-panels would have. -->
					<div class="add-panel__panel q-pa-md">
						<AddRandomBytes
							v-show="addTab === 'random'"
							:disable="!canWrite"
							:loading="pushingRandom"
							:max-bytes="vector.maxChunkBytes"
							@submit="onAddRandomBytes"
						/>
						<AddTextChunk
							v-show="addTab === 'text'"
							:disable="!canWrite"
							:hint="writeHint"
							:loading="pushing"
							:max-bytes="vector.maxChunkBytes"
							:can-offload="presignConfigured"
							:estimate="estimateCost"
							@submit="onAddText"
						/>
						<OffloadUpload
							v-show="addTab === 'offload'"
							:disable="!canWrite || !presignConfigured"
							:hint="offloadHint"
							:loading="offloading"
							:max-chunk-bytes="vector.maxChunkBytes"
							:gateway="mnemonadStore.gateway"
							:quote-for="quoteOffload"
							@submit="onOffloadUpload"
						/>
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
import { useMnemonadStore, MAX_RPC_REQUESTS_PER_SECOND } from '../stores/mnemonad.js';
import { createPresignProvider, presignConfigured, presignServerUrl } from '../mnemonad/presignProvider.js';
import { JPanel } from 'themed_varmory';
import GradientPanel from '../components/GradientPanel.vue';
import GradientButton from '../components/GradientButton.vue';
import VectorSummary from '../mnemonad/VectorSummary.vue';
import ItemList from '../mnemonad/ItemList.vue';
import AddTextChunk from '../mnemonad/AddTextChunk.vue';
import AddRandomBytes from '../mnemonad/AddRandomBytes.vue';
import OffloadUpload from '../mnemonad/OffloadUpload.vue';

/** Items beyond this are counted, never silently dropped — see ItemList's `omitted`. */
const ITEM_DISPLAY_CAP = 50;
/** Pause between each incrementally-loaded item — see loadItems(). */
const ITEM_LOAD_DELAY_MS = 100;

export default {
	name: 'Vector',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/vector/:id',
	title: 'Vector',
	components: {
		JPanel, GradientPanel, GradientButton, VectorSummary,
		ItemList, AddTextChunk, AddRandomBytes, OffloadUpload,
	},
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			presignConfigured,
			presignServerUrl,
			vector: null,
			items: [],
			omitted: 0,
			loading: false,
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
			// on every fresh vector load, since a brand new Mnemonad instance's cache is
			// always empty (nothing pre-fetches payloads anymore; see loadOneItem below).
			loadedItemsCount: 0,
			loadedBinaryLength: 0,
		};
	},
	computed: {
		...mapStores(useWalletStore, useMnemonadStore),
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
			if (!this.canWrite) return "Only the vector's owner or an approved writer can add items.";
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
		this._vector = null;
		// Timer handle for the "loaded items/size" poll — same reasoning, a plain interval
		// id has no business in reactive state either.
		this._loadedPollTimer = null;
	},
	mounted() {
		this.load();
		// Registry-level, so it does not depend on the vector resolving.
		this.mnemonadStore.fetchGateway();
	},
	beforeUnmount() {
		clearInterval(this._loadedPollTimer);
	},
	methods: {
		async load() {
			if (!this.mnemonadStore.isDeployed || !this.validId) return;
			this.loading = true;
			this.error = null;
			try {
				const publicClient = getPublicClient(config);
				const id = BigInt(this.$route.params.id);
				const v = new Mnemonad({
					publicClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					offloadingProvider: createPresignProvider({}),
				});
				// Run together, not sequentially — owner() doesn't depend on initialize()'s
				// result, and firing both in the same tick lets the transport's JSON-RPC
				// batching (see wagmi.js) fold owner() into the same HTTP request as
				// initialize()'s own reads instead of a separate round trip for it alone.
				const [, owner] = await Promise.all([v.initialize(), v.owner()]);
				this._vector = v;

				this.vector = {
					id: v.id,
					owner,
					length: v.length,
					binaryLength: v.binaryLength,
					encrypted: !!(v.encKeyWrapped && v.encKeyWrapped.length),
					madeWithVersion: v.madeWithVersion,
					firstAvailableIndex: v.firstAvailableIndex,
					maxChunkBytes: v.maxChunkBytes,
				};

				await this.checkCanWrite();
				// Deliberately not awaited — see loadItems()'s own comment on why it streams
				// items in one at a time instead of loading them all before returning. The
				// sidebar (vector metadata, already in hand above) shouldn't have to wait for
				// every single item just to appear.
				this.loadItems();
				this.startLoadedPoll();
			} catch (e) {
				this.error = e?.shortMessage || e?.message || 'Failed to load vector';
				this.vector = null;
			} finally {
				this.loading = false;
			}
		},
		async loadItems() {
			if (!this._vector || !this.vector) return;
			const total = this.vector.length;
			const cap = Math.min(total, ITEM_DISPLAY_CAP);
			this.omitted = total - cap;

			// The vector's total item count is already known (`total`, above) the instant
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
			try {
				// Loaded one at a time, with a short pause before starting the next — not a
				// Promise.all. Deliberately trades away the transport's JSON-RPC batching
				// (see wagmi.js) consolidating these into one HTTP request — sequential
				// awaited calls with a real gap between them don't share a batching window —
				// in exchange for a visible, paced reveal instead of a long wait followed by
				// everything appearing at once.
				for (let index = 0; index < cap; index++) {
					this.items[index] = await this.loadOneItem(index);
					if (index < cap - 1) await sleep(ITEM_LOAD_DELAY_MS);
				}
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.shortMessage || e?.message || 'Failed to load some items',
					position: 'top',
				});
			}
		},
		async loadOneItem(index) {
			if (index < this.vector.firstAvailableIndex) {
				return { index, tier: 'truncated', size: 0, locator: null, hash: null };
			}
			// Tier/size/pointer only — no payload fetch here. Content is hidden by default
			// and loaded on demand (see loadItemBytes below), so listing N items never pulls
			// N payloads just to render a row.
			const item = await this._vector.itemAt(index);
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
		 * Fetches one item's raw bytes on demand — called by ItemList's view/download
		 * actions, never during the initial list load. Both `itemAt` (the metadata) and
		 * `bytes()` (the payload) cache per item, so a repeat call after the first is free.
		 * @param {number} index
		 * @returns {Promise<Uint8Array>}
		 */
		async loadItemBytes(index) {
			const item = await this._vector.itemAt(index);
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
			return this._vector?.isItemLoaded(index) ?? false;
		},
		/**
		 * Starts (restarting if one's already running) a light poll recomputing how many
		 * displayed items are loaded — polled rather than pushed, since an item can become
		 * "loaded" from deep inside ItemList/ItemListItem (a preview click, View, or
		 * Download) with no event wired all the way back up to this component; this is the
		 * SDK's own cache, never a flag Vector.vue tracks on its own behalf.
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
			// load() calls this again once `this._vector` is set, so there is nothing else
			// to do here if it isn't yet.
			if (!this.walletStore.isConnected || !this._vector) {
				this.canWrite = false;
				return;
			}
			try {
				this.canWrite = await this._vector.canWrite(this.walletStore.address);
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
			if (!this._vector || !this.walletStore.isConnected) return null;
			const estimator = new Mnemonad({
				// Reuses the already-rate-limited client from load() rather than asking the
				// constructor to wrap it a second time.
				publicClient: this._vector.publicClient,
				contractAddress: this.mnemonadStore.contractAddress,
				id: this._vector.id,
				senderAddress: this.walletStore.address,
				// Only its `canWrite` matters here: estimatePushCost uses it to decide
				// whether an oversized item routes off-chain, and never uploads anything.
				offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
			});
			return await estimator.estimatePushCost(new TextEncoder().encode(text));
		},
		async onAddText(text) {
			if (!this._vector) return;
			this.pushing = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);
				const writable = new Mnemonad({
					publicClient,
					walletClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id: this._vector.id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
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
			if (!this._vector) return;
			this.pushingRandom = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);
				const writable = new Mnemonad({
					publicClient,
					walletClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id: this._vector.id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
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
			if (!this._vector) return null;
			const gw = await MnemonadUploadGateway.fromMnemonad(this._vector);
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
			if (!this._vector) return;
			this.offloading = true;
			try {
				const publicClient = getPublicClient(config);
				const walletClient = await getWalletClient(config);
				const writable = new Mnemonad({
					publicClient,
					walletClient,
					contractAddress: this.mnemonadStore.contractAddress,
					id: this._vector.id,
					maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
					offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
				});

				const data = randomBytes(size);
				// Commit to the exact bytes that will be uploaded. Throws on an encrypted
				// vector rather than committing a hash push() could never reproduce.
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
 * limit) — chunkSize can run up to the vector's maxChunkBytes, which is often well past
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
/* Sits in JPanel's header slot, alongside the "Add" title — see the template. */
.add-panel__tabs {
	margin-left: 8px;
}

.vector-layout {
	display: grid;
	grid-template-columns: minmax(260px, 0.85fr) minmax(0, 2fr);
	align-items: start;
	gap: 16px;
}

.vector-layout__sidebar {
	position: sticky;
	top: 16px;
}

@media (max-width: 900px) {
	.vector-layout {
		grid-template-columns: 1fr;
	}

	.vector-layout__sidebar {
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
