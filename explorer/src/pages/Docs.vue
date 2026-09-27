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
			tree: null,
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
		// The header's cards: the stream's own top-level sections, on every docs page, with the
		// one the current page belongs to marked active (none on the landing page).
		cards() {
			if (!this.tree) return [];
			return this.tree.children
				.map((node) => ({
					key: node.kind === 'doc' ? node.route : (node.route ?? firstDocRoute(node)),
					title: node.title,
					subtitle: node.summary,
					icon: node.kind === 'folder' ? 'o_folder' : 'o_article',
					active: containsRoute(node, this.docRoute),
				}))
				.filter((card) => card.key !== null);
		},
	},
	methods: {
		onLoaded({ tree, source }) {
			this.tree = tree;
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

/** Whether the page at `route` is `node` itself or, for a folder, anywhere inside it. */
function containsRoute(node, route) {
	if (!route) return false;
	if (node.kind === 'doc') return node.route === route;
	return node.route === route || route.startsWith(`${node.path}/`);
}

/** A folder with no README of its own opens its first doc. */
function firstDocRoute(folder) {
	for (const child of folder.children) {
		if (child.kind === 'doc') return child.route;
		const nested = child.route ?? firstDocRoute(child);
		if (nested !== null) return nested;
	}
	return null;
}
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

.docs-page__source {
	display: inline-flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 5px;
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
