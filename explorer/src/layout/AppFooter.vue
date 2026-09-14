<template>
	<footer class="appFooter">
		<div class="appFooter_inner">
			<!-- brand -->
			<Logo class="appFooter_brand" />
			<span class="appFooter_copy">© {{ currentYear }}</span>

			<span class="appFooter_divider"></span>

			<!-- nav -->
			<nav class="appFooter_nav">
				<router-link to="/" class="appFooter_link" @mouseenter="scramble('home')"><ScrambleText ref="home" text="Home" /></router-link>
				<router-link to="/showcase" class="appFooter_link" @mouseenter="scramble('components')"><ScrambleText ref="components" text="Components" /></router-link>
				<router-link to="/docs" class="appFooter_link" @mouseenter="scramble('docs')"><ScrambleText ref="docs" text="Docs" /></router-link>
				<a :href="explorerUrl" class="appFooter_link" @mouseenter="scramble('explorer')"><ScrambleText ref="explorer" text="Explorer" /><q-icon name="north_east" size="14px" class="appFooter_ext" /></a>
				<a v-if="faucetUrl" :href="faucetUrl" class="appFooter_link" @mouseenter="scramble('faucet')"><ScrambleText ref="faucet" text="Faucet" /><q-icon name="north_east" size="14px" class="appFooter_ext" /></a>
				<a href="https://x.com/suidouble" class="appFooter_link appFooter_link--x">𝕏<q-icon name="north_east" size="14px" class="appFooter_ext" /></a>

			</nav>

			<span class="appFooter_spacer"></span>

			<!-- right side -->
			<span class="appFooter_version">v0.1.0-alpha</span>
			<div class="appFooter_status">
				<q-icon name="verified" size="16px" class="appFooter_statusIcon" />
				<span>All systems operational</span>
			</div>
		</div>
	</footer>
</template>

<script>
import Logo from './Logo.vue';
import ScrambleText from '../components/ScrambleText.vue';
import { getActiveNetwork } from '../settings.js';

export default {
	name: 'AppFooter',
	components: {
		Logo,
		ScrambleText,
	},
	data() {
		const network = getActiveNetwork();
		return {
			explorerUrl: network.chain.blockExplorers.default.url,
			faucetUrl: network.faucetUrl,
		};
	},
	computed: {
		currentYear: function() {
			return new Date().getFullYear();
		},
	},
	methods: {
		// ScrambleText drives its own tick loop (and its own prefers-reduced-motion
		// check) internally — this just fires it off, no state to track here.
		scramble(ref) {
			this.$refs[ref]?.start();
		},
	},
};
</script>

<style scoped>
.appFooter {
	--footer-link: var(--q-primary);
	--footer-link-hover: color-mix(in srgb, var(--q-primary) 70%, white);
	--footer-bg: var(--q-surface-1);
	--footer-muted: var(--q-text-muted);
	--footer-border: var(--q-surface-border);
	--footer-pill-bg: color-mix(in srgb, var(--q-surface-2) 55%, transparent);
	--footer-pill-border: var(--q-surface-border);
	--footer-text: var(--q-text);
	--footer-ok: var(--q-positive);
	width: 100%;
	background: var(--footer-bg);
	border-top: 1px solid var(--footer-border);
	font-family: var(--font-body, system-ui, sans-serif);
}

body.body--light .appFooter {
	--footer-link-hover: color-mix(in srgb, var(--q-primary) 70%, black);
}

.appFooter_inner {
	display: flex;
	align-items: center;
	gap: var(--q-gap-lg, 24px);
	padding: 14px 32px;
	min-height: 72px;
	flex-wrap: wrap;
	line-height: 1;
}

.appFooter_brand {
	transform: scale(0.78);
	transform-origin: left center;
}

/* Below 1100px: hide version and status, reflow into 3 rows (logo, copyright, links). */
@media (max-width: 1300px) {
	.appFooter_status {
		display: none !important;
	}
	
}

/* Below 1100px: hide version and status, reflow into 3 rows (logo, copyright, links). */
@media (max-width: 1100px) {
	.appFooter_inner {
		flex-direction: column;
		gap: 12px;
		padding: 16px 32px;
		justify-content: center;
		align-items: stretch;
	}

	.appFooter_brand {
		order: 1;
		transform: scale(0.78);
		margin: 0 auto;
		width: fit-content;
		align-self: center;
		transform-origin: center center;
	}

	.appFooter_copy {
		order: 2;
		text-align: center;
		align-self: center;
	}

	.appFooter_divider,
	.appFooter_spacer,
	.appFooter_version,
	.appFooter_status {
		display: none !important;
	}

	.appFooter_nav {
		order: 3;
		flex: 1 1 auto;
		justify-content: center;
	}

	.appFooter_nav:first-of-type {
		order: 30;
	}

	.appFooter_nav:last-of-type {
		order: 31;
	}
}

@media (max-width: 680px) {
	.appFooter_inner {
		padding: 14px 16px;
	}
}

.appFooter_copy {
	font-size: 13px;
	line-height: 1;
	color: var(--footer-muted);
}

.appFooter_divider {
	width: 1px;
	height: 26px;
	background: var(--footer-border);
}

.appFooter_nav {
	display: flex;
	align-items: center;
	gap: var(--q-gap-lg, 24px);
}
.appFooter_link {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	line-height: 1;
	color: var(--footer-link);
	text-decoration: none;
	font-size: 15px;
	font-weight: 500;
	transition: color var(--q-transition-fast, 0.15s);
}
.appFooter_link :deep(.q-icon) { display: block; }
.appFooter_link:hover { color: var(--footer-link-hover); }
.appFooter_ext { opacity: 0.85; }
.appFooter_link--x { font-size: 17px; }
.appFooter_dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: var(--footer-ok);
	margin-left: 4px;
	box-shadow: 0 0 6px var(--footer-ok);
}

.appFooter_spacer { flex: 1 1 auto; }

.appFooter_version {
	font-family: var(--font-mono, monospace);
	font-size: 13px;
	line-height: 1;
	color: var(--footer-text);
	padding: 8px 14px;
	border: 1px solid var(--footer-pill-border);
	border-radius: 8px;
	background: var(--footer-pill-bg);
}

.appFooter_status {
	display: flex;
	align-items: center;
	gap: 8px;
	line-height: 1;
	font-size: 14px;
	color: var(--footer-text);
	padding: 8px 14px;
	border: 1px solid var(--footer-pill-border);
	border-radius: 8px;
	background: var(--footer-pill-bg);
}
.appFooter_statusIcon { color: var(--footer-ok); }
</style>
