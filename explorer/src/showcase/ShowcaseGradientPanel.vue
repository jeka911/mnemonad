<template>
	<div class="jShowcase_row jShowcase_column">
		<div class="jShowcase_info">
			<p>
				Banner-style panel with six gradient <code>variant</code>s, an optional
				<code>title</code>/<code>description</code>, an <code>actions</code> slot,
				a custom <code>icon</code> slot, and a collapsible <code>panel</code> mode.
			</p>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Variants</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel variant="corner" title="Corner" description="Magenta glow top-right" />
				<GradientPanel variant="streak" title="Streak" description="Lavender diagonal accent" />
				<GradientPanel variant="fill" title="Fill" description="Indigo/blue fill on right" />
				<GradientPanel variant="pink" title="Pink" description="Active pink/peach glow" />
				<GradientPanel variant="beam" title="Beam" description="Blue diagonal beam" />
				<GradientPanel variant="teal" title="Teal" description="Teal fill on right" />
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Dense</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel dense variant="corner" title="Corner" description="Compact row, half height" />
				<GradientPanel dense variant="beam" title="Ready to Deploy">
					<template #actions>
						<GradientButton label="Deploy" size="xs" />
					</template>
				</GradientPanel>
				<GradientPanel dense variant="teal" panel collapsible title="Verdant Core" description="Compact collapsible header">
					<template #body>
						Dense panels keep the same body, just a tighter header.
					</template>
				</GradientPanel>
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">With actions</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel variant="beam" title="Ready to Deploy" description="All tests passing, ready for production">
					<template #actions>
						<GradientButton label="Deploy" size="sm" />
					</template>
				</GradientPanel>
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Custom icon</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel variant="pink">
					<template #icon>
						<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
							<polygon
								points="12,2 15,10 23,10 17,15 19,23 12,18 5,23 7,15 1,10 9,10"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linejoin="round"
							/>
						</svg>
					</template>
					<strong>Custom Icon:</strong> Star SVG with pink variant
				</GradientPanel>
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Collapsible panel</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel variant="teal" panel collapsible title="Verdant Core" description="Click the header or chevron to toggle">
					<template #body>
						This panel body expands and collapses with a slide transition.
					</template>
				</GradientPanel>
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Always expanded</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel variant="fill" always-expanded title="Network Details" description="Body always visible — no toggle">
					<template #body>
						This body is always shown: no chevron, header not clickable.
					</template>
				</GradientPanel>
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Loading body</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel variant="beam" always-expanded :loading="loadingDemo" title="Fetching Data" description="Toggle the checkbox to show/hide the spinner">
					<template #actions>
						<q-checkbox v-model="loadingDemo" label="Loading" dense color="primary" />
					</template>
					<template #body>
						<div style="min-height: 60px;">This body content is covered by a q-inner-loading spinner while <code>loading</code> is true.</div>
					</template>
				</GradientPanel>
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">High</span>
			<div class="jShowcase_items jShowcase_column">
				<GradientPanel variant="corner" high title="Sector Overview" description="Single tall accented block">
					<template #body>
						<div>
							<p>The whole panel is one accented surface — the icon and title sit above this body over the same gradient, with no separate header/body split.</p>
							<p>The whole panel is one accented surface — the icon and title sit above this body over the same gradient, with no separate header/body split.</p>
							<p>The whole panel is one accented surface — the icon and title sit above this body over the same gradient, with no separate header/body split.</p>
						</div>
					</template>
				</GradientPanel>

				<GradientPanel variant="beam" high loading title="Syncing Sector" description="Loading covers the whole block">
					<template #body>
						<div style="min-height: 120px;">
							<p>In high mode the spinner overlays the entire panel — header included — while <code>loading</code> is true.</p>
						</div>
					</template>
				</GradientPanel>

				<GradientPanel variant="teal" high :loading="demoLoading">
					<template #body>
						<div style="position: relative; min-height: 100px;">
							<p>Body only — no icon, title or actions. Just content over the accented block.</p>
							<GradientButton label="Load 3s" size="sm" @click="runLoading" style="position: absolute; right: 0; bottom: 0;" />
						</div>
					</template>
				</GradientPanel>
			</div>
		</div>
	</div>
