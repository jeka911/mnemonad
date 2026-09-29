<template>
	<div class="stream-docs">
		<!-- Loading: the same three-column shape the page settles into, so nothing jumps. -->
		<div v-if="phase === 'loading'" class="stream-docs__layout" aria-busy="true">
			<aside class="stream-docs__nav">
				<q-skeleton v-for="n in 7" :key="n" type="text" class="q-mb-sm" :width="`${55 + (n * 13) % 40}%`" />
			</aside>
			<div class="stream-docs__main">
				<q-skeleton type="text" width="45%" height="42px" class="q-mb-md" />
				<q-skeleton v-for="n in 9" :key="n" type="text" :width="n % 4 === 0 ? '62%' : '100%'" />
				<div class="stream-docs__loading-note">Reading the docs from chain…</div>
			</div>
		</div>

		<div v-else-if="phase === 'error'" class="stream-docs__state">
			<p>Couldn't load the docs: {{ error }}</p>
			<GradientButton label="Retry" size="sm" @click="load" />
		</div>

		<div v-else class="stream-docs__layout">
			<aside class="stream-docs__nav" :class="{ 'stream-docs__nav--open': navOpen }">
				<button type="button" class="stream-docs__nav-toggle" :aria-expanded="navOpen" @click="navOpen = !navOpen">
					<q-icon name="menu_book" size="18px" />
					<span>{{ currentDoc ? currentDoc.title : 'Contents' }}</span>
					<q-icon :name="navOpen ? 'expand_less' : 'expand_more'" size="18px" />
				</button>
				<div class="stream-docs__nav-body">
					<a
						v-if="tree.route !== null"
						class="stream-docs__home"
						:class="{ 'stream-docs__home--active': route === tree.route }"
						:href="routeHref(tree.route)"
						@click="onNavClick($event, tree.route)"
					>Overview</a>
					<DocsNav
						:nodes="tree.children"
						:current-route="route"
						:route-href="routeHref"
						@navigate="navigate"
					/>
				</div>
			</aside>

			<div class="stream-docs__main">
				<!-- Search results take the article's place while a query is active; the article
				     stays mounted underneath (v-show) so a hit in the same doc can be highlighted
				     the moment the results go away. -->
				<section v-if="query" class="stream-docs__results" aria-live="polite">
					<div class="stream-docs__results-head">
						<span>Results for <strong>“{{ query }}”</strong></span>
						<button type="button" class="stream-docs__clear" @click="$emit('clear-query')">
							<q-icon name="close" size="16px" /> Clear
						</button>
					</div>

					<div v-if="searchPhase === 'loading-model'" class="stream-docs__search-state">
						<div v-if="progressPct === 100">Starting the search model…</div>
						<div v-else>Downloading the search model…<template v-if="progressPct !== null"> {{ progressPct }}%<template v-if="progressMb"> of {{ progressMb }} MB</template></template></div>
						<q-linear-progress
							:value="progressPct === null ? 0 : progressPct / 100"
							:indeterminate="progressPct === null"
							color="primary"
							rounded
							size="4px"
						/>
						<div class="stream-docs__hint">One time only — your browser keeps it cached.</div>
					</div>
					<div v-else-if="searchPhase === 'searching'" class="stream-docs__search-state stream-docs__search-state--row">
						<q-spinner color="primary" size="16px" /> Searching…
					</div>
					<div v-else-if="searchPhase === 'error'" class="stream-docs__search-state stream-docs__search-state--error">
						{{ searchError }}
					</div>
					<div v-else-if="searchPhase === 'done' && !hits.length" class="stream-docs__search-state">
						No matches.
					</div>

					<ol v-if="searchPhase === 'done' && hits.length" class="stream-docs__hits">
						<li v-for="hit in hits" :key="hit.path + '#' + hit.chunkIndex">
							<a class="stream-docs__hit" :href="routeHref(hit.route)" @click="onHitClick($event, hit)">
								<span class="stream-docs__hit-head">
									<span class="stream-docs__hit-title">
										{{ hit.title }}<template v-if="hit.section"> <span class="stream-docs__hit-sep">›</span> {{ hit.section }}</template>
									</span>
									<span class="stream-docs__hit-score" title="Cosine similarity to your query">{{ hit.score }}%</span>
								</span>
								<span class="stream-docs__hit-snippet">{{ hit.snippet }}</span>
							</a>
						</li>
					</ol>
					<p class="stream-docs__hint stream-docs__search-foot">
						Searched on this device from the stream's own index — your query never leaves the browser.
					</p>
				</section>

				<div v-show="!query">
					<div v-if="!currentDoc" class="stream-docs__state">
						<p>There's no page at this address.</p>
						<a :href="routeHref(tree.route ?? '')" @click="onNavClick($event, tree.route ?? '')">Go to the docs overview</a>
					</div>
					<!-- eslint-disable-next-line vue/no-v-html — sanitized in markdown.js -->
					<article v-else ref="article" class="stream-docs__article" v-html="html" @click="onArticleClick" />
				</div>

				<footer v-if="showSource" class="stream-docs__footer">
					<q-icon name="link" size="14px" />
					<span>
						Loaded from stream
						<router-link :to="filesPath" class="stream-docs__mono">{{ shortId }}</router-link>
						on {{ networkLabel }} · version {{ version }}
					</span>
				</footer>
			</div>

			<nav v-if="currentDoc && toc.length > 1 && !query" class="stream-docs__toc" aria-label="On this page">
				<div class="stream-docs__toc-title">On this page</div>
				<a
					v-for="item in toc"
					:key="item.slug"
					class="stream-docs__toc-link"
					:class="`stream-docs__toc-link--h${item.level}`"
					:href="routeHref(route, item.slug)"
					@click="onTocClick($event, item.slug)"
				>{{ item.text }}</a>
			</nav>
		</div>
	</div>
