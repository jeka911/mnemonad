<template>
	<!-- `.stop` on both: this sits inside the panel header, which owns click/key handlers of
	     its own (see FileBrowser.vue's panel-head). -->
	<div
		v-if="hasIndex"
		class="stream-search"
		:class="{ 'stream-search--active': menuOpen, 'stream-search--compact': compact }"
		@click.stop
		@keydown.stop
	>
		<!-- Phone width: the header has no room for a field next to its buttons (it pushed the
		     stream id out entirely at 375px), so it becomes one more icon button like its
		     neighbours, and the field moves into the dropdown. -->
		<GradientButton
			v-if="compact"
			icon="search"
			size="sm"
			round
			aria-label="Search files"
			title="Search files"
			@click="openCompact"
		/>
		<q-input
			v-else
			v-model="query"
			class="stream-search__input"
			dense
			outlined
			placeholder="Search files"
			aria-label="Search this stream's files by meaning"
			@focus="onFocus"
			@keyup.enter="runNow"
			@keydown.esc="menuOpen = false"
		>
			<template #prepend>
				<q-icon name="search" size="16px" />
			</template>
			<template v-if="query" #append>
				<q-icon name="close" size="14px" class="cursor-pointer" aria-label="Clear search" @click="clear" />
			</template>
		</q-input>

		<!-- A dropdown under the field; at phone width a sheet across the top instead — a
		     dropdown anchored to the icon button hangs off the left edge of a 375px screen
		     (seen live), and Quasar only flips a menu, it doesn't slide it back into view. -->
		<component :is="compact ? QDialog : QMenu" v-model="menuOpen" v-bind="overlayProps">
			<div class="stream-search__panel" :class="{ 'stream-search__panel--sheet': compact }">
				<div v-if="compact" class="stream-search__menu-field">
					<q-input
						ref="compactInput"
						v-model="query"
						class="stream-search__input"
						dense
						outlined
						placeholder="Search files"
						aria-label="Search this stream's files by meaning"
						@keyup.enter="runNow"
						@keydown.esc="menuOpen = false"
					>
						<template #prepend>
							<q-icon name="search" size="16px" />
						</template>
						<template v-if="query" #append>
							<q-icon name="close" size="14px" class="cursor-pointer" aria-label="Clear search" @click="clear" />
						</template>
					</q-input>
				</div>
				<div v-if="phase === 'loading-model'" class="stream-search__state">
					<!-- At 100% the weights are in, but the ONNX runtime still has to fetch and start
					     its own WASM — a few seconds that would otherwise read as a stuck download. -->
					<div v-if="progressPct === 100">Starting the search model…</div>
					<div v-else>Downloading the search model…<template v-if="progressPct !== null"> {{ progressPct }}%<template v-if="progressMb"> of {{ progressMb }} MB</template></template></div>
					<q-linear-progress
						:value="progressPct === null ? 0 : progressPct / 100"
						:indeterminate="progressPct === null"
						color="primary"
						rounded
						size="4px"
					/>
					<div class="stream-search__hint">One time only — your browser keeps it cached.</div>
				</div>
				<div v-else-if="phase === 'searching'" class="stream-search__state stream-search__state--row">
					<q-spinner color="primary" size="16px" />
					<span>Searching…</span>
				</div>
				<div v-else-if="error" class="stream-search__state stream-search__state--error">
					{{ error }}
				</div>
				<div v-else-if="phase === 'done' && hits.length === 0" class="stream-search__state">
					No matches.
				</div>

				<q-list v-if="phase === 'done' && hits.length" dense class="stream-search__list">
					<q-item
						v-for="hit in hits"
						:key="hit.path + '#' + hit.chunkIndex"
						clickable
						class="stream-search__hit"
						@click="reveal(hit)"
					>
						<q-item-section class="stream-search__hit-body">
							<div class="stream-search__hit-head">
								<span class="stream-search__path" :title="hit.path">{{ hit.path }}</span>
								<span class="stream-search__score" title="Cosine similarity to your query">{{ hit.score }}%</span>
							</div>
							<div v-if="hit.snippet" class="stream-search__snippet">{{ hit.snippet }}</div>
							<div v-if="hit.stale" class="stream-search__stale">
								Changed since it was indexed — this passage may have moved.
							</div>
						</q-item-section>
					</q-item>
				</q-list>

				<div class="stream-search__foot">
					Searched on this device from the stream's own index — your query never leaves the browser.
				</div>
			</div>
		</component>
	</div>
</template>

<script>
import { QDialog, QMenu } from 'quasar';
import GradientButton from '../components/GradientButton.vue';
import FolderSearch, { folderHasIndex } from './search/folderSearch.js';

// Matches FileBrowser.vue's own narrowest header breakpoint.
const COMPACT_QUERY = '(max-width: 480px)';

const MAX_HITS = 8;
const DEBOUNCE_MS = 400;
const MIN_QUERY_CHARS = 2;

/**
 * Semantic search over a stream's own `search_index.db` — the one `mnemonad index` builds and
 * a push carries along with the folder. Renders nothing at all for a stream without one.
 *
 * Everything runs locally: the index is already in memory (it's just another file in the
 * folder this page restored), and the query is embedded in a worker by the same model the
 * index was built with (see cli/lib/search/browser/BrowserSearcher.js). The only network traffic is
 * the model's one-time download.
 */
export default {
	name: 'StreamSearchBox',
	components: { GradientButton },
	props: {
		// The file browser's current root folder (FileManagerBrowserSync's `@folder` event).
		// Expected un-proxied (the parent keeps it in a shallowRef) — nothing here needs the
		// tree itself to be reactive.
		folder: {
			type: Object,
			default: null,
		},
	},
	emits: ['reveal'],
	setup() {
		// Exposed for `<component :is>` — the auto-import only sees components named in markup.
		return { QDialog, QMenu };
	},
	data() {
		return {
			hasIndex: false,
			query: '',
			menuOpen: false,
			// idle | loading-model | searching | done | error
			phase: 'idle',
			error: null,
			hits: [],
			progressPct: null,
			progressMb: null,
			compact: false,
		};
	},
	created() {
		this._search = null;
		this._seq = 0;
		this._debounce = null;
		this._unsubFolder = null;
	},
	computed: {
		overlayProps() {
			if (this.compact) return { position: 'top' };
			return {
				noParentEvent: true,
				noFocus: true,
				noRefocus: true,
				anchor: 'bottom right',
				self: 'top right',
				offset: [0, 6],
				maxHeight: '70vh',
			};
		},
	},
	mounted() {
		this._compactMq = window.matchMedia(COMPACT_QUERY);
		this._onCompactChange = () => { this.compact = this._compactMq.matches; };
		this._compactMq.addEventListener('change', this._onCompactChange);
		this._onCompactChange();
	},
	beforeUnmount() {
		this._compactMq?.removeEventListener('change', this._onCompactChange);
		clearTimeout(this._debounce);
		if (this._unsubFolder) this._unsubFolder();
		if (this._search) this._search.dispose();
	},
	watch: {
		folder: {
			immediate: true,
			handler(folder) {
				if (this._unsubFolder) this._unsubFolder();
				this._unsubFolder = null;
				if (folder && typeof folder.on === 'function') {
					// Bubbles from every descendant (see FileManagerDoubleSyncFolder.markChanged),
					// so this also catches the index file itself being deleted or re-added.
					const onChange = () => this.checkIndex();
					folder.on('change', onChange);
					this._unsubFolder = () => folder.off('change', onChange);
				}
				this.checkIndex();
			},
		},
		query(value) {
			clearTimeout(this._debounce);
			if ((value || '').trim().length < MIN_QUERY_CHARS) return;
			this._debounce = setTimeout(() => this.run(), DEBOUNCE_MS);
		},
	},
	methods: {
		async checkIndex() {
			this.hasIndex = await folderHasIndex(this.folder);
			if (!this.hasIndex) this.menuOpen = false;
		},
		onFocus() {
			if (this.phase !== 'idle' && (this.query || '').trim()) this.menuOpen = true;
		},
		clear() {
			clearTimeout(this._debounce);
			this._seq++;
			this.query = '';
			this.hits = [];
			this.error = null;
			this.phase = 'idle';
			// In compact mode the field lives in the menu — closing it would take the field too.
			if (!this.compact) this.menuOpen = false;
		},
		async openCompact() {
			this.menuOpen = true;
			await this.$nextTick();
			// The menu teleports and transitions in; focus once its content exists.
			setTimeout(() => this.$refs.compactInput?.focus(), 50);
		},
		runNow() {
			clearTimeout(this._debounce);
			this.run();
		},
		searcher() {
			if (!this._search) {
				this._search = new FolderSearch({
					onStatus: (status) => {
						if (status === 'loading-model') {
							this.progressPct = null;
							this.phase = 'loading-model';
						} else if (status === 'model-ready' && this.phase === 'loading-model') {
							this.phase = 'searching';
						}
					},
					onProgress: (loaded, total) => {
						this.progressPct = total ? Math.min(100, Math.round((loaded / total) * 100)) : null;
						this.progressMb = total ? Math.round(total / 1048576) : null;
					},
				});
			}
			return this._search;
		},
		async run() {
			const query = (this.query || '').trim();
			if (!query || !this.folder) return;
			// Only the latest query's answer is ever shown — typing past a slow one (the first
			// search, while the model downloads) must not flash its results afterwards.
			const seq = ++this._seq;
			this.error = null;
			this.menuOpen = true;
			if (this.phase !== 'loading-model') this.phase = 'searching';
			try {
				const hits = await this.searcher().search(this.folder, query, MAX_HITS);
				if (seq !== this._seq) return;
				this.hits = hits;
				this.phase = 'done';
			} catch (err) {
				if (seq !== this._seq) return;
				this.error = err?.message || 'Search failed.';
				this.hits = [];
				this.phase = 'error';
			}
		},
		reveal(hit) {
			this.menuOpen = false;
			this.$emit('reveal', {
				path: hit.path,
				selection: hit.stale ? null : { start: hit.startOffset, end: hit.endOffset },
			});
		},
	},
};
</script>

<style scoped>
.stream-search {
	/* Shrinks with the title rather than overflowing the header (which clips — see
	   FileBrowser.vue's panel-head), down to a width that still holds a few words. */
	flex: 0 1 220px;
	min-width: 120px;
	transition: flex-basis var(--q-transition-fast, 0.15s);
}

.stream-search:focus-within,
.stream-search--active {
	flex-basis: 300px;
}

.stream-search__input {
	width: 100%;
	/* The header strip turns selection off for its labels (see FileBrowser.vue); an input
	   still has to be selectable. */
	-webkit-user-select: text;
	user-select: text;
}

/* The dense header row is a fixed 40px — the field has to sit inside it like a button does,
   not push it taller. */
.stream-search__input :deep(.q-field__control),
.stream-search__input :deep(.q-field__marginal) {
	height: 28px;
	min-height: 28px;
}

.stream-search__input :deep(.q-field__native) {
	padding: 0;
	font-size: 13px;
}

.stream-search__input :deep(.q-field__prepend) {
	padding-right: 6px;
	color: var(--q-text-muted, #8a94a6);
}

/* Compact: just the icon button in the header row. Doubled class so it outranks the 720px
   block below, which would otherwise hand the button a 150px slot. */
.stream-search.stream-search--compact {
	flex: 0 0 auto;
	min-width: 0;
}

.stream-search__menu-field {
	padding: 10px 12px 4px;
}

/* A q-dialog brings no surface of its own, unlike a q-menu. */
.stream-search__panel--sheet {
	width: 100%;
	max-height: 80vh;
	overflow-y: auto;
	background: var(--q-surface-1, #150c33);
	border: 1px solid var(--q-surface-border, rgba(140, 120, 200, 0.18));
	border-radius: 0 0 12px 12px;
}

@media (max-width: 720px) {
	.stream-search,
	.stream-search:focus-within,
	.stream-search--active {
		flex-basis: 150px;
		min-width: 100px;
	}
}

.stream-search__panel {
	width: min(440px, calc(100vw - 32px));
	font-size: 13px;
}

.stream-search__state {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 14px 16px;
	color: var(--q-text-muted, #8a94a6);
}

.stream-search__state--row {
	flex-direction: row;
	align-items: center;
}

.stream-search__state--error {
	color: var(--q-negative);
}

.stream-search__hint {
	font-size: 12px;
}

.stream-search__list {
	padding: 4px 0;
}

.stream-search__hit {
	padding: 8px 16px;
}

/* Quasar's item section is a `.column`, which also sets flex-wrap: wrap — and in a wrapping
   flex container children stretch to the widest one's natural width rather than to the
   container. A long path therefore widened its own row (and the snippet under it) past the
   section, pushing that row's score out of line with the others and past the panel's edge
   (seen live). Single-line, children stretch to the section and the path ellipsises. */
.stream-search__hit-body {
	flex-wrap: nowrap;
}

.stream-search__hit-head {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-width: 0;
}

.stream-search__path {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--font-mono, monospace);
	font-size: 12px;
	color: var(--q-primary);
}

.stream-search__score {
	flex: 0 0 auto;
	/* Fixed column, right-aligned: "9%" and "58%" end on the same edge. */
	min-width: 4ch;
	text-align: right;
	font-size: 11px;
	font-variant-numeric: tabular-nums;
	color: var(--q-text-muted, #8a94a6);
}

.stream-search__snippet {
	margin-top: 3px;
	line-height: 1.45;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	line-clamp: 3;
	-webkit-box-orient: vertical;
	overflow: hidden;
}

.stream-search__stale {
	margin-top: 4px;
	font-size: 11px;
	color: var(--q-warning, #f2c037);
}

.stream-search__foot {
	padding: 8px 16px 10px;
	font-size: 11px;
	color: var(--q-text-muted, #8a94a6);
	border-top: 1px solid var(--q-surface-border, rgba(140, 120, 200, 0.18));
}
</style>
