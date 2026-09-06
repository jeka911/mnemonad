<template>
	<div class="item-card">
		<div class="item-card__head">
			<span class="item-card__index">#{{ item.index }}</span>
			<q-skeleton v-if="item.tier === 'pending'" type="text" width="34px" />
			<span v-else class="item-card__tier" :class="`item-card__tier--${item.tier}`">{{ tierLabel(item.tier) }}</span>
		</div>

		<div class="item-card__body">
			<q-skeleton v-if="item.tier === 'pending'" type="text" width="70%" />
			<span v-else-if="item.tier === 'truncated'" class="item-card__placeholder">(truncated)</span>
			<div v-else-if="item.tier === 'external'" class="item-card__details">
				<span class="item-card__detail" :title="item.locator || ''">{{ item.locator || '(no locator)' }}</span>
				<span v-if="item.hash" class="item-card__detail item-card__detail--muted" :title="item.hash">
					{{ truncateMiddle(item.hash) }}
				</span>
			</div>
			<template v-else>
				<!-- Hidden until requested — clicking the icon fetches just this one item's
				     bytes (see ensurePreview), never eagerly as part of the list load. -->
				<span v-if="preview.status === 'loading'" class="item-card__placeholder item-card__placeholder--icon">
					<q-spinner size="16px" />
				</span>
				<span
					v-else-if="!preview.status || preview.status === 'error'"
					class="item-card__placeholder item-card__placeholder--icon item-card__placeholder--clickable"
					title="Click to preview"
					@click="ensurePreview"
				>
					<q-icon name="visibility_off" size="18px" />
				</span>
				<span v-else-if="preview.type === 'empty'" class="item-card__placeholder">(empty)</span>
				<span v-else class="item-card__preview" :class="`item-card__preview--${preview.type}`">{{ preview.snippet }}</span>
			</template>
		</div>

		<div class="item-card__foot">
			<q-skeleton v-if="item.tier === 'pending'" type="text" width="40px" />
			<span v-else class="item-card__size" :class="{ 'item-card__size--loaded': isItemLoaded() }">
				{{ formatBytes(item.size) }}
			</span>
			<span class="item-card__actions">
				<q-btn
					v-if="canView"
					flat
					dense
					round
					icon="visibility"
					size="sm"
					title="View as text"
					@click="$emit('view', item)"
				/>
				<q-btn
					v-if="canDownload"
					flat
					dense
					round
					icon="download"
					size="sm"
					title="Download"
					:loading="downloading"
					@click="download"
				/>
			</span>
		</div>
	</div>
</template>

<script>
import { formatBytes } from '../includes/formatBytes.js';

/** Tiers with no payload to view/download/preview at all — a skeleton or a fixed
 *  "(truncated)" label is all there is to show either way. */
const NO_CONTENT_TIERS = new Set(['truncated', 'pending']);

/** How much of a text item's decoded content shows up in its card preview. */
const PREVIEW_TEXT_CHARS = 60;
/** How many raw bytes render as hex in a non-text item's card preview. */
const PREVIEW_HEX_BYTES = 16;

