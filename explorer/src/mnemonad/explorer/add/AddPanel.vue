<template>
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
				<q-tab name="file" label="File" />
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
			<div class="add-panel__panel q-pa-md" :class="{ 'add-panel__panel--disabled': !canWrite || !hasUsableKey }">
				<AddRandomBytes
					v-show="addTab === 'random'"
					:disable="!canWrite || !hasUsableKey"
					:loading="pushingRandom"
					:max-bytes="stream.maxChunkBytes"
					@submit="onAddRandomBytes"
				/>
				<AddTextChunk
					v-show="addTab === 'text'"
					:disable="!canWrite || !hasUsableKey"
					:hint="writeHint"
					:loading="pushing"
					:max-bytes="stream.maxChunkBytes"
					:can-offload="presignConfigured"
					:estimate="estimateCost"
					@submit="onAddText"
				/>
				<AddFileChunk
					v-show="addTab === 'file'"
					:disable="!canWrite || !hasUsableKey"
					:hint="writeHint"
					:loading="pushingFile"
					:max-bytes="stream.maxChunkBytes"
					:gateway="mnemonadStore.gateway"
					:encrypted="encrypted"
					:estimate="estimateFileCost"
					:progress="fileProgress"
					@submit="onAddFile"
				/>
				<OffloadUpload
					v-show="addTab === 'offload'"
					:active="addTab === 'offload'"
					:disable="!canWrite || !hasUsableKey || !presignConfigured"
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
			<div v-if="!canWrite || !hasUsableKey" class="add-panel__overlay">
				<q-icon name="lock" size="20px" class="add-panel__overlay-icon" />
				<p class="add-panel__overlay-title">
					{{ !hasUsableKey ? 'Unlock this stream to add items' : 'Connect as the owner to manage this stream' }}
				</p>
				<p class="add-panel__overlay-hint">{{ writeHint }}</p>
				<!-- The only unlock trigger before this was an item card's click, so an
				     empty stream (nothing to click) had no way to reach the dialog at
				     all — this button works regardless of item count. The dialog itself
				     is owned by the page (shared with ItemList's own unlock trigger), so
				     this only asks for it via an event rather than opening anything
				     directly. -->
				<GradientButton
					v-if="isLocked"
					:label="kekMethod === 'password' ? 'Unlock' : 'Unlock with wallet'"
					size="sm"
					class="q-mt-sm"
					@click="$emit('unlock-requested')"
				/>
			</div>
		</div>
	</JPanel>
</template>

<script>
import { markRaw } from 'vue';
import { mapStores } from 'pinia';
import { getPublicClient, getWalletClient } from '@wagmi/core';
import Mnemonad from '@mnemonad';
import { methodOf } from '../../kek.js';
import { config } from '../../../wagmi';
import { getActiveNetwork } from '../../../settings.js';
import { useWalletStore } from '../../../stores/wallet.js';
import { useMnemonadStore, MAX_RPC_REQUESTS_PER_SECOND, RPC_RETRY } from '../../../stores/mnemonad.js';
import { useDebugStore } from '../../../stores/debug.js';
import { createPresignProvider, presignConfigured } from '../../presignProvider.js';
import { JPanel } from 'themed_varmory';
import GradientButton from '../../../components/GradientButton.vue';
import AddTextChunk from './AddTextChunk.vue';
import AddRandomBytes from './AddRandomBytes.vue';
import AddFileChunk from './AddFileChunk.vue';
import OffloadUpload from './OffloadUpload.vue';

/**
 * The "Add" panel from the stream page: four tabs (random bytes / text / file / IPFS),
 * each writing to `stream` through the SDK's own `push()` — never encrypting, hashing, or
 * paying a gateway itself; see `onAddText`'s own doc for why that's a deliberate line this
 * component doesn't cross.
 *
 * Deliberately narrow at the boundary: `stream` (the live, already-`initialize()`d SDK
 * instance the page loaded — Stream.vue's own `_stream`) plus `unlocked` (a plain reactive
 * mirror of that instance's key state — see the prop's own doc) are the only props, and
 * every write this panel makes is reported back with a single `added` event rather than
 * this reaching into the page to refresh anything itself. Everything else this needs —
 * wallet/debug state, the registry's wired gateway — comes from the same Pinia stores the
 * page itself uses, not threaded through as further props.
 */

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

export default {
	name: 'AddPanel',
	components: { JPanel, GradientButton, AddTextChunk, AddRandomBytes, AddFileChunk, OffloadUpload },
	props: {
		/** The live, already-initialized SDK instance for this stream (Stream.vue's `_stream`). */
		stream: {
			type: Object,
			required: true,
		},
		// Mirrors whether `stream.crypto` actually has a usable key — Stream.vue's own
		// reactive flag, passed down rather than re-derived here, since `stream` itself is
		// a plain (non-reactive) object: mutating its `crypto` doesn't change the `stream`
		// prop's own reference, so nothing here would otherwise notice a just-completed
		// unlock. See Stream.vue's own `unlocked` in data() for the full reasoning.
		unlocked: {
			type: Boolean,
			default: false,
		},
	},
	emits: [
		'added',
		// The password-unlock dialog is owned by the page (shared with ItemList's own
		// trigger) — this only ever asks for it, never opens anything itself.
		'unlock-requested',
	],
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			presignConfigured,
			pushing: false,
			pushingRandom: false,
			pushingFile: false,
			// { phase, chunkIndex, chunkCount } | null — only ever set while pushingFile is
			// true AND the upload happened to route staged (see AddFileChunk's own routing
			// computed and onAddFile below). null the rest of the time, including for a
			// single-transaction or off-chain file push, which has nothing to report.
			fileProgress: null,
			offloading: false,
			// The writable Mnemonad instance shared by every write path (onAddText/onAddFile/
			// onAddRandomBytes/onOffloadUpload) -- built once, lazily, by getWritable() below,
			// instead of every single push paying for a fresh getWalletClient() round trip
			// plus constructor. markRaw'd on assignment: a live SDK instance holding viem
			// clients has no business being wrapped in a Vue reactivity proxy. Invalidated
			// (see the `stream` watcher and the two below it) whenever something it captured
			// at construction time could have gone stale: a different stream, a different
			// wallet/account, a just-toggled cache setting, or a just-unlocked key.
			writable: null,
			// Which of the four forms is showing — random bytes first, since that's the
			// quicker way to generate test data.
			addTab: 'random',
			canWrite: false,
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
		// `stream.encKeyWrapped` is the raw SDK field; this is the same boolean Stream.vue's
		// own `stream.encrypted` decodes it into, recomputed here rather than threaded
		// through as a second prop.
		encrypted: function() {
			return !!(this.stream.encKeyWrapped && this.stream.encKeyWrapped.length);
		},
		offloadHint: function() {
			if (!this.presignConfigured) return 'Set VITE_PRESIGN_URL to the sign server to enable IPFS uploads.';
			return this.writeHint;
		},
		writeHint: function() {
			if (!this.walletStore.isConnected) return 'Connect a wallet to add items.';
			if (this.walletStore.wrongNetwork) return `Switch to ${this.activeNetwork.label} to add items.`;
			if (!this.canWrite) return "Only the stream's owner or an approved writer can add items.";
			if (!this.hasUsableKey) {
				return this.kekMethod === 'password'
					? 'Unlock this stream (enter its password) before adding items.'
					: "Unlock this stream (sign with the owner's wallet) before adding items.";
			}
			return '';
		},
		// Which credential this stream needs — 'password' or 'signature'. See
		// mnemonad/kek.js for why an encrypted stream with no published `kek` block reads as
		// the signature method rather than as an unknown one.
		kekMethod: function() {
			return this.encrypted ? methodOf(this.stream) : null;
		},
		// True when this stream is encrypted and this session has no usable key for it yet
		// (see the `unlocked` prop). Method-agnostic: both methods have an unlock affordance
		// now, so "locked" no longer means "password-locked".
		isLocked: function() {
			return !!(this.encrypted && !this.unlocked);
		},
		// True when writing right now would produce a PLAINTEXT item despite the stream
		// being marked encrypted -- because this session has no data key for it. Has to gate
		// every write path (onAddText/onAddRandomBytes/onOffloadUpload each push through the
		// same shared writable Mnemonad instance) -- without this they'd silently push
		// unencrypted bytes with no error at all, which is exactly what happened before this
		// existed.
		hasUsableKey: function() {
			return !this.encrypted || this.unlocked;
		},
	},
	watch: {
		// `mnemonadStore.loadStream()` caches and reuses the same instance across a
		// refresh-after-push of the same logical stream (see Stream.vue's own `load()`),
		// so this fires only on an actual navigation to a genuinely different stream — a
		// different `id`, which is exactly the case that invalidates the cached writable
		// and needs `checkCanWrite` to run again. `immediate: true` so the very first mount
		// (this panel never renders before the page has a stream at all — see Stream.vue's
		// own `v-if="stream"`) still populates `canWrite`.
		stream: {
			handler(newStream, oldStream) {
				if (!oldStream || newStream.id !== oldStream.id) this.writable = null;
				this.checkCanWrite();
			},
			immediate: true,
		},
		'walletStore.connectionId': function() {
			this.checkCanWrite();
			// The cached writable embeds this wallet's client and its address (via
			// offloadingProvider's account) — never valid across an account switch or
			// disconnect, so it's dropped rather than kept around holding a stale one.
			// Rebuilt lazily, next time a write path actually needs it.
			this.writable = null;
		},
		'debugStore.cachingDisabled': function() {
			this.writable = null;
		},
	},
	methods: {
		async checkCanWrite() {
			if (!this.walletStore.isConnected || !this.stream) {
				this.canWrite = false;
				return;
			}
			try {
				// mnemonadStore caches this by (id, address) — a remount of this panel (e.g.
				// navigating away and back to the same stream) costs no RPC call on a hit.
				this.canWrite = await this.mnemonadStore.checkCanWrite(this.stream, this.walletStore.address);
			} catch {
				this.canWrite = false;
			}
		},
		/**
		 * The unwrapped data key for this stream, if this session has one — `undefined`
		 * (never `null`) so it's safe to spread straight into a `Mnemonad` constructor's
		 * `aesKey` param, which treats either the same way. Every write path below passes
		 * this so a push to an already-encrypted stream actually encrypts, instead of
		 * silently writing plaintext the way a writable instance with no key at all would
		 * (`crypto.isEnabled` false → `_maybeEncrypt` is a no-op — see MnemonadCrypto.js).
		 * @returns {?Uint8Array}
		 */
		writeAesKey() {
			return this.stream?.crypto?.getAesKey() || undefined;
		},
		/**
		 * The writable Mnemonad instance every write path (onAddText/onAddFile/
		 * onAddRandomBytes/onOffloadUpload) pushes through, and every cost estimate
		 * (estimateCost/estimateFileCost) below estimates through — built once and cached
		 * on `this.writable` (see its own doc in data()), rather than paying for a fresh
		 * getWalletClient() round trip plus constructor on every single push or keystroke.
		 * A real walletClient (not just a `senderAddress`) is no extra cost here since
		 * every caller already needs one for the push itself, and it's what lets
		 * `estimatePushCost` encrypt the same way `push()` would (see that method's own
		 * doc) — this instance's `aesKey` is exactly what makes that correct. Callers still
		 * gate on `hasUsableKey`/`this.stream` themselves before calling this, same as
		 * before — this only dedupes the construction, not the write-permission checks.
		 * @returns {Promise<Mnemonad>}
		 */
		async getWritable() {
			if (this.writable) return this.writable;
			const publicClient = getPublicClient(config);
			const walletClient = await getWalletClient(config);
			const instance = new Mnemonad({
				publicClient,
				walletClient,
				contractAddress: this.mnemonadStore.contractAddress,
				id: this.stream.id,
				maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
				rpcRetry: RPC_RETRY,
				offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
				cache: this.cacheParam,
				debug: true,
				aesKey: this.writeAesKey(),
			});
			// A live SDK instance holding viem clients has no business being wrapped in a Vue
			// reactivity proxy — same reasoning the `stream` prop itself is never made
			// reactive on the page that owns it.
			this.writable = markRaw(instance);
			return this.writable;
		},
		/**
		 * @param {string} text
		 * @returns {Promise<?import('@mnemonad').CostEstimate>} null if there's nothing
		 *   loaded yet to estimate against — AddTextChunk treats that as "show nothing".
		 */
		async estimateCost(text) {
			if (!this.stream || !this.walletStore.isConnected) return null;
			const writable = await this.getWritable();
			return await writable.estimatePushCost(new TextEncoder().encode(text));
		},
		/**
		 * Same as estimateCost, for AddFileChunk — which already has raw bytes in hand and
		 * has no text to encode.
		 * @param {Uint8Array} bytes
		 * @returns {Promise<?import('@mnemonad').CostEstimate>}
		 */
		async estimateFileCost(bytes) {
			if (!this.stream || !this.walletStore.isConnected) return null;
			const writable = await this.getWritable();
			return await writable.estimatePushCost(bytes);
		},
		/**
		 * Deliberately just push() — no manual encrypt/commit/pay orchestration here at
		 * all. push() now handles the whole sequence internally (see its own doc in
		 * Mnemonad.js): encrypting when the stream is encrypted, and — for an item too
		 * big for one transaction — either staging on-chain (`onChain: true`) or
		 * prepaying a wired gateway and uploading off-chain, entirely on its own.
		 */
		async onAddText(text) {
			if (!this.stream || !this.hasUsableKey) return;
			this.pushing = true;
			try {
				const writable = await this.getWritable();
				await writable.push(new TextEncoder().encode(text));
				this.$emit('added');
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
		 * Same reasoning as onAddText — a bare push() with no client-side encryption or
		 * payment orchestration.
		 * @param {Object} params
		 * @param {Uint8Array} params.bytes
		 * @param {string} params.name
		 * @param {string} params.mimeType
		 * @param {boolean} params.onChain - AddFileChunk's own prediction of whether this
		 *   should stage on-chain, forwarded verbatim so the route actually taken can
		 *   never drift from what the UI showed before the click. When false, push()
		 *   decides for itself (on-chain if it fits, off-chain — auto-paying a wired
		 *   gateway — otherwise).
		 */
		async onAddFile({ bytes, name, mimeType, onChain }) {
			if (!this.stream || !this.hasUsableKey) return;
			this.pushingFile = true;
			this.fileProgress = null;
			try {
				const writable = await this.getWritable();
				// name/type, not a pre-encoded itemMeta — push() builds and gzips that itself.
				await writable.push(bytes, {
					name,
					type: mimeType,
					onChain,
					onProgress: (info) => { this.fileProgress = info; },
				});
				this.$emit('added');
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.shortMessage || e?.message || 'Failed to upload file',
					position: 'top',
				});
			} finally {
				this.pushingFile = false;
				this.fileProgress = null;
			}
		},
		/**
		 * @param {Object} params
		 * @param {number} params.count
		 * @param {number} params.chunkSize
		 */
		async onAddRandomBytes({ count, chunkSize }) {
			if (!this.stream || !this.hasUsableKey) return;
			this.pushingRandom = true;
			try {
				const writable = await this.getWritable();
				const chunks = Array.from({ length: count }, () => randomBytes(chunkSize));
				await writable.push(chunks);
				this.$emit('added');
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
		 * Gateway quote for an off-chain payload of `size` bytes. A thin pass-through to
		 * `Mnemonad.quoteOffloadUpload` now that the SDK owns the "find the wired gateway,
		 * ask it to quote" sequence itself (see that method's own doc).
		 * @param {number} size
		 * @returns {Promise<?bigint>} null when no gateway is wired; rejects when one is but
		 *   currently refuses to quote (stale/uncertain oracle), which the tab renders.
		 */
		async quoteOffload(size) {
			if (!this.stream) return null;
			return await this.stream.quoteOffloadUpload(size);
		},
		/**
		 * Generates `size` random bytes and pushes them, exercising the paid off-chain
		 * gateway path specifically (this tab's whole point is a size the caller controls
		 * directly, so it can be sized to force EXTERNAL routing on demand).
		 *
		 * Deliberately just push() — no manual encrypt/commit/pay orchestration here at
		 * all. push() now handles the whole sequence internally (see its own doc in
		 * Mnemonad.js): encrypting when the stream is encrypted, then — since this payload
		 * is always oversized and `onChain` is never passed — prepaying the wired gateway
		 * and uploading off-chain, entirely on its own (`_pushExternalAuto`).
		 *
		 * @param {{size: number}} param0
		 */
		async onOffloadUpload({ size }) {
			if (!this.stream || !this.hasUsableKey) return;
			this.offloading = true;
			this.fileProgress = null;
			try {
				const writable = await this.getWritable();
				const plaintext = randomBytes(size);
				await writable.push(plaintext, {
					onProgress: (info) => { this.fileProgress = info; },
				});

				this.$emit('added');
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
				this.fileProgress = null;
			}
		},
	},
};
</script>

<style scoped>
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
</style>
