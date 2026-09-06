<template>
	<section class="gradient-section">
		<slot />
	</section>
</template>

<script>
export default {
	name: 'GradientSection',
}
</script>

<style scoped>
/* Dark is the BASE here, not an override. The app boots dark and Quasar writes
   body.body--light onto <body> only when the user picks light, so light-mode
   rules live at the bottom of this file keyed off that class. This matches
   GradientPanel / GradientButton / BlockNumber / AppFooter, and it is keyed off
   the body class rather than a $q.dark computed for the reason documented in
   GradientPanel.vue: the production bundle can end up with two Quasar instances
   (themed_varmory ships its own), desyncing $q.dark.isActive from the class. */
.gradient-section {
	--accent: #7357ff;
	--accent-2: #9a63ff;
	--text: #f3f1fb;
	--muted: #9994ac;
	--surface: rgba(22, 18, 36, 0.82);
	--surface-strong: rgba(26, 21, 42, 0.95);
	--border: rgba(131, 93, 224, 0.22);
	--border-strong: rgba(131, 93, 224, 0.28);
	--shadow: none;

	position: relative;
	display: grid;
	grid-template-columns: minmax(320px, 0.92fr) minmax(540px, 1.45fr);
	gap: 42px;
	align-items: center;
	width: 100%;
	padding: 12px 12px;
	box-sizing: border-box;
	overflow: hidden;

	background:
		radial-gradient(circle at 92% 10%, rgba(110, 62, 220, 0.09), transparent 24%),
		linear-gradient(180deg, rgba(20, 18, 30, 0.94), rgba(18, 16, 27, 0.92));
	border: 1px solid var(--border);
	border-radius: 18px;
	box-shadow: var(--shadow);
}

/* Slotted content needs its own `position: relative; z-index: 1` to sit
   above this — PageIntro and .docs-links already carry that themselves, so
   nothing extra is required here for content dropped into the slot. */
.gradient-section::after {
	content: '';
	position: absolute;
	inset: 0;
	pointer-events: none;
	background-image: radial-gradient(circle, rgba(115, 87, 255, 0.1) 1px, transparent 1px);
	background-size: 18px 18px;
	mask-image: linear-gradient(to left, rgba(0,0,0,.55), transparent 30%);
	opacity: 0.28;
}

body.body--light .gradient-section {
	--text: #171827;
	--muted: #6f7285;
	--surface: rgba(255, 255, 255, 0.76);
	--surface-strong: rgba(255, 255, 255, 0.92);
	--border: rgba(84, 73, 161, 0.15);
	--border-strong: rgba(84, 73, 161, 0.2);
	--shadow: 0 18px 48px rgba(43, 37, 83, 0.05);

	background:
		radial-gradient(circle at 92% 10%, rgba(115, 87, 255, 0.06), transparent 24%),
		linear-gradient(180deg, rgba(252, 252, 255, 0.96), rgba(249, 249, 253, 0.92));
}

@media (max-width: 1100px) {
	.gradient-section {
		grid-template-columns: 1fr;
		gap: 28px;
	}
}

@media (max-width: 760px) {
	.gradient-section {
		padding: 24px;
		border-radius: 16px;
	}
}
</style>
