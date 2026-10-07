<template>
	<button
		class="gradient-btn"
		:class="{
			'gradient-btn--no-caps': noCaps,
			'gradient-btn--rounded': rounded,
			'gradient-btn--round': round,
			'gradient-btn--outline': outline,
		}"
		type="button"
		:style="buttonStyle"
		:disabled="disable || loading"
		@click="$emit('click', $event)"
	>
		<span class="gradient-btn__shine" />

		<span class="gradient-btn__content">
			<template v-if="loading">
				<span class="gradient-btn__spinner" aria-hidden="true" />
				<span v-if="loadingLabel">{{ loadingLabel }}</span>
			</template>

			<template v-else>
				<slot>
					<q-icon v-if="icon" :name="icon" class="gradient-btn__icon" />
					<span v-if="label">{{ label }}</span>
					<q-icon v-if="iconRight" :name="iconRight" class="gradient-btn__icon" />
				</slot>
			</template>
		</span>
	</button>
</template>

<script>
// Named font sizes matching Quasar's QBtn exactly (its size map is
// {xs:8, sm:10, md:14, lg:20, xl:24} applied as font-size in px). Everything
// that scales (min-height, line-height, icon) is em-based off this.
const SIZES = {
	xs: '8px',
	sm: '10px',
	md: '14px',
	lg: '20px',
	xl: '24px',
};

export default {
	name: 'GradientButton',

	props: {
		label: {
			type: String,
			default: '',
		},
		// Shown next to the spinner while `loading`; empty → spinner only.
		loadingLabel: {
			type: String,
			default: '',
		},
		// A named size (xs/sm/md/lg/xl) or any CSS font-size (e.g. "20px").
		size: {
			type: String,
			default: 'md',
		},
		icon: {
			type: String,
			default: '',
		},
		iconRight: {
			type: String,
			default: '',
		},
		loading: {
			type: Boolean,
			default: false,
		},
		disable: {
			type: Boolean,
			default: false,
		},
		noCaps: {
			type: Boolean,
			default: true,
		},
		rounded: {
			type: Boolean,
			default: false,
		},
		// Circular icon-only button (matches QBtn's `round`): drops min-width and
		// padding for an equal-sided circle.
		round: {
			type: Boolean,
			default: false,
		},
		// A secondary/ghost treatment: subtle bordered fill instead of the solid
		// gradient — for a lower-emphasis action sitting next to a primary
		// GradientButton (e.g. "Explore" next to "Start Building").
		outline: {
			type: Boolean,
			default: false,
		},
	},

	emits: ['click'],

	computed: {
		buttonStyle: function() {
			return { fontSize: SIZES[this.size] || this.size };
		},
	},
}
</script>

<style scoped>
.gradient-btn {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;

	/* Box model matched to Quasar QBtn: min-height/line-height are em-based off
	 the size's font-size; padding and min-width are fixed px like QBtn. */
	min-width: 64px;
	min-height: 2.572em;
	padding: 4px 16px;

	overflow: hidden;
	cursor: pointer;

	color: #ffffff;
	font-family:
		Inter,
		system-ui,
		-apple-system,
		BlinkMacSystemFont,
		'Segoe UI',
		sans-serif;
	font-size: 14px;
	font-weight: 600;
	line-height: 1.715em;
	letter-spacing: -0.01em;

	/* Gradient border that blends with the fill (padding-box fills, border-box
	 shows the soft border gradient). */
	background:
		linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.18) 0%,
			rgba(255, 255, 255, 0) 45%
		) padding-box,
		linear-gradient(110deg, #5f42ff 0%, #7749ff 46%, #c44df2 100%) padding-box,
		linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.55) 0%,
			rgba(191, 164, 255, 0.35) 50%,
			rgba(196, 77, 242, 0.4) 100%
		) border-box;

	border: 1px solid transparent;
	border-radius: 0.66em;

	box-shadow:
		0 0 0 1px rgba(125, 91, 255, 0.28) inset,
		0 0 18px rgba(111, 73, 255, 0.48),
		0 8px 28px rgba(91, 49, 214, 0.42);

	transition:
		transform 160ms ease,
		box-shadow 160ms ease,
		filter 160ms ease;
}

.gradient-btn--rounded {
	border-radius: 999px;
}

/* Circular icon-only button, matched to QBtn's `round`. */
.gradient-btn--round {
	border-radius: 50%;
	padding: 0;
	min-width: 3em;
	min-height: 3em;
}

/* Ghost/secondary treatment: a plain translucent dark fill and a soft solid border
   instead of the primary's gradient fill + glow — sits quietly next to a primary
   GradientButton rather than competing with it. Selectors combine both classes
   (.gradient-btn.gradient-btn--outline, not just .gradient-btn--outline alone) so they
   reliably outrank .gradient-btn's own same-state rules on specificity — a bare single
   class here ties with .gradient-btn's own :hover rule and loses the tie to whichever one
   happens to sit later in the file, which is exactly how this went wrong the first time
   (hover background silently stayed the gradient because the plain-.gradient-btn hover
   rule was declared later and won the tie). */
