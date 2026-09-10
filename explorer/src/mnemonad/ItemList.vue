<template>
	<div class="item-list q-py-md">
		<div v-if="loading" class="item-list__grid">
			<div v-for="i in 3" :key="i" class="item-card item-card--skeleton">
				<q-skeleton type="text" width="30%" />
				<q-skeleton type="rect" height="48px" class="q-mt-sm" />
				<q-skeleton type="text" width="50%" class="q-mt-sm" />
			</div>
		</div>

		<p v-else-if="!items.length" class="item-list__empty">No items yet.</p>

		<div v-else class="item-list__grid">
			<ItemListItem
				v-for="item in items"
				:key="item.index"
				:item="item"
				:load-bytes="loadBytes"
				:is-loaded="isLoaded"
				:refresh-token="loadTick"
				:locked="locked"
				:connects-to-next="connectsToNext(item)"
				@view="openView"
				@unlock="$emit('unlock-requested')"
				@chunks="openChunks"
			/>
		</div>

		<p v-if="omitted > 0" class="item-list__note">
			{{ omitted }} more item{{ omitted === 1 ? '' : 's' }} not shown.
		</p>

		<q-dialog v-model="viewDialog">
			<JPanel accent="header" icon="visibility" iconColor="var(--q-primary)" :title="`Item #${viewIndex}`" style="min-width: 420px; max-width: 640px;">
				<div class="view-content q-pa-md">
					<q-spinner v-if="viewLoading" color="primary" size="28px" />
					<p v-else-if="viewError" class="view-content__error">{{ viewError }}</p>
					<HexViewer v-else-if="viewBytes" :bytes="viewBytes" />
					<pre v-else class="view-content__text">{{ viewText }}</pre>
				</div>

				<template #header-action>
					<q-btn flat round icon="close" size="sm" v-close-popup />
				</template>
			</JPanel>
		</q-dialog>

		<q-dialog v-model="chunksDialog">
			<JPanel
				accent="header"
				icon="storage"
				iconColor="var(--q-primary)"
				:title="`Item #${chunksItem?.index} — chunks`"
				style="min-width: 380px; max-width: 560px;"
			>
				<div v-if="chunksItem" class="chunks-content q-pa-md">
					<div class="chunks-content__row">
						<span class="chunks-content__label">Tier</span>
						<span class="chunks-content__value">{{ tierLabel(chunksItem.tier) }}</span>
					</div>
					<div class="chunks-content__row">
						<span class="chunks-content__label">Size</span>
						<span class="chunks-content__value">{{ formatBytes(chunksItem.size) }}</span>
					</div>

					<!-- EXTERNAL: the locator/hash are already fetched as part of the list row
					     (see Stream.vue's loadOneItem) — no separate read needed, and there's
					     no on-chain chunk to describe: only the Pointer itself lives on-chain. -->
					<template v-if="chunksItem.tier === 'external'">
						<div v-if="chunksItem.hash" class="chunks-content__row chunks-content__row--stacked">
							<span class="chunks-content__label">Pointer hash</span>
							<span class="chunks-content__value chunks-content__value--mono">{{ chunksItem.hash }}</span>
						</div>
						<div v-if="chunksItem.locator" class="chunks-content__row chunks-content__row--stacked">
							<span class="chunks-content__label">Locator</span>
							<span class="chunks-content__value chunks-content__value--mono">{{ chunksItem.locator }}</span>
						</div>
						<p class="chunks-content__note">
							Off-chain — only this pointer lives on-chain; the bytes themselves come
							from IPFS.
						</p>
					</template>

					<template v-else-if="chunksItem.tier === 'slot'">
						<p class="chunks-content__note">
							Packed directly into this item's own storage slot — no separate chunk
							contract was deployed for it.
						</p>
					</template>

					<!-- CODE: the only tier with real chunk addresses to show — fetched fresh
					     via loadRefs (getItemRefs), since the list row never carries them (see
					     Stream.vue's own doc on why itemAt()/itemsAt() discard chunks/offset). -->
					<template v-else-if="chunksItem.tier === 'code'">
						<q-spinner v-if="chunksLoading" color="primary" size="20px" />
						<p v-else-if="chunksError" class="chunks-content__error">{{ chunksError }}</p>
						<template v-else-if="chunksRefs">
							<div class="chunks-content__row">
								<span class="chunks-content__label">Offset</span>
								<span class="chunks-content__value">{{ chunksRefs.offset }} bytes into its chunk</span>
							</div>
							<div class="chunks-content__row chunks-content__row--stacked">
								<span class="chunks-content__label">
									{{ chunksRefs.chunks.length === 1 ? 'Chunk' : `Chunks (${chunksRefs.chunks.length})` }}
								</span>
								<ExplorerLink
									v-for="addr in chunksRefs.chunks"
									:key="addr"
									type="address"
									:value="addr"
									:chain="chain"
									:label="formatAddress(addr)"
								/>
							</div>
							<p v-if="chunksRefs.chunks.length > 1" class="chunks-content__note">
								This item's bytes span {{ chunksRefs.chunks.length }} chunks, staged
								across that many transactions.
							</p>
						</template>
					</template>
				</div>

				<template #header-action>
					<q-btn flat round icon="close" size="sm" v-close-popup />
				</template>
			</JPanel>
		</q-dialog>
	</div>
</template>

<script>
import { JPanel } from 'themed_varmory';
import ItemListItem from './ItemListItem.vue';
import HexViewer from './HexViewer.vue';
import ExplorerLink from './ExplorerLink.vue';
import { formatBytes } from '../includes/formatBytes.js';

export default {
	name: 'ItemList',
	components: { JPanel, ItemListItem, HexViewer, ExplorerLink },
	props: {
		items: {
			type: Array,
			default: () => [],
		},
		loading: {
			type: Boolean,
			default: false,
		},
		// Items beyond the display cap — shown as a count, never silently dropped.
		omitted: {
			type: Number,
			default: 0,
		},
		// (index: number) => Promise<Uint8Array> — Stream.vue owns the SDK instance, so
		// fetching a specific item's payload is delegated up rather than reached for here.
		// Passed straight through to each ItemListItem. Left null on pages that only ever
		// pass tier/size rows without real backing data.
		loadBytes: {
			type: Function,
			default: null,
		},
		// (index: number) => boolean — a synchronous, fetch-free peek at the SDK's own
		// cache (`Mnemonad.isItemLoaded`). Passed straight through to each ItemListItem.
		isLoaded: {
			type: Function,
			default: null,
		},
		// True while this is a password-encrypted stream with no key unlocked yet this
		// session (see Stream.vue's `isLocked`). Passed straight through to each
		// ItemListItem, which blocks every read (preview/view/download) behind it.
		locked: {
			type: Boolean,
			default: false,
		},
		// (index: number) => Promise<{store, chunks, offset, size}> — the "Chunk info"
		// dialog's own fetch (see openChunks below), on a CODE item only; SLOT has no
		// chunk to describe and EXTERNAL's pointer is already on the row (see loadOneItem).
		// Never gated behind `locked` the way loadBytes is: chunk placement is on-chain
		// metadata, not content.
		loadRefs: {
			type: Function,
			default: null,
		},
		// Needed by the Chunk info dialog's ExplorerLink entries, which link each chunk
		// address to this network's block explorer.
		chain: {
			type: Object,
			required: true,
		},
	},
	emits: ['unlock-requested'],
	data() {
		return {
			// The "View as text" popup is shared across all rows (only one can be open at
			// a time), so it stays here rather than in each ItemListItem — a card's view
			// button just emits 'view' and this handles the fetch + dialog.
			viewDialog: false,
			viewIndex: null,
			viewLoading: false,
			viewError: null,
			viewText: null,
			// Set instead of viewText when the fetched bytes aren't valid UTF-8 — rendered
			// via HexViewer rather than giving up with an error (see openView below).
			viewBytes: null,
			// Bumped after this view fetch resolves — its only purpose is to change the
			// `refreshToken` prop below so every ItemListItem re-renders and re-checks
			// isLoaded(). A card's own preview/download actions already force its own
			// re-render via its own local state; View is the one action that fetches a
			// card's bytes from outside that card (this dialog is shared, not per-row), so
			// without this its "loaded" color would never actually update after a View.
			loadTick: 0,
			// The "Chunk info" popup — same one-shared-dialog pattern as View above. Unlike
			// View, most of what it shows (tier, size, and — for external — the pointer)
			// is already sitting on `item` from the list row; only a CODE item's own
			// chunks/offset need an actual fetch (see openChunks/loadRefs).
			chunksDialog: false,
			// The full row object (tier/size/locator/hash), not just an index — SLOT and
			// EXTERNAL render entirely from this, with no fetch at all.
			chunksItem: null,
			chunksLoading: false,
			chunksError: null,
			// {store, chunks, offset, size} from loadRefs — populated only for a CODE item.
			chunksRefs: null,
		};
	},
	methods: {
		formatBytes,
		/**
		 * Whether `item` shares its on-chain chunk with whichever row sits right after it —
		 * the two ever agree only when a batched `pushMany` packed them together (see
		 * Stream.vue's own doc on `chunkAddress`), which always assigns consecutive indices,
		 * so `this.items[item.index + 1]` is genuinely "the next item", not just "the next
		 * DOM position". Renders as a small connecting line between the two cards — see
		 * ItemListItem's own `connectsToNext` prop. A plain method, not a computed: `items`
		 * is mutated in place index-by-index as rows resolve (see Stream.vue's loadItems),
		 * which Vue's reactivity tracks fine either way, but this reads more plainly as "ask
		 * a question about current state" than a cached derivation.
		 * @param {Object} item
		 * @returns {boolean}
		 */
		connectsToNext(item) {
			const next = this.items[item.index + 1];
			return !!(item.chunkAddress && next && next.chunkAddress === item.chunkAddress);
		},
		// Display-only relabel, same mapping ItemListItem's own tierLabel uses — kept as
		// its own copy rather than shared, matching how small a helper this is.
		tierLabel(tier) {
			return tier === 'external' ? 'ipfs' : tier;
		},
		formatAddress(address) {
			return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
		},
		async openView(item) {
			this.viewDialog = true;
			this.viewIndex = item.index;
			this.viewLoading = true;
			this.viewError = null;
			this.viewText = null;
			this.viewBytes = null;
			try {
				const bytes = await this.loadBytes(item.index);
				try {
					this.viewText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
				} catch {
					// Not valid UTF-8 — show it as a hex dump instead of giving up on it.
					this.viewBytes = bytes;
				}
			} catch (e) {
				// The fetch itself failed — there's no bytes at all to fall back to here.
				this.viewError = e?.shortMessage || e?.message || 'Failed to load item';
			} finally {
				this.viewLoading = false;
				this.loadTick++;
			}
		},
		/**
		 * Opens the "Chunk info" popup — tier/size always shown, plus whatever's specific
		 * to this tier. SLOT and EXTERNAL render entirely from `item` itself (no fetch);
		 * only CODE needs an actual `loadRefs` call, since chunk addresses/offset are
		 * never part of the list row (see Stream.vue's own doc on why itemAt()/itemsAt()
		 * discard them).
		 * @param {Object} item
		 */
		async openChunks(item) {
			this.chunksDialog = true;
			this.chunksItem = item;
			this.chunksError = null;
			this.chunksRefs = null;
			if (item.tier !== 'code' || !this.loadRefs) return;
			this.chunksLoading = true;
			try {
				this.chunksRefs = await this.loadRefs(item.index);
			} catch (e) {
				this.chunksError = e?.shortMessage || e?.message || 'Failed to load chunk info';
			} finally {
				this.chunksLoading = false;
			}
		},
	},
};
</script>

<style scoped>
.item-list__grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
	gap: 10px;
	/* Grid's default align-items: stretch forces every card in a row to match its tallest
	   neighbor's height — so one IPFS card with a two-line locator/hash was inflating the
	   plain on-chain cards sharing its row too, not just growing on its own. Each card sizes
	   to its own (now fixed, see ItemListItem's .item-card__body) height instead. */
	align-items: start;
	/* A same-chunk connector line (see ItemListItem's own CSS) is drawn spanning exactly
	   this grid's own `gap`, positioned past the right edge of whichever card draws it —
	   correct when that card isn't the last one in its row. `auto-fill` means whether it
	   is depends on the viewport width, which CSS alone can't ask ahead of time, so this
	   clips the harmless case (nothing to its right at all) rather than let a stray line
	   poke out past the grid into the panel's own padding. */
	overflow: hidden;
}

.item-list__empty {
	color: var(--q-text-muted, #8a94a6);
	text-align: center;
	padding: 16px 0;
}

.item-list__note {
	margin: 10px 0 0;
	font-size: 0.85em;
	color: var(--q-text-muted, #8a94a6);
	text-align: center;
}

/* Skeleton placeholder shares the real card's box shape so the loading state doesn't
   jump around once ItemListItem takes over — kept here since only the loading branch
   above ever renders it, never a real ItemListItem. */
.item-card--skeleton {
	display: flex;
	flex-direction: column;
	gap: 0;
	padding: 12px;
	border-radius: 12px;
	background: rgba(140, 120, 200, 0.06);
	border: 1px solid rgba(140, 120, 200, 0.12);
}

body.body--light .item-card--skeleton {
	background: rgba(60, 40, 110, 0.04);
	border-color: rgba(60, 40, 110, 0.1);
}

.view-content {
	min-width: 0;
}

.view-content__text {
	white-space: pre-wrap;
	word-break: break-word;
	font-family: var(--font-mono, monospace);
	margin: 0;
	max-height: 60vh;
	overflow-y: auto;
}

.view-content__error {
	color: var(--q-text-muted, #8a94a6);
	margin: 0;
}

.chunks-content {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.chunks-content__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 6px 0;
	border-bottom: 1px solid rgba(140, 120, 200, 0.1);
}

/* A chunk address / pointer hash / locator is too long to sit beside its label on one
   line the way .chunks-content__row's plain values do — label on its own line, full
   value (never truncated, unlike the card face's own hover-truncated versions) below. */
.chunks-content__row--stacked {
	flex-direction: column;
	align-items: flex-start;
	gap: 4px;
}

.chunks-content__label {
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.85em;
}

.chunks-content__value {
	color: var(--q-text-bright, #ffffff);
	font-size: 0.9em;
	text-transform: capitalize;
}

.chunks-content__value--mono {
	font-family: var(--font-mono, monospace);
	font-size: 0.8em;
	text-transform: none;
	overflow-wrap: anywhere;
}

.chunks-content__note {
	margin: 8px 0 0;
	font-size: 0.8em;
	color: var(--q-text-muted, #8a94a6);
}

.chunks-content__error {
	color: var(--q-text-muted, #8a94a6);
	margin: 0;
}

body.body--light .chunks-content__row {
	border-bottom-color: rgba(60, 40, 110, 0.1);
}

body.body--light .chunks-content__value {
	color: #2a2440;
}
</style>
