<template>
	<div
		v-if="high"
		class="banner-row banner-row--high"
		:class="[`banner-row--${variant}`, { 'banner-row--active': active }]"
	>
		<div class="banner-row__dots" />
		<div class="banner-row__glow" />
		<div class="banner-high">
			<div v-if="title || $slots.default || $slots.icon || $slots.actions" class="banner-high__head">
				<div class="banner-row__hex">
					<slot name="icon">
						<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
							<polygon
								points="12,2 21,7 21,17 12,22 3,17 3,7"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linejoin="round"
							/>
						</svg>
					</slot>
				</div>
				<div class="banner-row__content">
					<div class="banner-row__content-main">
						<slot>
							<div v-if="title" style="display: flex; flex-direction: column; gap: 0px;">
								<strong>{{ title }}</strong>
								<span v-if="description" class="text-caption" style="opacity: 0.7;">{{ description }}</span>
							</div>
						</slot>
					</div>
					<div v-if="$slots.actions" class="banner-row__content-actions">
						<slot name="actions" />
					</div>
				</div>
			</div>
			<div class="banner-high__body">
				<slot name="body" />
			</div>
		</div>
		<q-inner-loading
			:showing="loading"
			color="primary"
			label-class="text-primary"
			class="banner-high__loading"
		/>
	</div>

	<div v-else-if="panel || alwaysExpanded" class="banner-panel" :class="{ 'banner-panel--dense': dense }">
		<div
			class="banner-row"
			:class="[
				`banner-row--${variant}`,
				{
					'banner-row--active': active,
					'banner-row--attached': isOpen,
					'banner-row--clickable': collapsible && !alwaysExpanded,
					'banner-row--dense': dense,
					'banner-row--inline': inline,
				},
			]"
			@click="collapsible && !alwaysExpanded && toggle()"
		>
			<div class="banner-row__dots" />
			<div class="banner-row__glow" />
			<div class="banner-row__hex">
				<slot name="icon">
					<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
						<polygon
							points="12,2 21,7 21,17 12,22 3,17 3,7"
							fill="none"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linejoin="round"
						/>
					</svg>
				</slot>
			</div>
			<div class="banner-row__content">
				<div class="banner-row__content-main">
					<slot>
						<div v-if="title" style="display: flex; flex-direction: column; gap: 0px;">
							<strong>{{ title }}</strong>
							<span v-if="description" class="text-caption" style="opacity: 0.7;">{{ description }}</span>
						</div>
					</slot>
				</div>
				<div v-if="$slots.actions" class="banner-row__content-actions">
					<slot name="actions" />
				</div>
			</div>
			<button
				v-if="collapsible && !alwaysExpanded"
				class="banner-row__toggle"
				:aria-expanded="isOpen ? 'true' : 'false'"
				aria-label="Toggle panel"
				@click.stop="toggle()"
			>
				<q-icon name="expand_more" size="22px" :style="{ transform: isOpen ? 'rotate(180deg)' : 'none' }" />
			</button>
		</div>

		<q-slide-transition>
			<div v-show="isOpen" class="banner-panel__body">
				<div class="banner-panel__body-inner">
					<slot name="body" />
					<q-inner-loading
						v-if="$slots.body"
						:showing="loading"
						color="primary"
						label-class="text-primary"
						class="banner-panel__loading"
					/>
				</div>
			</div>
		</q-slide-transition>
	</div>

	<div
		v-else
		class="banner-row"
		:class="[`banner-row--${variant}`, { 'banner-row--active': active, 'banner-row--dense': dense, 'banner-row--inline': inline }]"
	>
		<div class="banner-row__dots" />
		<div class="banner-row__glow" />
		<div class="banner-row__hex">
			<slot name="icon">
				<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
					<polygon
						points="12,2 21,7 21,17 12,22 3,17 3,7"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linejoin="round"
					/>
				</svg>
			</slot>
		</div>
		<div class="banner-row__content">
			<div class="banner-row__content-main">
				<slot>
					<div v-if="title" style="display: flex; flex-direction: column; gap: 0px;">
						<strong>{{ title }}</strong>
						<span v-if="description" class="text-caption" style="opacity: 0.7;">{{ description }}</span>
					</div>
				</slot>
			</div>
			<div v-if="$slots.actions" class="banner-row__content-actions">
				<slot name="actions" />
			</div>
		</div>
	</div>
