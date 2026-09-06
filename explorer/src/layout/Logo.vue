<template>
	<h1 class="logo">
		<q-icon name="hexagon" class="logo-icon" />
		<span class="logo-text">{{ appTitle }}</span>
	</h1>
</template>

<script>
import { APP_TITLE } from '../settings.js';

export default {
	name: 'AppLogo',
	data() {
		return {
			appTitle: APP_TITLE,
		};
	},
};
</script>

<style scoped>
.logo {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
	line-height: 1.2;
	white-space: nowrap;
	user-select: none;
	-webkit-user-select: none;
}

.logo-icon {
	font-size: clamp(22px, 5vw, 28px);
	background: linear-gradient(135deg, var(--q-primary) 0%, color-mix(in srgb, var(--q-primary) 55%, var(--q-accent)) 100%);
	-webkit-background-clip: text;
	background-clip: text;
	-webkit-text-fill-color: transparent;
	color: transparent;
}

.logo-text {
	font-family: var(--font-display);
	font-size: clamp(18px, 4vw, 24px);
	font-weight: 700;
	letter-spacing: -0.01em;
	white-space: nowrap;
	background: linear-gradient(135deg,
		color-mix(in srgb, var(--q-primary) 80%, white) 0%,
		var(--q-primary) 45%,
		color-mix(in srgb, var(--q-primary) 60%, var(--q-accent)) 100%);
	-webkit-background-clip: text;
	background-clip: text;
	-webkit-text-fill-color: transparent;
	color: transparent;
}
</style>