</template>

<script>
import GradientButton from '../../components/GradientButton.vue';
import { NETWORKS } from '../../settings.js';
import { streamPath } from '../../includes/streamRoute.js';
import FolderSearch, { folderHasIndex } from '../search/folderSearch.js';
import DocsNav from './DocsNav.vue';
import { loadStreamFolder } from './loadStreamFolder.js';
import { buildDocsTree, docForRoute, headingsOf, stripMarkdown } from './docsTree.js';
import { renderMarkdown, lineAt } from './markdown.js';

const MAX_HITS = 10;
const SNIPPET_CHARS = 260;

let mermaidSeq = 0;

/**
 * Reads the site's own CSS custom properties (explorer/src/themes/monad/{dark,light}.css)
 * rather than hardcoding a second copy of Monad's palette here — whichever theme is active
 * on `<body>` right now is what these resolve to, so light/dark switching (see
 * onThemeChange()) stays in sync automatically instead of drifting from the real tokens.
 *
 * Deliberately light-touch: only the *un-classed* structural bits (default node fill/border,
 * arrows, canvas background, text, font) are themed. A diagram's own explicit
 * `classDef`/`class` styling (terms.md's tier/chunk/pointer/store colors, for instance) is
 * how it draws real semantic distinctions between node kinds, and always wins over these
 * theme defaults in mermaid regardless — nothing here overrides that on purpose.
 */