</template>

<script>
export default {
	name: 'GradientPanel',
	props: {
		variant: {
			type: String,
			default: 'corner',
		},
		active: {
			type: Boolean,
			default: false,
		},
		panel: {
			type: Boolean,
			default: false,
		},
		collapsible: {
			type: Boolean,
			default: false,
		},
		// Panel that always shows its body: no toggle button, not clickable.
		// Implies panel mode, so `panel` need not be set separately.
		alwaysExpanded: {
			type: Boolean,
			default: false,
		},
		dense: {
			type: Boolean,
			default: false,
		},
		// Size the row to its content instead of filling the container width.
		inline: {
			type: Boolean,
			default: false,
		},
		// Overlay a q-inner-loading on the body slot while true.
		loading: {
			type: Boolean,
			default: false,
		},
		// Render as a single tall accented block (icon/title stacked above the
		// body, one gradient background) instead of the header + plain body split.
		high: {
			type: Boolean,
			default: false,
		},
		modelValue: {
			type: Boolean,
			default: true,
		},
		title: {
			type: String,
			default: '',
		},
		description: {
			type: String,
			default: '',
		},
	},
	emits: ['update:modelValue'],
	data() {
		return {
			localOpen: this.modelValue,
		};
	},
	computed: {
		isOpen: function() {
			if (this.alwaysExpanded) {
				return true;
			}
			return this.collapsible ? this.localOpen : true;
		},
	},
	watch: {
		modelValue: function(v) {
			this.localOpen = v;
		},
	},
	methods: {
		toggle: function() {
			this.localOpen = !this.localOpen;
			this.$emit('update:modelValue', this.localOpen);
		},
	},
};
</script>

<style scoped>
.banner-row {
	position: relative;
	display: flex;
	align-items: center;
	gap: 12px;
	height: 80px;
	padding: 0 24px 0 20px;
	border-radius: 12px;
	overflow: hidden;
	background: #100c22;
	border: 1px solid rgba(140, 120, 200, 0.1);
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
	isolation: isolate;
	font-family: var(--font-display);
}

.banner-row--clickable {
	cursor: pointer;
}

/* Size to content instead of filling the container. */
.banner-row--inline {
	display: inline-flex;
	width: fit-content;
}

/* Compact chip: snug, even horizontal inset for content-sized dense rows, with
   the icon→content gap matching the padding before the icon. */
.banner-row--inline.banner-row--dense {
	padding-left: 8px;
	padding-right: 8px;
	gap: 8px;
}

.banner-row--attached {
	/* Keep rounded corners on header even when panel is open */
}

/* High variant: a single tall accented block — icon/title header stacked above
   the body, all sharing one gradient background (no separate plain body). */
.banner-row--high {
	display: block;
	height: auto;
	padding: 0;
}

.banner-high {
	position: relative;
	z-index: 2;
}

.banner-high__head {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 16px 24px 0 20px;
}