export default {
	name: 'ItemListItem',
	props: {
		// { index, tier, size, locator, hash } — see Vector.vue's loadOneItem. Never
		// carries the payload itself; that's fetched on demand via loadBytes below.
		item: {
			type: Object,
			required: true,
		},
		// (index: number) => Promise<Uint8Array> — Vector.vue owns the SDK instance, so
		// fetching this item's payload is delegated up rather than reached for here.
		// Left null on pages that only ever pass tier/size rows without real backing data.
		loadBytes: {
			type: Function,
			default: null,
		},
		// (index: number) => boolean — a synchronous, fetch-free peek at the SDK's own
		// cache (`Mnemonad.isItemLoaded`), never a local flag of ours: both on-chain and
		// external items start "not loaded" and flip true only once something (a preview
		// click, View, or Download) has actually called `.bytes()` on them.
		isLoaded: {
			type: Function,
			default: null,
		},
		// Unused by value — its only job is to change on every parent-driven bytes fetch
		// (see ItemList's "View" dialog) so this component re-renders and re-checks
		// isLoaded(). This card's own preview/download actions don't need it, since setting
		// their own local state already forces a re-render on their own.
		refreshToken: {
			type: Number,
			default: 0,
		},
	},
	emits: ['view'],
	data() {
		return {
			// { status: 'loading'|'ready'|'error', type?, snippet? } — one item per
			// instance now, so this needs no index-keyed map the way the shared list-level
			// state did before the split.
			preview: {},
			downloading: false,
		};
	},
	computed: {
		// canView/canDownload stay computed: they only depend on stable props (tier/size
		// never change for a given item once it's no longer 'pending'), unlike
		// isItemLoaded below.
		// External items show pointer metadata instead (see the template's dedicated
		// branch) — content isn't the point there, the locator/hash is. Pending items
		// have no metadata yet at all — see Vector.vue's loadItems(). No size cap: text
		// and HexViewer both scroll within a bounded popup height regardless of length.
		canView() {
			return this.loadBytes && !NO_CONTENT_TIERS.has(this.item.tier) && this.item.tier !== 'external';
		},
		canDownload() {
			return this.loadBytes && !NO_CONTENT_TIERS.has(this.item.tier);
		},
	},
	methods: {
		formatBytes,
		// Deliberately a method, not a computed: it reads the SDK's own mutable cache
		// (isLoaded), which lives outside Vue's reactivity system entirely (see Vector.vue
		// on why an SDK instance never gets wrapped in a reactive proxy). A computed would
		// cache its first result and never invalidate, since nothing reactive it depends on
		// ever changes — this needs to actually re-run on every render instead, which a
		// plain method called from the template does whenever this component re-renders:
		// on its own preview/download actions (their own local state does that for free),
		// and via `refreshToken` for a View fetch, which happens in the parent instead —
		// read here (even though the value itself is unused) purely so Vue tracks it as a
		// render dependency of this method's caller.
		isItemLoaded() {
			void this.refreshToken;
			return !!this.isLoaded && this.isLoaded(this.item.index);
		},
		// Display-only relabel — `item.tier` itself stays the SDK's raw storeName
		// ('external') everywhere else, since that's what canView/canDownload/ensurePreview
		// actually check against.
		tierLabel(tier) {
			return tier === 'external' ? 'ipfs' : tier;
		},
		truncateMiddle(str, keep = 8) {
			if (!str || str.length <= keep * 2 + 1) return str;
			return `${str.slice(0, keep)}…${str.slice(-keep)}`;
		},
		// Small, best-effort card preview — fetched only when the user clicks the
		// eye-crossed placeholder, never eagerly on mount. Deliberately separate from the
		// `view` event's full popup fetch (handled by the parent), and never offered for
		// `truncated` (no data exists) or `external` (that tier shows pointer metadata
		// instead — locator/hash are the point there, not a content snippet).
		async ensurePreview() {
			if (!this.loadBytes || NO_CONTENT_TIERS.has(this.item.tier) || this.item.tier === 'external') return;
			if (this.preview.status && this.preview.status !== 'error') return; // allow a click to retry after a failure
			this.preview = { status: 'loading' };
			try {
				const bytes = await this.loadBytes(this.item.index);
				this.preview = buildPreview(bytes);
			} catch {
				this.preview = { status: 'error' };
			}
		},
		async download() {
			this.downloading = true;
			try {
				const bytes = await this.loadBytes(this.item.index);
				const blob = new Blob([bytes], { type: 'application/octet-stream' });
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = `item-${this.item.index}.bin`;
				document.body.appendChild(link);
				link.click();
				link.remove();
				URL.revokeObjectURL(url);
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.shortMessage || e?.message || 'Failed to download item',
					position: 'top',
				});
			} finally {
				this.downloading = false;
			}
		},
	},
};