function mermaidThemeVariables() {
	const styles = getComputedStyle(document.body);
	const v = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
	const primary = v('--q-primary', '#836ef9');
	const surfaceBg = v('--q-surface-1', '#150c33');
	const nodeBg = v('--q-surface-2', '#1e1147');
	const border = v('--q-surface-border', '#33246b');
	const textBright = v('--q-text-bright', '#fbfaf9');
	const text = v('--q-text', '#d8d3ea');
	const fontFamily = v('--font-body', 'inherit');
	return {
		background: surfaceBg,
		fontFamily,
		textColor: text,
		lineColor: primary,
		primaryColor: nodeBg,
		primaryBorderColor: primary,
		primaryTextColor: textBright,
		secondaryColor: nodeBg,
		tertiaryColor: nodeBg,
		mainBkg: nodeBg,
		nodeBorder: primary,
		clusterBkg: surfaceBg,
		clusterBorder: border,
		edgeLabelBackground: surfaceBg,
		// Sequence-diagram specific — cascades from the above in mermaid's own themes, but
		// spelled out since search.md's diagram is one and this is worth getting right too.
		actorBkg: nodeBg,
		actorBorder: primary,
		actorTextColor: textBright,
		signalColor: primary,
		signalTextColor: text,
		labelBoxBkgColor: nodeBg,
		labelBoxBorderColor: primary,
		labelTextColor: text,
		loopTextColor: text,
		noteBkgColor: nodeBg,
		noteBorderColor: border,
		noteTextColor: text,
	};
}

/**
 * A docs site read straight out of a Mnemonad stream: every markdown file in the stream's
 * folder becomes a page, the folder structure becomes the navigation, and the stream's own
 * `search_index.db` (if it has one) powers search. Nothing is bundled with the app — change
 * the docs by pushing to the stream.
 *
 * Routing is left to the parent: this renders `route` (a doc path without `.md`, '' for the
 * landing page) and emits `navigate` for every in-docs link, so the page can put it in the URL.
 * Search is driven the same way, through the `query` prop.
 */
