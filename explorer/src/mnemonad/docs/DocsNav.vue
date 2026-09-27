<template>
	<ul class="docs-nav" :class="{ 'docs-nav--nested': depth > 0 }">
		<li v-for="node in nodes" :key="node.path" class="docs-nav__item">
			<template v-if="node.kind === 'doc'">
				<a
					class="docs-nav__link"
					:class="{ 'docs-nav__link--active': node.route === currentRoute }"
					:href="routeHref(node.route)"
					:aria-current="node.route === currentRoute ? 'page' : null"
					@click="onClick($event, node.route)"
				>{{ node.title }}</a>
			</template>
			<template v-else>
				<!-- A folder with its own README is a page too; one without is just a heading. -->
				<a
					v-if="node.route !== null"
					class="docs-nav__link docs-nav__folder"
					:class="{ 'docs-nav__link--active': node.route === currentRoute }"
					:href="routeHref(node.route)"
					@click="onClick($event, node.route)"
				>{{ node.title }}</a>
				<span v-else class="docs-nav__folder">{{ node.title }}</span>
				<DocsNav
					:nodes="node.children"
					:current-route="currentRoute"
					:route-href="routeHref"
					:depth="depth + 1"
					@navigate="$emit('navigate', $event)"
				/>
			</template>
		</li>
	</ul>
</template>

<script>
export default {
	name: 'DocsNav',
	props: {
		nodes: { type: Array, required: true },
		currentRoute: { type: String, default: '' },
		routeHref: { type: Function, required: true },
		depth: { type: Number, default: 0 },
	},
	emits: ['navigate'],
	methods: {
		onClick(event, route) {
			// Modified clicks (new tab, etc.) keep the real href's default behaviour.
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
			event.preventDefault();
			this.$emit('navigate', { route, hash: null });
		},
	},
};
</script>

<style scoped>
.docs-nav {
	list-style: none;
	margin: 0;
	padding: 0;
}

.docs-nav--nested {
	margin: 2px 0 8px;
	padding-left: 12px;
	border-left: 1px solid var(--q-surface-border);
}

.docs-nav__item {
	margin: 0;
}

.docs-nav__link,
.docs-nav__folder {
	display: block;
	padding: 5px 10px;
	border-radius: 8px;
	font-size: 13.5px;
	line-height: 1.35;
	color: var(--q-text-muted);
	text-decoration: none;
}

.docs-nav__folder {
	margin-top: 10px;
	font-size: 11.5px;
	font-weight: 650;
	letter-spacing: 0.06em;
	text-transform: uppercase;
}

.docs-nav__link:hover {
	color: var(--q-text-bright);
	background: rgba(131, 93, 224, 0.08);
}

.docs-nav__link--active,
.docs-nav__link--active:hover {
	color: var(--q-text-bright);
	background: rgba(131, 93, 224, 0.16);
	font-weight: 600;
}
</style>
