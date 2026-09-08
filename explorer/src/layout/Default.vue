<template>
	<div class="overall_layout">
		<div class="app-container">
			<div class="presentation-dim" :class="{ 'presentation-dim--active': debugStore.presentationMode }">
				<AppHeader />
			</div>
			<RoutedPage />
		</div>

		<div class="presentation-dim" :class="{ 'presentation-dim--active': debugStore.presentationMode }">
			<AppFooter />
		</div>
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import AppHeader from './Header.vue';
import AppFooter from './AppFooter.vue';
import RoutedPage from './RoutedPage.vue';
import { useDebugStore } from '../stores/debug.js';

export default {
	name: 'LayoutDefault',
	components: {
		AppHeader,
		AppFooter,
		RoutedPage,
	},
	computed: {
		...mapStores(useDebugStore),
	},
};
</script>

<style scoped>
/* Sticky footer: the outer column, not the content area, claims the full viewport
   height, and the content area grows to fill whatever the footer doesn't use. That's
   what pins the footer to the bottom of the window on a short page instead of leaving it
   wherever content happens to end, needing a scroll to reach it — min-height: 100vh on
   .app-container itself (the previous approach) forced a scroll unconditionally, since
   the footer could then never start above the fold. */
.overall_layout {
	display: flex;
	flex-direction: column;
	min-height: 100vh;
}

.app-container {
	/* Full width, matching AppFooter — no max-width column, just padding. */
	flex: 1 0 auto;
	width: 100%;
	padding: 32px;
	padding-top: 8px;
	color: var(--q-text);
	font-family: var(--font-body);
}

@media (max-width: 680px) {
	.app-container {
		padding: 12px 16px;
	}
}

/* Presentation mode: dims non-essential chrome for a recording/demo, without disabling it —
   a stray click on the header/footer still works exactly as before, this is purely visual.
   Same class name (and rule) also appears in Stream.vue's "Add" panel — not shared via a
   global stylesheet since every other style in this app stays scoped per-component; small
   enough to duplicate rather than break that convention for. */
.presentation-dim {
	transition: opacity 0.2s ease;
}

.presentation-dim--active {
	opacity: 0.35;
}
</style>
