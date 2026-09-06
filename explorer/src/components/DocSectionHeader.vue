<template>
	<GradientSection>
		<PageIntro
			icon="o_description"
			search-placeholder="Search documentation..."
			@search="$emit('search', $event)"
		>
			<h1 class="docs-title">Docs</h1>
			<p class="docs-subtitle">
				Everything you need to build with Mnemonad
			</p>
		</PageIntro>

		<div class="docs-links">
			<button
				v-for="item in items"
				:key="item.key"
				class="docs-link-card"
				type="button"
				@click="$emit('navigate', item.key)"
			>
				<span class="link-icon" :class="`icon-${item.key}`" aria-hidden="true">
					<svg v-if="item.key === 'guides'" viewBox="0 0 24 24" fill="none">
						<path
							d="M4.25 5.5c2.8-.95 5.05-.55 7 1.1v11.15c-1.95-1.65-4.2-2.05-7-1.1V5.5Z"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linejoin="round"
						/>
						<path
							d="M19.75 5.5c-2.8-.95-5.05-.55-7 1.1v11.15c1.95-1.65 4.2-2.05 7-1.1V5.5Z"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linejoin="round"
						/>
					</svg>

					<svg v-else-if="item.key === 'api'" viewBox="0 0 24 24" fill="none">
						<path
							d="M8.5 4.25H7.2c-1.25 0-2.2.95-2.2 2.2v2.3c0 1.05-.6 1.8-1.75 2.25 1.15.45 1.75 1.2 1.75 2.25v2.3c0 1.25.95 2.2 2.2 2.2h1.3"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
						/>
						<path
							d="M15.5 4.25h1.3c1.25 0 2.2.95 2.2 2.2v2.3c0 1.05.6 1.8 1.75 2.25-1.15.45-1.75 1.2-1.75 2.25v2.3c0 1.25-.95 2.2-2.2 2.2h-1.3"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
						/>
					</svg>

					<svg v-else viewBox="0 0 24 24" fill="none">
						<path
							d="m8.5 6-5 6 5 6M15.5 6l5 6-5 6M13.5 4.5l-3 15"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
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

	emits: ['search', 'navigate'],

	data () {
		return {
			items: [
				{
					key: 'guides',
					title: 'Guides',
					subtitle: 'Step-by-step tutorials'
				},
				{
					key: 'api',
					title: 'API Reference',
					subtitle: 'Contract & endpoints'
				},
				{
					key: 'examples',
					title: 'Examples',
					subtitle: 'Real-world code'
				}
			]
		}
	}
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

.link-icon {
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	color: var(--accent);
}

.link-icon svg {
	width: 30px;
	height: 30px;
}

.icon-examples {
	color: #5e7bff;
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

@media (max-width: 760px) {
	.docs-links {
		grid-template-columns: 1fr;
	}

	.docs-title {
		font-size: 24px;
	}
}
</style>