/**
 * @param {Uint8Array} bytes
 * @returns {{status: 'ready', type: 'empty'|'text'|'hex', snippet?: string}}
 */
function buildPreview(bytes) {
	if (!bytes || !bytes.length) return { status: 'ready', type: 'empty' };
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		const snippet = text.length > PREVIEW_TEXT_CHARS ? `${text.slice(0, PREVIEW_TEXT_CHARS)}…` : text;
		return { status: 'ready', type: 'text', snippet };
	} catch {
		const slice = bytes.subarray(0, PREVIEW_HEX_BYTES);
		const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join('');
		const snippet = bytes.length > PREVIEW_HEX_BYTES ? `${hex}…` : hex;
		return { status: 'ready', type: 'hex', snippet };
	}
}
</script>

<style scoped>
.item-card {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px;
	border-radius: 12px;
	background: rgba(140, 120, 200, 0.06);
	border: 1px solid rgba(140, 120, 200, 0.12);
	font-size: 0.9em;
	transition: border-color 0.15s ease, background 0.15s ease;
}

.item-card:hover {
	border-color: rgba(140, 120, 200, 0.28);
	background: rgba(140, 120, 200, 0.1);
}

.item-card__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.item-card__index {
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-mono, monospace);
}

.item-card__tier {
	font-family: var(--font-mono, monospace);
	font-size: 0.8em;
	text-transform: uppercase;
	letter-spacing: 0.03em;
}

.item-card__tier--slot { color: #2fd6c0; }
.item-card__tier--code { color: #6d6cf0; }
.item-card__tier--external { color: #f4587a; }
.item-card__tier--truncated { color: var(--q-text-muted, #8a94a6); }

.item-card__body {
	flex: 1;
	display: flex;
	align-items: center;
	min-height: 40px;
	border-radius: 8px;
	padding: 8px 10px;
	background: rgba(140, 120, 200, 0.05);
}

.item-card__placeholder {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: var(--q-text-muted, #8a94a6);
	font-style: italic;
	font-size: 0.9em;
}

.item-card__placeholder--icon {
	opacity: 0.6;
}

.item-card__placeholder--clickable {
	cursor: pointer;
}

.item-card__placeholder--clickable:hover {
	opacity: 1;
	color: var(--q-text-bright, #ffffff);
}

.item-card__preview {
	width: 100%;
	font-family: var(--font-mono, monospace);
	font-size: 0.85em;
	line-height: 1.35;
	color: var(--q-text-bright, #ffffff);
	overflow-wrap: anywhere;
	white-space: pre-wrap;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;
	overflow: hidden;
}

.item-card__preview--hex {
	color: var(--q-text-muted, #8a94a6);
	letter-spacing: 0.02em;
}

.item-card__details {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
	width: 100%;
}

.item-card__detail {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--font-mono, monospace);
	color: var(--q-text-bright, #ffffff);
	font-size: 0.9em;
}

.item-card__detail--muted {
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.85em;
}

.item-card__foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.item-card__size {
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-mono, monospace);
	font-size: 0.85em;
	transition: color 0.15s ease;
}

/* Payload already resident in memory (see isLoaded prop) — a real, SDK-checked signal,
   not a decorative one: this is what "cheap to reveal/download right now" looks like. */
.item-card__size--loaded {
	color: var(--q-text-bright, #ffffff);
}

.item-card__actions {
	display: flex;
	align-items: center;
	gap: 2px;
}

body.body--light .item-card {
	background: rgba(60, 40, 110, 0.04);
	border-color: rgba(60, 40, 110, 0.1);
}

body.body--light .item-card:hover {
	background: rgba(60, 40, 110, 0.07);
	border-color: rgba(60, 40, 110, 0.2);
}

body.body--light .item-card__body {
	background: rgba(60, 40, 110, 0.035);
}

body.body--light .item-card__detail,
body.body--light .item-card__preview,
body.body--light .item-card__size--loaded {
	color: #2a2440;
}
</style>
