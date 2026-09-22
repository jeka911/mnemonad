<template>
	<router-link :to="href" class="stream-row">
		<span class="stream-row__main">
			<span class="stream-row__title">{{ title || formattedId }}</span>
			<span v-if="title && subtitle" class="stream-row__sub">{{ subtitle }}</span>
		</span>
		<span class="stream-row__meta">
			<!-- Only when a title took its place as the label: a sample is still a real
			     stream, and its id is what you'd hand to `mnemonad pull`. -->
			<span v-if="title" class="stream-row__id">{{ formattedId }}</span>
			<q-icon v-if="encrypted" name="lock" size="14px" class="stream-row__lock" />
			<span v-if="count !== null">{{ count }} {{ countLabel }}</span>
			<q-skeleton v-else-if="loading" type="text" width="48px" />
		</span>
	</router-link>
</template>

<script>
/**
 * One row in a list of streams — shared by "My streams" and "Sample streams" so the two
 * lists can't drift apart visually, and so a change to what a row shows happens once.
 *
 * The id is always rendered: as the row's own label when there's no title (the owned-streams
 * case, where an id is all there is to go on), and beside the item count when a curated name
 * took that place — a sample is still a real stream, and its id is what you'd hand to
 * `mnemonad pull`, so it shouldn't vanish just because there's something friendlier to show.
 */
import { formatStreamId } from '../includes/formatStreamId.js';
import { streamPath } from '../includes/streamRoute.js';

export default {
	name: 'StreamRow',
	props: {
		/** Decimal stream id. String or bigint — never a Number, which can't hold one. */
		id: { type: [String, BigInt], required: true },
		/** Curated label. Omit for the id-only row. */
		title: { type: String, default: '' },
		/** Second line under `title`; falls back to the shortened id. */
		subtitle: { type: String, default: '' },
		/** Appended-item count, or null while unknown (see `loading`). */
		count: { type: Number, default: null },
		/**
		 * What one appended item *means* here: 'version' for a filesystem stream, where
		 * every item is a patch and the count is a version history, or 'item' for a plain
		 * one holding whatever was added to it. Nothing on chain distinguishes the two —
		 * a reader only finds out by trying to decode an item as a patch (see
		 * FileBrowser.vue's own fallback) — so this is the caller's to state, and both of
		 * this app's lists say 'version' because that's what the tooling here produces.
		 */
		unit: { type: String, default: 'item' },
		/** Shows a placeholder where the count will land. */
		loading: { type: Boolean, default: false },
		encrypted: { type: Boolean, default: false },
	},
	computed: {
		// Both lists this row appears in are lists of the network the app is on, which is
		// what streamPath() defaults to — no list has to pass one in.
		href: function() {
			return streamPath(this.id, { files: true });
		},
		countLabel: function() {
			return this.count === 1 ? this.unit : `${this.unit}s`;
		},
		formattedId: function() {
			return formatStreamId(this.id);
		},
	},
};
</script>

<style scoped>
.stream-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 10px 14px;
	border-radius: 8px;
	background: rgba(140, 120, 200, 0.06);
	border: 1px solid rgba(140, 120, 200, 0.12);
	font-family: var(--font-mono, monospace);
	font-size: 0.9em;
	text-decoration: none;
	cursor: pointer;
	transition: background var(--q-transition-fast, 0.15s), border-color var(--q-transition-fast, 0.15s);
}

.stream-row:hover {
	background: rgba(140, 120, 200, 0.12);
	border-color: rgba(140, 120, 200, 0.24);
}

.stream-row__main {
	display: flex;
	flex-direction: column;
	gap: 2px;
	/* Both needed for the ellipsis below to ever trigger: grow into the space the meta
	   column doesn't take, but stay allowed to shrink past the text's intrinsic width. */
	flex: 1 1 auto;
	min-width: 0;
}

.stream-row__title {
	color: var(--q-text-bright, #ffffff);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* One line, clipped — rows in a list read better at a uniform height than they do with
   every description shown in full, and the stream page has room for the whole thing. */
.stream-row__sub {
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.85em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.stream-row__meta {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 0 0 auto;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-body, system-ui, sans-serif);
}

.stream-row__id {
	font-family: var(--font-mono, monospace);
	opacity: 0.75;
}

/* The id is the first thing to go when there isn't room for both it and the count — the
   count is the one that changes, and the stream page shows the id in full anyway. */
@media (max-width: 560px) {
	.stream-row__id {
		display: none;
	}
}

.stream-row__lock {
	opacity: 0.8;
}

body.body--light .stream-row {
	background: rgba(60, 40, 110, 0.04);
	border-color: rgba(60, 40, 110, 0.1);
}

body.body--light .stream-row:hover {
	background: rgba(60, 40, 110, 0.08);
	border-color: rgba(60, 40, 110, 0.2);
}

body.body--light .stream-row__title {
	color: #2a2440;
}
</style>
