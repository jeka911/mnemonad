<template>
	<div class="jShowcase_row jShowcase_column">
		<div class="jShowcase_info">
			<p>
				Gradient-filled button with a shine sweep on hover and a glow shadow in dark mode.
				Mirrors the <a class="jShowcase_infoLink" href="#Buttons/Btn">QBtn</a> API — accepts
				<code>label</code>, <code>size</code>, <code>icon</code>, <code>iconRight</code>,
				<code>loading</code> and <code>disable</code>.
			</p>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Default</span>
			<div class="jShowcase_items">
				<GradientButton label="Send" />
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">Sizes</span>
			<div class="jShowcase_items">
				<GradientButton label="XS" size="xs" />
				<GradientButton label="SM" size="sm" />
				<GradientButton label="MD" size="md" />
				<GradientButton label="LG" size="lg" />
				<GradientButton label="XL" size="xl" />
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">With icons</span>
			<div class="jShowcase_items">
				<GradientButton label="Deploy" icon="rocket_launch" />
				<GradientButton label="Open" icon-right="open_in_new" />
				<GradientButton icon="favorite" />
				<GradientButton icon="favorite" round />
			</div>
		</div>

		<div class="jShowcase_group">
			<span class="jShowcase_title">States</span>
			<div class="jShowcase_items">
				<GradientButton label="Loading" loading />
				<GradientButton label="Saving" loading loading-label="Saving…" />
				<GradientButton label="Disabled" disable />
				<GradientButton label="Rounded" rounded />
			</div>
		</div>
	</div>
</template>

<script>
import GradientButton from '../components/GradientButton.vue';

export default {
	name: 'ShowcaseGradientButton',
	components: { GradientButton },
	label: 'GradientButton',
	icon: 'smart_button',
	importName: 'GradientButton',
	importFrom: './GradientButton.vue',
	apiJson: {
		props: {
			label: {
				type: 'String',
				desc: 'Text shown on the button. Ignored when the default slot is used.',
				default: "''",
				examples: ['Send', 'Connect Wallet'],
			},
			size: {
				type: 'String',
				desc: 'Named size (xs/sm/md/lg/xl) or any CSS font-size. Everything else (padding, radius, icon, spinner) is em-based, so the whole button scales with it.',
				default: "'md'",
				values: ['xs', 'sm', 'md', 'lg', 'xl', "'20px'", "'1.2rem'"],
				examples: ['sm', '18px'],
			},
			icon: {
				type: 'String',
				desc: 'Name of a Quasar/Material icon rendered before the label.',
				default: "''",
				examples: ['rocket_launch', 'send'],
			},
			iconRight: {
				type: 'String',
				desc: 'Name of a Quasar/Material icon rendered after the label.',
				default: "''",
				examples: ['open_in_new', 'arrow_forward'],
			},
			loading: {
				type: 'Boolean',
				desc: 'Shows an animated spinner and disables the button. Replaces the label with the spinner (plus loadingLabel if set).',
				default: 'false',
			},
			loadingLabel: {
				type: 'String',
				desc: 'Text shown next to the spinner while loading. Empty → spinner only.',
				default: "''",
				examples: ['Saving…', 'Sending…'],
			},
			disable: {
				type: 'Boolean',
				desc: 'Puts the button in a non-interactive, dimmed/desaturated state.',
				default: 'false',
			},
			noCaps: {
				type: 'Boolean',
				desc: 'Keeps the label as written. When false, the label is uppercased with extra letter-spacing.',
				default: 'true',
			},
			rounded: {
				type: 'Boolean',
				desc: 'Uses a fully pill-shaped border radius instead of the default rounded corners.',
				default: 'false',
			},
			round: {
				type: 'Boolean',
				desc: 'Circular icon-only button (matches QBtn round): drops min-width and padding for an equal-sided circle.',
				default: 'false',
			},
		},
		slots: {
			default: {
				desc: 'Custom button content, replacing the icon/label/iconRight rendering. Not shown while loading.',
			},
		},
		events: {
			click: {
				desc: 'Emitted when the button is clicked. Not emitted while disabled or loading.',
				params: {
					evt: {
						type: 'Event',
						desc: 'The native click MouseEvent.',
					},
				},
			},
		},
	},
};
</script>