.banner-high__body {
	position: relative;
	padding: 12px 24px 20px 20px;
	color: var(--q-text, #c8d6e5);
	font-family: var(--font-body, system-ui, sans-serif);
}

/* In high mode the overlay covers the whole block (header included), so it must
   sit above .banner-high (z-index 2). */
.banner-high__loading {
	z-index: 5;
}

body.body--light .banner-high__body {
	color: #2a2440;
}

/* Compact variant: half the row height with a smaller icon. */
.banner-row--dense {
	height: 40px;
	padding-left: 16px;
}

.banner-row--dense .banner-row__hex {
	width: 30px;
	height: 30px;
}

.banner-row--dense .banner-row__hex svg {
	width: 20px;
	height: 20px;
}

.banner-row--dense .banner-row__content-main strong,
.banner-row--dense .banner-row__content-main .text-caption {
	line-height: 0.8rem;
}

.banner-row--dense .banner-row__toggle {
	width: 28px;
	height: 28px;
}

.banner-panel--dense .banner-panel__body-inner {
	padding-top: var(--q-gap-sm, 10px);
	padding-bottom: var(--q-gap-sm, 10px);
}

.banner-row__dots {
	position: absolute;
	inset: 0;
	background-image: radial-gradient(rgba(180, 170, 220, 0.16) 1px, transparent 1.4px);
	background-size: 15px 15px;
	background-position: 6px 6px;
	opacity: 0.5;
	pointer-events: none;
	z-index: 1;
}

.banner-row__glow {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 0;
}

.banner-row__hex {
	position: relative;
	flex-shrink: 0;
	width: 44px;
	height: 44px;
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 3;
	color: #8b5cf6;
	filter: drop-shadow(0 0 6px currentColor);
}

.banner-row__content {
	position: relative;
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	z-index: 2;
	color: var(--q-text, #c8d6e5);
	font-family: var(--font-display);
}

.banner-row__content-main {
	min-width: 0;
}

.banner-row__content-actions {
	display: flex;
	align-items: center;
	flex-shrink: 0;
	gap: 4px;
}

.banner-row__toggle {
	position: relative;
	flex-shrink: 0;
	z-index: 4;
	/* Pull toward the edge so it sits ~14px in despite the row's 24px padding. */
	margin-right: -10px;
	width: 34px;
	height: 34px;
	display: flex;
	align-items: center;
	justify-content: center;
	border: none;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.06);
	color: var(--q-text, #c8d6e5);
	cursor: pointer;
	transition: background var(--q-transition-fast, 0.15s);
}

.banner-row__toggle:hover {
	background: rgba(255, 255, 255, 0.14);
}

.banner-row__toggle :deep(.q-icon) {
	transition: transform var(--q-transition-normal, 0.25s);
}

/* Panel body */
.banner-panel {
	border-radius: 12px;
}

.banner-panel__body {
	background: #0e0a1e;
	border: 1px solid rgba(140, 120, 200, 0.1);
	border-top: none;
	border-bottom-left-radius: 12px;
	border-bottom-right-radius: 12px;
	overflow: hidden;
	margin-top: -12px;
	padding-top: 11px;
}

.banner-panel__body-inner {
	padding: var(--q-gap-md, 16px) var(--q-gap-lg, 24px);
	color: var(--q-text, #c8d6e5);
	font-family: var(--font-body, system-ui, sans-serif);
	position: relative;
}

body.body--light .banner-panel__body {
	background: #f4f3f9;
	border-color: rgba(60, 40, 110, 0.12);
}

body.body--light .banner-panel__body-inner {
	color: #2a2440;
}

.banner-panel__loading {
	margin-top: 1px;
}

body.body--light .banner-row__toggle {
	background: rgba(40, 30, 80, 0.06);
	color: #2a2440;
}

body.body--light .banner-row__toggle:hover {
	background: rgba(40, 30, 80, 0.14);
}

/* Variant: corner */
.banner-row--corner .banner-row__glow {
	background: radial-gradient(120% 180% at 100% 0%, rgba(196, 92, 214, 0.55) 0%, rgba(150, 70, 190, 0.18) 26%, transparent 46%);
}

.banner-row--corner .banner-row__hex {
	color: #9d6bd6;
}

/* Variant: streak */
.banner-row--streak .banner-row__glow {
	background:
		linear-gradient(120deg, transparent 62%, rgba(150, 128, 220, 0.4) 78%, rgba(120, 100, 200, 0.08) 85%, transparent 92%),
		radial-gradient(60% 200% at 98% 15%, rgba(120, 96, 190, 0.26) 0%, transparent 50%);
}

.banner-row--streak .banner-row__hex {
	color: #7d6cae;
}

/* Variant: fill */
.banner-row--fill .banner-row__glow {
	background: linear-gradient(90deg, transparent 30%, rgba(70, 64, 190, 0.3) 62%, rgba(88, 78, 235, 0.62) 100%);
}

.banner-row--fill .banner-row__hex {
	color: #6d6cf0;
}

/* Variant: pink */
.banner-row--pink {
	border-color: rgba(220, 130, 200, 0.3);
}

.banner-row--pink .banner-row__glow {
	background:
		linear-gradient(90deg, transparent 24%, rgba(150, 70, 150, 0.34) 55%, rgba(214, 120, 170, 0.3) 78%, transparent 101%),
		radial-gradient(90% 150% at 92% 88%, rgba(250, 180, 170, 0.62) 0%, rgba(230, 130, 170, 0.3) 30%, transparent 55%);
}

.banner-row--pink .banner-row__hex {
	color: #f4587a;
}

/* Variant: beam */
.banner-row--beam .banner-row__glow {
	background:
		linear-gradient(52deg, transparent 62%, rgba(70, 150, 230, 0.4) 76%, rgba(90, 170, 250, 0.08) 84%, transparent 92%),
		radial-gradient(55% 200% at 100% 55%, rgba(50, 110, 210, 0.26) 0%, transparent 55%);
}

.banner-row--beam .banner-row__hex {
	color: #5b82d8;
}

/* Variant: teal */
.banner-row--teal .banner-row__glow {
	background: linear-gradient(90deg, transparent 34%, rgba(20, 120, 130, 0.34) 66%, rgba(35, 200, 190, 0.55) 100%);
}

.banner-row--teal .banner-row__hex {
	color: #2fd6c0;
}

/* Light mode — driven by Quasar's body.body--light class (written reliably to
   <body>), not a JS $q.dark computed. The production bundle can end up with two
   Quasar instances (themed_varmory ships its own), desyncing the app's
   $q.dark.isActive from the body class; keying off the class sidesteps that and
   matches how GradientButton / BlockNumber / AppFooter already theme. */
body.body--light .banner-row {
	background: #eef0f7;
	border-color: rgba(60, 40, 110, 0.12);
	box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
}

body.body--light .banner-row__dots {
	background-image: radial-gradient(rgba(70, 55, 120, 0.18) 1px, transparent 1.4px);
	opacity: 0.55;
}

body.body--light .banner-row__content {
	color: #2a2440;
}

body.body--light .banner-row--corner .banner-row__glow {
	background: radial-gradient(120% 180% at 100% 0%, rgba(196, 92, 214, 0.6) 0%, rgba(170, 90, 210, 0.2) 28%, transparent 48%);
}

body.body--light .banner-row--streak .banner-row__glow {
	background:
		linear-gradient(120deg, transparent 62%, rgba(140, 110, 220, 0.45) 78%, rgba(120, 100, 200, 0.1) 85%, transparent 92%),
		radial-gradient(60% 200% at 98% 15%, rgba(130, 100, 210, 0.28) 0%, transparent 50%);
}

body.body--light .banner-row--fill .banner-row__glow {
	background: linear-gradient(90deg, transparent 30%, rgba(90, 82, 220, 0.3) 62%, rgba(99, 90, 240, 0.55) 100%);
}

body.body--light .banner-row--pink {
	border-color: rgba(220, 100, 160, 0.35);
}

body.body--light .banner-row--pink .banner-row__glow {
	background:
		linear-gradient(90deg, transparent 24%, rgba(200, 110, 180, 0.3) 55%, rgba(240, 140, 180, 0.34) 78%, transparent 101%),
		radial-gradient(90% 150% at 92% 88%, rgba(255, 180, 165, 0.7) 0%, rgba(240, 140, 175, 0.34) 30%, transparent 55%);
}

body.body--light .banner-row--beam .banner-row__glow {
	background:
		linear-gradient(52deg, transparent 62%, rgba(70, 150, 230, 0.45) 76%, rgba(90, 170, 250, 0.1) 84%, transparent 92%),
		radial-gradient(55% 200% at 100% 55%, rgba(60, 120, 220, 0.28) 0%, transparent 55%);
}

body.body--light .banner-row--teal .banner-row__glow {
	background: linear-gradient(90deg, transparent 34%, rgba(30, 170, 165, 0.32) 66%, rgba(35, 205, 190, 0.55) 100%);
}
</style>
