<template>
	<div>
		<DocSectionHeader
			class="q-mb-md"
			:items="cards"
			:query="query"
			@search="onSearch"
			@navigate="onCard"
		>
			<!-- Where these pages actually come from — the one line that says this isn't a
			     bundled site. -->
			<template v-if="source" #source>
				<span class="docs-page__source">
					<q-icon name="link" size="14px" />
					These docs are a Mnemonad stream themselves:
					<router-link :to="source.filesPath" class="docs-page__mono">{{ source.shortId }}</router-link>
					on {{ source.networkLabel }}, version {{ source.version }}
				</span>
			</template>
		</DocSectionHeader>

		<div class="q-px-md docs-page__body">
			<StreamDocs
				v-if="docsStream"
				:stream-id="docsStream.id"
				:network="docsStream.network"
				:route="docRoute"
				:hash="docHash"
				:query="query"
				:source-base-url="SOURCE_BASE_URL"
				route-base="/docs"
				:show-source="false"
				@navigate="onNavigate"
				@clear-query="onSearch('')"
				@loaded="onLoaded"
			/>
			<div v-else class="docs-page__state">
				The docs haven't been published to a stream yet. Run
				<code>pnpm --dir scripts push-docs:testnet</code> to publish them.
			</div>
		</div>
	</div>
</template>

<script>
import DocSectionHeader from '../components/DocSectionHeader.vue';
import StreamDocs from '../mnemonad/docs/StreamDocs.vue';
// Written by scripts/push_docs.js when it creates a docs stream: network id → stream id.
import DOCS_STREAMS from '../mnemonad/docsStream.json';

// Where the docs' links to repo source files resolve: the stream is pushed from the repo's
// docs/ folder, so a link like ../js/Mnemonad.js means this repo's js/Mnemonad.js.
const SOURCE_BASE_URL = 'https://github.com/jeka911/mnemonad/blob/main/docs/';

// The first network with a published docs stream. Mainnet first, so publishing there later
// takes over from testnet without an edit here.
const NETWORK_PREFERENCE = ['mainnet', 'testnet'];

export default {
	name: 'Docs',
	// Static route metadata read by pages/index.js to self-register this page. The catch-all
	// param is the doc's path inside the stream ('' for the landing page).
	path: '/docs/:path(.*)*',
	title: 'Docs',
	components: {
		DocSectionHeader,
		StreamDocs,
	},
	data() {
		return {
			SOURCE_BASE_URL,
			source: null,
		};
	},
	computed: {
		docsStream() {
			const network = NETWORK_PREFERENCE.find((n) => DOCS_STREAMS[n]);
			return network ? { network, id: DOCS_STREAMS[network] } : null;
		},
		docRoute() {
			const param = this.$route.params.path;
			const path = Array.isArray(param) ? param.join('/') : (param || '');
			return path.replace(/\/+$/, '');
		},
		docHash() {
			const hash = this.$route.hash ? this.$route.hash.slice(1) : '';
			return hash ? decodeURIComponent(hash) : null;
		},
		// In the URL (?q=), so a search can be linked to and Back returns to it.
		query() {
			return typeof this.$route.query.q === 'string' ? this.$route.query.q : '';
		},
		// The header's cards. A fixed, curated set rather than one entry per top-level doc/
		// folder in the stream — that grew to a full page of cards once the subproject READMEs
		// (see scripts/push_docs.js) started giving the tree a dozen top-level entries, most of
		// which nobody's looking for from here; the sidebar (DocsNav.vue) already lists
		// everything for whoever wants to browse the whole tree.
		cards() {
			return [
				{
					key: '',
					title: 'Overview',
					subtitle: 'Everything you need to build with Mnemonad',
					icon: 'o_article',
					active: this.docRoute === '',
				},
				{
					key: 'terms',
					title: 'Terms',
					subtitle: 'What stream, item, chunk, pointer and frame mean here',
					icon: 'o_article',
					active: this.docRoute === 'terms',
				},
				{
					key: 'search',
					title: 'Vector search',
					subtitle: 'How a folder\'s search index is built, shared, and searched',
					icon: 'o_article',
					active: this.docRoute === 'search',
				},
			];
		},
	},
	methods: {
		onLoaded({ source }) {
			this.source = source;
		},
		onNavigate({ route, hash }) {
			this.$router.push({
				path: route ? `/docs/${route}` : '/docs',
				hash: hash ? `#${encodeURIComponent(hash)}` : '',
			});
		},
		onCard(route) {
			this.onNavigate({ route, hash: null });
		},
		onSearch(text) {
			const q = (text || '').trim();
			if (q === this.query) return;
			// Search runs as you type, so refining an active search replaces the URL in place —
			// otherwise Back would step through every word typed. Starting or clearing a search
			// is a real step, and gets its own history entry.
			const method = this.query && q ? 'replace' : 'push';
			this.$router[method]({ path: this.$route.path, query: q ? { q } : {} });
		},
	},
};
</script>

<style scoped>
.docs-page__body {
	padding-bottom: 32px;
}

.docs-page__state {
	padding: 40px 0;
	text-align: center;
	color: var(--q-text-muted);
}

/* Plain inline text, so on a narrow screen it wraps like a sentence — as a wrapping flex row,
   the icon ended up alone on a line of its own. */
.docs-page__source :deep(.q-icon) {
	margin-right: 4px;
	vertical-align: -2px;
}

.docs-page__mono {
	font-family: var(--font-mono, monospace);
	color: var(--accent, var(--q-primary));
	text-decoration: none;
}

.docs-page__mono:hover {
	text-decoration: underline;
}

.docs-page__state code {
	font-family: var(--font-mono, monospace);
}
</style>
