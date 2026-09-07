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
				@view="openView"
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
	</div>
</template>

<script>
import { JPanel } from 'themed_varmory';
import ItemListItem from './ItemListItem.vue';
import HexViewer from './HexViewer.vue';

export default {
	name: 'ItemList',
	components: { JPanel, ItemListItem, HexViewer },
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
		// (index: number) => Promise<Uint8Array> — Vector.vue owns the SDK instance, so
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
	},
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
		};
	},
	methods: {
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
</style>