export default {
	name: 'StreamDocs',
	components: { DocsNav, GradientButton },
	props: {
		streamId: { type: String, required: true },
		// settings.js network id ('testnet' / 'mainnet') — read from that chain whichever
		// network the app is on (see loadStreamFolder.js).
		network: { type: String, required: true },
		route: { type: String, default: '' },
		hash: { type: String, default: null },
		query: { type: String, default: '' },
		// Where links leaving the stream (to source files, say) should point: the stream
		// root's location, e.g. a repo's /blob/main/docs/. Without it they render as plain text.
		sourceBaseUrl: { type: String, default: null },
		// URL prefix the parent routes docs under, for real hrefs (middle-click, copy link).
		routeBase: { type: String, default: '/docs' },
		// The "Loaded from stream … · version N" footer. Off for a page that shows it itself
		// (it's in the `loaded` event's payload for that).
		showSource: { type: Boolean, default: true },
	},
	emits: ['navigate', 'clear-query', 'loaded'],
	data() {
		return {
			phase: 'loading',
			error: null,
			tree: null,
			version: null,
			hasIndex: false,
			html: '',
			toc: [],
			currentDoc: null,
			navOpen: false,

			searchPhase: 'idle',
			searchError: null,
			hits: [],
			progressPct: null,
			progressMb: null,
		};
	},
	computed: {
		networkLabel() {
			return NETWORKS[this.network]?.label || this.network;
		},
		shortId() {
			const hex = BigInt(this.streamId).toString(16).padStart(64, '0');
			return `0x${hex.slice(0, 6)}…${hex.slice(-4)}`;
		},
		filesPath() {
			return streamPath(this.streamId, { networkId: this.network, files: true });
		},
	},
	created() {
		// Non-reactive: a whole restored folder, and a Map of every doc's source.
		this._folder = null;
		this._docs = new Map();
		this._docRoutes = new Map();
		this._search = null;
		this._searchSeq = 0;
		this._pendingHit = null;
	},
	beforeUnmount() {
		if (this._search) this._search.dispose();
		this._themeObserver?.disconnect();
	},
	watch: {
		streamId: 'load',
		network: 'load',
		route() {
			this.navOpen = false;
			this.renderCurrent();
		},
		hash() {
			if (!this._pendingHit) this.scrollToHash();
		},
		query() {
			this.runSearch();
		},
	},
	mounted() {
		this.load();
		// Diagrams are drawn in the theme active when they rendered; the app's light/dark toggle
		// flips a class on <body>, so that's what's watched to draw them again.
		this._isLight = document.body.classList.contains('body--light');
		this._themeObserver = new MutationObserver(() => this.onThemeChange());
		this._themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
	},
	methods: {
		routeHref(route, hash = null) {
			const path = route ? `${this.routeBase}/${route}` : this.routeBase;
			return hash ? `${path}#${encodeURIComponent(hash)}` : path;
		},
		async load() {
			this.phase = 'loading';
			this.error = null;
			try {
				const { folder, version } = await loadStreamFolder({ network: this.network, streamId: this.streamId });
				const { tree, docs } = await buildDocsTree(folder);
				this._folder = folder;
				this._docs = docs;
				this._docRoutes = new Map([...docs.values()].map((d) => [d.path, d.route]));
				this.tree = tree;
				this.version = version;
				this.hasIndex = await folderHasIndex(folder);
				this.phase = 'ready';
				this.$emit('loaded', {
					tree,
					hasIndex: this.hasIndex,
					source: {
						streamId: this.streamId,
						network: this.network,
						networkLabel: this.networkLabel,
						shortId: this.shortId,
						filesPath: this.filesPath,
						version,
					},
				});
				await this.renderCurrent();
				if (this.query) this.runSearch();
			} catch (err) {
				console.error('[StreamDocs] load failed:', err);
				this.error = err?.shortMessage || err?.message || String(err);
				this.phase = 'error';
			}
		},
		async renderCurrent() {
			if (this.phase !== 'ready') return;
			const doc = docForRoute(this._docs, this.route);
			this.currentDoc = doc ? { path: doc.path, title: doc.title } : null;
			if (!doc) {
				this.html = '';
				this.toc = [];
				return;
			}
			const { html, toc } = renderMarkdown(doc.text, {
				docPath: doc.path,
				docRoutes: this._docRoutes,
				sourceBaseUrl: this.sourceBaseUrl,
				routeHref: this.routeHref,
			});
			this.html = html;
			this.toc = toc.filter((h) => h.level === 2 || h.level === 3);
			await this.$nextTick();
			const target = this._pendingHit && this._pendingHit.path === doc.path ? 'hit' : (this.hash ? 'hash' : 'top');
			if (target === 'hit') this.applyPendingHit();
			else if (target === 'hash') this.scrollToHash('auto');
			else this.scrollToArticleTop();

			// Diagrams render asynchronously and change height as they do, which moves everything
			// below them — a jump made before that would land short (seen live: a #hash below two
			// diagrams ended up thousands of pixels away). Positioned again once they're drawn,
			// unless the reader has moved on to another page meanwhile.
			const drew = await this.renderMermaid();
			if (!drew || this.route !== doc.route || this.currentDoc?.path !== doc.path) return;
			if (target === 'hit') {
				this.$refs.article?.querySelector('.docs-hit')?.scrollIntoView({ block: 'center' });
			} else if (target === 'hash') {
				this.scrollToHash('auto');
			}
		},
		/** @returns {Promise<boolean>} whether any diagram was drawn (and so the layout moved). */
		async renderMermaid() {
			const article = this.$refs.article;
			const blocks = article ? [...article.querySelectorAll('.docs-mermaid:not([data-rendered])')] : [];
			if (!blocks.length) return false;
			// Only pages that actually have a diagram pay for mermaid, and only once.
			const { default: mermaid } = await import('mermaid');
			mermaid.initialize({
				startOnLoad: false,
				// 'strict': no HTML labels executing, no click handlers — the diagram source is
				// as untrusted as the rest of the stream's markdown.
				securityLevel: 'strict',
				theme: document.body.classList.contains('body--light') ? 'default' : 'dark',
				themeVariables: mermaidThemeVariables(),
			});
			for (const block of blocks) {
				if (!block.isConnected) continue;
				const source = block._mermaidSource ?? (block.querySelector('.docs-mermaid__src')?.textContent || '');
				try {
					const { svg } = await mermaid.render(`docs-mermaid-${++mermaidSeq}`, source);
					if (!block.isConnected) continue;
					// Kept on the element: drawing replaces the source, and a theme switch has to
					// draw it again (see onThemeChange).
					block._mermaidSource = source;
					block.innerHTML = svg;
					block.setAttribute('data-rendered', '');
				} catch (err) {
					// Leave the source visible — a broken diagram still reads as text.
					block.classList.add('docs-mermaid--error');
					console.warn('[StreamDocs] mermaid failed:', err);
				}
			}
			return true;
		},
		onThemeChange() {
			const isLight = document.body.classList.contains('body--light');
			if (isLight === this._isLight) return;
			this._isLight = isLight;
			const article = this.$refs.article;
			if (!article) return;
			for (const block of article.querySelectorAll('.docs-mermaid[data-rendered]')) {
				block.removeAttribute('data-rendered');
			}
			this.renderMermaid();
		},
		navigate({ route, hash = null }) {
			this.$emit('navigate', { route, hash });
		},
		onNavClick(event, route) {
			if (this.isModifiedClick(event)) return;
			event.preventDefault();
			this.navigate({ route });
		},
		isModifiedClick(event) {
			return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
		},
		onArticleClick(event) {
			const link = event.target.closest('a');
			if (!link || this.isModifiedClick(event)) return;
			const route = link.getAttribute('data-doc-route');
			const hash = link.getAttribute('data-doc-hash');
			if (route !== null) {
				event.preventDefault();
				this.navigate({ route, hash });
			} else if (hash !== null) {
				event.preventDefault();
				this.navigate({ route: this.route, hash });
			}
		},
		onTocClick(event, slug) {
			if (this.isModifiedClick(event)) return;
			event.preventDefault();
			this.navigate({ route: this.route, hash: slug });
		},
		scrollToHash(behavior = 'smooth') {
			if (!this.hash || !this.$refs.article) return;
			const target = this.$refs.article.querySelector(`[id="${CSS.escape(this.hash)}"]`);
			target?.scrollIntoView({ behavior, block: 'start' });
		},
		scrollToArticleTop() {
			const el = this.$el;
			if (!el || !el.getBoundingClientRect) return;
			const top = el.getBoundingClientRect().top;
			// Only when the reader is scrolled past the docs — never yank the page down.
			if (top < 0) window.scrollTo({ top: window.scrollY + top - 16, behavior: 'smooth' });
		},

		searcher() {
			if (!this._search) {
				this._search = new FolderSearch({
					onStatus: (status) => {
						if (status === 'loading-model') {
							this.progressPct = null;
							this.searchPhase = 'loading-model';
						} else if (status === 'model-ready' && this.searchPhase === 'loading-model') {
							this.searchPhase = 'searching';
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
		async runSearch() {
			const query = (this.query || '').trim();
			const seq = ++this._searchSeq;
			if (!query || this.phase !== 'ready') {
				this.searchPhase = 'idle';
				this.hits = [];
				return;
			}
			if (!this.hasIndex) {
				this.searchPhase = 'error';
				this.searchError = 'These docs were published without a search index.';
				return;
			}
			this.searchError = null;
			if (this.searchPhase !== 'loading-model') this.searchPhase = 'searching';
			try {
				const raw = await this.searcher().search(this._folder, query, MAX_HITS);
				if (seq !== this._searchSeq) return;
				this.hits = raw.filter((h) => this._docs.has(h.path)).map((h) => this.describeHit(h));
				this.searchPhase = 'done';
			} catch (err) {
				if (seq !== this._searchSeq) return;
				this.searchError = err?.message || 'Search failed.';
				this.hits = [];
				this.searchPhase = 'error';
			}
		},
		/** A hit as a reader sees it: which doc and section, and the passage as prose. */
		describeHit(hit) {
			const doc = this._docs.get(hit.path);
			const startLine = lineAt(doc.text, hit.startOffset);
			const section = headingsOf(doc.text)
				.filter((h) => h.level >= 2 && h.line <= startLine)
				.pop();
			return {
				path: hit.path,
				route: doc.route,
				chunkIndex: hit.chunkIndex,
				startOffset: hit.startOffset,
				endOffset: hit.endOffset,
				stale: hit.stale,
				score: hit.score,
				title: doc.title,
				section: section ? section.text : null,
				snippet: stripMarkdown(hit.displayText).slice(0, SNIPPET_CHARS),
			};
		},
		onHitClick(event, hit) {
			if (this.isModifiedClick(event)) return;
			event.preventDefault();
			// Offsets from an index built against an older version of the file can't be
			// trusted to land on the right passage — open the doc, but don't point into it.
			this._pendingHit = hit.stale ? null : hit;
			this.$emit('clear-query');
			if (hit.route !== this.route) {
				this.navigate({ route: hit.route });
			} else {
				this.$nextTick(() => this.applyPendingHit());
			}
		},
		/** Marks the rendered blocks a hit's chunk came from and scrolls to the first. Every
		 *  block carries its source line range (markdown.js); the hit's character offsets
		 *  become lines, and the innermost blocks overlapping them are the passage. */
		applyPendingHit() {
			const hit = this._pendingHit;
			this._pendingHit = null;
			const article = this.$refs.article;
			const doc = hit && this._docs.get(hit.path);
			if (!article || !doc) return;
			for (const el of article.querySelectorAll('.docs-hit')) el.classList.remove('docs-hit');

			const first = lineAt(doc.text, hit.startOffset);
			const last = lineAt(doc.text, Math.max(hit.startOffset, hit.endOffset - 1));
			const overlapping = [...article.querySelectorAll('[data-src-lines]')].filter((el) => {
				const [start, end] = el.getAttribute('data-src-lines').split('-').map(Number);
				return start <= last && end > first;
			});
			const innermost = overlapping.filter((el) => !overlapping.some((other) => other !== el && el.contains(other)));
			for (const el of innermost) el.classList.add('docs-hit');
			innermost[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		},
	},
};
</script>

<style scoped>
.stream-docs__layout {
	display: grid;
	grid-template-columns: 220px minmax(0, 1fr) 200px;
	gap: 32px;
	align-items: start;
}

.stream-docs__nav,
.stream-docs__toc {
	position: sticky;
	top: calc(16px + env(safe-area-inset-top, 0px));
	max-height: calc(100vh - 32px);
	overflow-y: auto;
}

.stream-docs__nav-toggle {
	display: none;
}

.stream-docs__home {
	display: block;
	padding: 5px 10px;
	border-radius: 8px;
	font-size: 13.5px;
	color: var(--q-text-muted);
	text-decoration: none;
}

.stream-docs__home:hover {
	color: var(--q-text-bright);
	background: rgba(131, 93, 224, 0.08);
}

.stream-docs__home--active,
.stream-docs__home--active:hover {
	color: var(--q-text-bright);
	background: rgba(131, 93, 224, 0.16);
	font-weight: 600;
}

.stream-docs__main {
	min-width: 0;
}

.stream-docs__loading-note {
	margin-top: 16px;
	font-size: 13px;
	color: var(--q-text-muted);
}

.stream-docs__state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	padding: 40px 0;
	text-align: center;
	color: var(--q-text-muted);
}

.stream-docs__footer {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-top: 40px;
	padding-top: 14px;
	border-top: 1px solid var(--q-surface-border);
	font-size: 12px;
	color: var(--q-text-muted);
}

.stream-docs__mono {
	font-family: var(--font-mono, monospace);
}

/* ── Table of contents ── */
.stream-docs__toc-title {
	margin-bottom: 8px;
	font-size: 11.5px;
	font-weight: 650;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--q-text-muted);
}

.stream-docs__toc-link {
	display: block;
	padding: 3px 0;
	font-size: 12.5px;
	line-height: 1.4;
	color: var(--q-text-muted);
	text-decoration: none;
}

.stream-docs__toc-link:hover {
	color: var(--q-text-bright);
}

.stream-docs__toc-link--h3 {
	padding-left: 12px;
}

/* ── Search results ── */
.stream-docs__results-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 12px;
	color: var(--q-text-muted);
}

.stream-docs__results-head strong {
	color: var(--q-text-bright);
}

.stream-docs__clear {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 4px 10px;
	border: 1px solid var(--q-surface-border);
	border-radius: 8px;
	background: none;
	color: var(--q-text-muted);
	font: inherit;
	font-size: 12.5px;
	cursor: pointer;
}

.stream-docs__clear:hover {
	color: var(--q-text-bright);
}

.stream-docs__search-state {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 16px 0;
	color: var(--q-text-muted);
}

.stream-docs__search-state--row {
	flex-direction: row;
	align-items: center;
}

.stream-docs__search-state--error {
	color: var(--q-negative);
}

.stream-docs__hint {
	font-size: 12px;
	color: var(--q-text-muted);
}

.stream-docs__hits {
	list-style: none;
	margin: 0;
	padding: 0;
}

.stream-docs__hit {
	display: block;
	padding: 12px 14px;
	margin: 0 -14px;
	border-radius: 10px;
	color: inherit;
	text-decoration: none;
}

.stream-docs__hit:hover {
	background: rgba(131, 93, 224, 0.08);
}

.stream-docs__hit-head {
	display: flex;
	align-items: baseline;
	gap: 10px;
}

.stream-docs__hit-title {
	flex: 1 1 auto;
	min-width: 0;
	font-weight: 600;
	color: var(--q-primary);
}

.stream-docs__hit-sep {
	/* Spaced here, not with template whitespace — Vue's whitespace handling drops the space
	   between the title and the separator. */
	margin: 0 0.4em;
	color: var(--q-text-muted);
	font-weight: 400;
}

.stream-docs__hit-score {
	flex: 0 0 auto;
	min-width: 4ch;
	text-align: right;
	font-size: 11.5px;
	font-variant-numeric: tabular-nums;
	color: var(--q-text-muted);
}

.stream-docs__hit-snippet {
	display: -webkit-box;
	margin-top: 4px;
	font-size: 13.5px;
	line-height: 1.5;
	color: var(--q-text-muted);
	-webkit-line-clamp: 3;
	line-clamp: 3;
	-webkit-box-orient: vertical;
	overflow: hidden;
}

.stream-docs__search-foot {
	margin-top: 16px;
}

/* ── The rendered markdown ── */
.stream-docs__article {
	font-size: 15px;
	line-height: 1.7;
	color: var(--q-text);
	overflow-wrap: break-word;
}

.stream-docs__article :deep(h1),
.stream-docs__article :deep(h2),
.stream-docs__article :deep(h3),
.stream-docs__article :deep(h4) {
	line-height: 1.25;
	letter-spacing: -0.015em;
	color: var(--q-text-bright);
	/* Clear of the viewport edge when jumped to from the table of contents. */
	scroll-margin-top: 24px;
}

.stream-docs__article :deep(h1) {
	margin: 0 0 20px;
	font-size: 30px;
	font-weight: 700;
}

.stream-docs__article :deep(h2) {
	margin: 40px 0 14px;
	padding-bottom: 8px;
	font-size: 22px;
	font-weight: 650;
	border-bottom: 1px solid var(--q-surface-border);
}

.stream-docs__article :deep(h3) {
	margin: 28px 0 10px;
	font-size: 17px;
	font-weight: 650;
}

.stream-docs__article :deep(p),
.stream-docs__article :deep(ul),
.stream-docs__article :deep(ol),
.stream-docs__article :deep(blockquote),
.stream-docs__article :deep(pre),
.stream-docs__article :deep(table) {
	margin: 0 0 16px;
}

.stream-docs__article :deep(ul),
.stream-docs__article :deep(ol) {
	padding-left: 24px;
}

.stream-docs__article :deep(li + li) {
	margin-top: 4px;
}

.stream-docs__article :deep(a) {
	color: var(--q-primary);
	text-decoration: underline;
	text-decoration-color: rgba(131, 93, 224, 0.4);
	text-underline-offset: 3px;
}

.stream-docs__article :deep(a:hover) {
	text-decoration-color: currentColor;
}

.stream-docs__article :deep(a.docs-dead-link) {
	color: inherit;
	text-decoration: none;
}

.stream-docs__article :deep(code) {
	padding: 1px 5px;
	font-family: var(--font-mono, monospace);
	font-size: 0.86em;
	border-radius: 5px;
	background: rgba(131, 93, 224, 0.12);
}

.stream-docs__article :deep(pre) {
	padding: 14px 16px;
	overflow-x: auto;
	border: 1px solid var(--q-surface-border);
	border-radius: 10px;
	background: rgba(12, 10, 22, 0.55);
	line-height: 1.55;
}

.stream-docs__article :deep(pre code) {
	padding: 0;
	font-size: 13px;
	background: none;
}

.stream-docs__article :deep(blockquote) {
	padding: 4px 16px;
	border-left: 3px solid var(--q-primary);
	color: var(--q-text-muted);
}

.stream-docs__article :deep(table) {
	display: block;
	max-width: 100%;
	overflow-x: auto;
	border-collapse: collapse;
	font-size: 13.5px;
}

.stream-docs__article :deep(th),
.stream-docs__article :deep(td) {
	padding: 7px 12px;
	border: 1px solid var(--q-surface-border);
	vertical-align: top;
	text-align: left;
}

.stream-docs__article :deep(th) {
	background: rgba(131, 93, 224, 0.08);
	font-weight: 650;
}

.stream-docs__article :deep(hr) {
	margin: 32px 0;
	border: 0;
	border-top: 1px solid var(--q-surface-border);
}

.stream-docs__article :deep(.docs-mermaid) {
	margin: 0 0 16px;
	padding: 16px;
	overflow-x: auto;
	border: 1px solid var(--q-surface-border);
	border-radius: 10px;
	text-align: center;
}

.stream-docs__article :deep(.docs-mermaid svg) {
	max-width: 100%;
	height: auto;
}

/* Until mermaid has drawn it (or if it can't), the diagram's source stands in. */
.stream-docs__article :deep(.docs-mermaid__src) {
	margin: 0;
	padding: 0;
	border: 0;
	background: none;
	text-align: left;
	font-size: 12px;
	color: var(--q-text-muted);
}

/* A search hit's passage: highlighted once on arrival, then settles to a quiet marker. */
.stream-docs__article :deep(.docs-hit) {
	border-radius: 6px;
	background: rgba(131, 93, 224, 0.14);
	box-shadow: 0 0 0 6px rgba(131, 93, 224, 0.14);
	animation: docs-hit-flash 1.6s ease-out;
}

@keyframes docs-hit-flash {
	0% {
		background: rgba(131, 93, 224, 0.42);
		box-shadow: 0 0 0 6px rgba(131, 93, 224, 0.42);
	}
}

body.body--light .stream-docs__article :deep(pre) {
	background: rgba(245, 243, 255, 0.7);
}

/* ── Narrow screens: the table of contents goes, then the nav folds into a toggle. ── */
@media (max-width: 1200px) {
	.stream-docs__layout {
		grid-template-columns: 200px minmax(0, 1fr);
	}

	.stream-docs__toc {
		display: none;
	}
}

@media (max-width: 860px) {
	.stream-docs__layout {
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}

	.stream-docs__nav {
		position: static;
		max-height: none;
		overflow: visible;
	}

	.stream-docs__nav-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--q-surface-border);
		border-radius: 10px;
		background: none;
		color: var(--q-text-bright);
		font: inherit;
		font-size: 14px;
		text-align: left;
		cursor: pointer;
	}

	.stream-docs__nav-toggle span {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stream-docs__nav-body {
		display: none;
		margin-top: 8px;
	}

	.stream-docs__nav--open .stream-docs__nav-body {
		display: block;
	}

	.stream-docs__article :deep(h1) {
		font-size: 25px;
	}
}
</style>