</template>

<script>
import GradientPanel from '../components/GradientPanel.vue';
import GradientButton from '../components/GradientButton.vue';

export default {
	name: 'ShowcaseGradientPanel',
	components: { GradientPanel, GradientButton },
	label: 'GradientPanel',
	icon: 'view_agenda',
	importName: 'GradientPanel',
	importFrom: './GradientPanel.vue',
	data() {
		return {
			loadingDemo: true,
			demoLoading: false,
		};
	},
	methods: {
		runLoading: function() {
			this.demoLoading = true;
			setTimeout(() => {
				this.demoLoading = false;
			}, 3000);
		},
	},
	apiJson: {
		props: {
			variant: {
				type: 'String',
				desc: 'Gradient/glow treatment applied to the panel background and hex icon.',
				default: "'corner'",
				values: ['corner', 'streak', 'fill', 'pink', 'beam', 'teal'],
				examples: ['beam', 'teal'],
			},
			title: {
				type: 'String',
				desc: 'Bold heading shown in the content area when no default slot is provided.',
				default: "''",
				examples: ['Ready to Deploy'],
			},
			description: {
				type: 'String',
				desc: 'Secondary muted line shown beneath the title. Only rendered when title is set.',
				default: "''",
				examples: ['All tests passing, ready for production'],
			},
			active: {
				type: 'Boolean',
				desc: 'Marks the panel as active, intensifying its accent styling.',
				default: 'false',
			},
			panel: {
				type: 'Boolean',
				desc: 'Enables panel mode: the row becomes a header with an attached, expandable body (see the body slot).',
				default: 'false',
			},
			collapsible: {
				type: 'Boolean',
				desc: 'In panel mode, adds a chevron toggle and makes the whole header clickable to expand/collapse the body.',
				default: 'false',
			},
			alwaysExpanded: {
				type: 'Boolean',
				desc: 'Panel whose body is always shown — no toggle button, header not clickable. Implies panel mode.',
				default: 'false',
			},
			dense: {
				type: 'Boolean',
				desc: 'Compact layout: halves the row height and shrinks the icon. Horizontal paddings are unchanged.',
				default: 'false',
			},
			loading: {
				type: 'Boolean',
				desc: 'Overlays a q-inner-loading spinner on the body slot while true (panel mode with a body slot).',
				default: 'false',
			},
			high: {
				type: 'Boolean',
				desc: 'Render as a single tall accented block — icon/title stacked above the body over one gradient — instead of the header + plain body split.',
				default: 'false',
			},
			modelValue: {
				type: 'Boolean',
				desc: 'v-model for the open/collapsed state in collapsible panel mode. True = expanded.',
				default: 'true',
			},
		},
		slots: {
			default: {
				desc: 'Main content of the row. Overrides the title/description rendering.',
			},
			icon: {
				desc: 'Custom icon markup (e.g. an inline SVG) replacing the default hexagon.',
			},
			actions: {
				desc: 'Right-aligned content in the header row, e.g. a button or icon buttons.',
			},
			body: {
				desc: 'Expandable body content shown below the header when panel is enabled.',
			},
		},
		events: {
			'update:modelValue': {
				desc: 'Emitted when the collapsible panel is toggled via the header or chevron.',
				params: {
					open: {
						type: 'Boolean',
						desc: 'The new open state (true = expanded).',
					},
				},
			},
		},
	},
};
</script>

<style scoped>
/* Let the panels use the full width of the showcase column. */
.jShowcase_items.jShowcase_column {
	display: flex;
	flex-direction: column;
	gap: 12px;
	width: 100%;
}
.jShowcase_items.jShowcase_column > * {
	width: 100%;
}
</style>