.gradient-btn.gradient-btn--outline {
	background: rgba(10, 8, 24, 0.55);
	backdrop-filter: blur(12px);
	border-color: rgba(147, 127, 255, 0.48);
	box-shadow: none;
}

.gradient-btn--outline .gradient-btn__shine {
	display: none;
}

.gradient-btn.gradient-btn--outline:hover:not(:disabled) {
	background: rgba(0, 0, 0, 0.85);
	border-color: rgba(179, 162, 255, 0.8);
	box-shadow: none;
	filter: none;
}

.gradient-btn.gradient-btn--outline:active:not(:disabled) {
	box-shadow: none;
}

body.body--light .gradient-btn.gradient-btn--outline {
	/* The base .gradient-btn rule hardcodes white text (fine on a filled gradient in
	   either theme) — never overridden for light mode until now, which left this
	   variant's white text sitting on its own near-white background, unreadable. */
	color: var(--q-primary);
	background: rgba(255, 255, 255, 0.55);
	border-color: var(--q-primary);
	box-shadow: none;
}

body.body--light .gradient-btn.gradient-btn--outline:hover:not(:disabled) {
	background: rgba(255, 255, 255, 0.7);
	border-color: var(--q-primary);
	box-shadow: none;
}

.gradient-btn:not(.gradient-btn--no-caps) {
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.gradient-btn__content {
	position: relative;
	z-index: 2;

	display: inline-flex;
	gap: 0.6em;
	align-items: center;
	justify-content: center;
}

.gradient-btn__icon {
	font-size: 1.715em;
}

.gradient-btn__shine {
	position: absolute;
	top: -60%;
	left: -45%;

	width: 38%;
	height: 220%;

	pointer-events: none;

	background: linear-gradient(
		90deg,
		transparent,
		rgba(255, 255, 255, 0.24),
		transparent
	);

	transform: rotate(20deg);
	transition: left 500ms ease;
}

.gradient-btn:hover:not(:disabled) {
	filter: brightness(1.08);

	/* Brighten the gradient border on hover (fill layers unchanged). */
	background:
		linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.18) 0%,
			rgba(255, 255, 255, 0) 45%
		) padding-box,
		linear-gradient(110deg, #5f42ff 0%, #7749ff 46%, #c44df2 100%) padding-box,
		linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.85) 0%,
			rgba(221, 203, 255, 0.6) 50%,
			rgba(196, 77, 242, 0.6) 100%
		) border-box;

	box-shadow:
		0 0 0 1px rgba(161, 126, 255, 0.38) inset,
		0 0 24px rgba(123, 79, 255, 0.64),
		0 10px 34px rgba(102, 53, 225, 0.5);

	/* transform: translateY(-1px); */
}

.gradient-btn:hover:not(:disabled) .gradient-btn__shine {
	left: 125%;
}

.gradient-btn:active:not(:disabled) {
	box-shadow:
		0 0 0 1px rgba(125, 91, 255, 0.32) inset,
		0 0 13px rgba(111, 73, 255, 0.4),
		0 5px 18px rgba(91, 49, 214, 0.36);

	/* transform: translateY(1px) scale(0.99); */
}

.gradient-btn:focus-visible {
	outline: 2px solid #c9b7ff;
	outline-offset: 3px;
}

.gradient-btn:disabled {
	cursor: not-allowed;
	filter: saturate(0.5);
	opacity: 0.55;
}

/* Light mode (Quasar toggles body.body--light): drop the glow and use a solid
   primary-colored border instead of the soft gradient one. */
body.body--light .gradient-btn {
	box-shadow: none;
	background:
		linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.18) 0%,
			rgba(255, 255, 255, 0) 45%
		) padding-box,
		linear-gradient(110deg, #5f42ff 0%, #7749ff 46%, #c44df2 100%) padding-box,
		var(--q-primary) border-box;
}

body.body--light .gradient-btn:hover:not(:disabled) {
	box-shadow: none;
	background:
		linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.18) 0%,
			rgba(255, 255, 255, 0) 45%
		) padding-box,
		linear-gradient(110deg, #5f42ff 0%, #7749ff 46%, #c44df2 100%) padding-box,
		var(--q-primary) border-box;
}

.gradient-btn__spinner {
	width: 1em;
	height: 1em;

	border: 0.13em solid rgba(255, 255, 255, 0.35);
	border-top-color: #ffffff;
	border-radius: 50%;

	animation: gradient-btn-spin 700ms linear infinite;
}

@keyframes gradient-btn-spin {
	to {
		transform: rotate(360deg);
	}
}

@media (prefers-reduced-motion: reduce) {
	.gradient-btn,
	.gradient-btn__shine {
		transition: none;
	}

	.gradient-btn__spinner {
		animation-duration: 1400ms;
	}
}
</style>
