<template>
	<GradientSection>
		<PageIntro
			icon="o_description"
			search-placeholder="Search documentation..."
			:query="query"
			live
			@search="$emit('search', $event)"
		>
			<h1 class="docs-title">Docs</h1>
			<p class="docs-subtitle">
				Everything you need to build with Mnemonad
			</p>

			<template v-if="$slots.source" #below-search>
				<slot name="source" />
			</template>
		</PageIntro>

		<div v-if="items.length" class="docs-links">
			<button
				v-for="item in items"
				:key="item.key"
				class="docs-link-card"
				:class="{ 'docs-link-card--active': item.active }"
				type="button"
				:aria-current="item.active ? 'page' : null"
				@click="$emit('navigate', item.key)"
			>
				<span class="link-icon" aria-hidden="true">
					<q-icon :name="item.icon || 'o_article'" size="26px" />
				</span>

				<span class="link-copy">
					<strong>{{ item.title }}</strong>
					<small>{{ item.subtitle }}</small>
				</span>

				<svg class="chevron" viewBox="0 0 24 24" fill="none">
					<path
						d="m9 6 6 6-6 6"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</div>
	</GradientSection>
</template>

<script>
import PageIntro from './PageIntro.vue';
import GradientSection from './GradientSection.vue';

export default {
	name: 'DocsSectionHeader',

	components: {
		PageIntro,
		GradientSection,
	},

	props: {
		// One card per entry: {key, title, subtitle, icon?, active?}. Emitted back as
		// `navigate`'s payload (the key) when clicked; `active` marks the section the reader is
		// in. No cards are rendered when empty.
		items: {
			type: Array,
			default: () => [],
		},
		// The search field's text, when the page owns it (a query in the URL, say).
		query: {
			type: String,
			default: '',
		},
	},

	emits: ['search', 'navigate'],
}
</script>

<style scoped>
.docs-links {
	position: relative;
	z-index: 1;
}

.docs-title {
	margin: 0;
	font-size: 28px;
	line-height: 1.1;
	font-weight: 700;
	letter-spacing: -0.025em;
	color: var(--text);
}

.docs-subtitle {
	margin: 8px 0 0;
	color: var(--muted);
	font-size: 15px;
	line-height: 1.5;
}

.docs-links {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 14px;
}

.docs-link-card {
	display: grid;
	grid-template-columns: auto 1fr auto;
	align-items: center;
	gap: 15px;
	min-height: 98px;
	padding: 18px;
	text-align: left;
	color: var(--text);

	background:
		linear-gradient(180deg, rgba(26, 22, 38, 0.78), rgba(21, 18, 31, 0.68));
	border: 1px solid rgba(131, 93, 224, 0.19);
	border-radius: 15px;
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
	cursor: pointer;
	transition:
		transform 160ms ease,
		border-color 160ms ease,
		box-shadow 160ms ease,
		background 160ms ease;
}

.docs-link-card:hover {
	transform: translateY(-2px);
	background: rgba(29, 24, 42, 0.88);
	border-color: rgba(131, 93, 224, 0.3);
	box-shadow: none;
}

/* The section the current page belongs to: tinted and outlined in the accent, the same
   language the sidebar uses for its active link. */
.docs-link-card--active,
.docs-link-card--active:hover {
	background:
		linear-gradient(180deg, rgba(58, 40, 110, 0.72), rgba(38, 28, 74, 0.66));
	border-color: var(--accent, #7357ff);
	box-shadow: 0 0 0 1px var(--accent, #7357ff) inset;
}

.docs-link-card--active .chevron {
	color: var(--accent, #7357ff);
}

.link-icon {
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	color: var(--accent);
}

.link-copy {
	min-width: 0;
}

.link-copy strong,
.link-copy small {
	display: block;
}

.link-copy strong {
	font-size: 15px;
	line-height: 1.3;
	font-weight: 650;
	color: var(--text);
}

.link-copy small {
	margin-top: 6px;
	font-size: 12px;
	line-height: 1.4;
	color: var(--muted);
	/* Subtitles come from each section's own first sentence — clamp rather than let one
	   long one stretch its whole row of cards. */
	display: -webkit-box;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}

.chevron {
	width: 19px;
	height: 19px;
	color: #828596;
}

/* Light mode — driven by Quasar's body.body--light class, matching how
   GradientPanel / GradientButton / BlockNumber / AppFooter already theme. */
body.body--light .docs-link-card {
	background:
		linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(253, 253, 255, 0.68));
	border-color: var(--border);
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

body.body--light .docs-link-card:hover {
	background: rgba(255, 255, 255, 0.9);
	border-color: rgba(115, 87, 255, 0.25);
	box-shadow: 0 10px 28px rgba(55, 48, 99, 0.06);
}

body.body--light .docs-link-card--active,
body.body--light .docs-link-card--active:hover {
	background: rgba(115, 87, 255, 0.08);
	border-color: var(--accent, #7357ff);
	box-shadow: 0 0 0 1px var(--accent, #7357ff) inset;
}

/* Narrow screens: compact chips — icon and title only, two to a row. Six full cards stacked
   one per row pushed the docs themselves a screen and a half down on a phone. */
@media (max-width: 760px) {
	.docs-links {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.docs-link-card {
		grid-template-columns: auto minmax(0, 1fr);
		gap: 8px;
		min-height: 0;
		padding: 10px 12px;
		border-radius: 12px;
	}

	.docs-link-card:hover {
		transform: none;
	}

	.link-icon {
		width: 22px;
		height: 22px;
	}

	.link-icon :deep(.q-icon) {
		font-size: 20px !important;
	}

	/* Wraps rather than truncates — a clipped title ("Vector sear…") hides the one thing the
	   chip is for. Two lines at most. */
	.link-copy strong {
		font-size: 13.5px;
		line-height: 1.25;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}

	.link-copy small,
	.chevron {
		display: none;
	}

	.docs-title {
		font-size: 24px;
	}
}
</style>
