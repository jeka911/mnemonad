<template>
	<main class="logo-page" :class="{ 'logo-page--busy': saving }" @mouseenter="scramble" @click="scramble">
		<div
			class="logo-page__mark"
			role="button"
			tabindex="0"
			:aria-label="`${title} logo — click to save it as an animated PNG, shift-click for a GIF`"
			title="Click to save as animated PNG · Shift+click for GIF"
			@click="save"
			@keydown.enter.prevent="save"
		>
			<q-icon name="hexagon" class="logo-page__icon" />
			<h1 class="logo-page__title">
				<ScrambleText ref="title" :text="title" :charset="charset" :duration="1200" :tick-ms="45" />
			</h1>
		</div>
	</main>
</template>

<script>
import ScrambleText from '../components/ScrambleText.vue';
import { APP_TITLE } from '../settings.js';
import { renderLogoApng, renderLogoGif, downloadBlob, LOGO_SCRAMBLE_CHARSET } from './logoAnimation.js';

// The name's face. Monospace on purpose: every scrambling glyph then has the same width, so
// the name doesn't jitter while it resolves. Loaded by this page alone (a <link>, not a CSS
// @import, which Vite's CSS concatenation can leave somewhere a browser ignores it).
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Martian+Mono:wght@700;800&display=swap';
/** Resolves once the font's stylesheet is in (or failed) — its @font-face rules have to be
 *  registered before document.fonts.load() can fetch the face itself. */
function ensureFont() {
	const existing = document.querySelector(`link[href="${FONT_HREF}"]`);
	if (existing) return Promise.resolve();
	return new Promise((resolve) => {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = FONT_HREF;
		link.onload = link.onerror = () => resolve();
		document.head.appendChild(link);
	});
}

/**
 * Nothing but the mark: the hexagon and the name, alone in the window (`bare: true` drops
 * the app's header and footer — see pages/index.js). The name is ScrambleText, the same
 * effect as the nav, scrambling in once when the page opens and again on every hover or
 * click. Clicking the mark itself also saves the whole thing as an animated image (see
 * logoAnimation.js): an APNG by default, a GIF with Shift held — drawn from the live theme's
 * colors, so it matches what's on screen.
 */
export default {
	name: 'LogoPage',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/logo',
	title: 'Logo',
	bare: true,
	components: { ScrambleText },
	data() {
		return {
			title: APP_TITLE,
			charset: LOGO_SCRAMBLE_CHARSET,
			// True while an image is being built — one at a time.
			saving: false,
		};
	},
	mounted() {
		// ScrambleText shows its final text until start() — kick it off once the name's font
		// is in, so the first frame isn't drawn in a fallback font. Any failure along the way
		// still scrambles, just in the fallback.
		const run = () => this.scramble();
		ensureFont()
			.then(() => document.fonts?.load('800 1em "Martian Mono"'))
			.then(run, run);
	},
	methods: {
		scramble() {
			this.$refs.title?.start();
		},
		/** APNG (smooth transparent edges, full color); Shift for GIF (for places that only
		 *  take GIF). */
		async save(event) {
			if (this.saving) return;
			this.saving = true;
			const gif = !!event?.shiftKey;
			try {
				const params = { title: this.title, fontFamily: '"Martian Mono"' };
				const blob = gif ? await renderLogoGif(params) : await renderLogoApng(params);
				downloadBlob(blob, `${this.title.toLowerCase()}-logo.${gif ? 'gif' : 'png'}`);
			} catch (err) {
				console.error('Could not build the logo animation:', err);
			} finally {
				this.saving = false;
			}
		},
	},
};
</script>

<style scoped>
.logo-page {
	/* Black whatever the theme — a backdrop for the mark alone. Only the page: the saved
	   images keep their transparent background. */
	background: #000;
	/* Pinned to the window itself: even a bare page sits inside the layout's padded
	   container, which would otherwise leave a strip of the theme background around it. */
	position: fixed;
	inset: 0;
	overflow: auto;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	box-sizing: border-box;
	user-select: none;
	-webkit-user-select: none;
	cursor: default;
}

.logo-page--busy,
.logo-page--busy .logo-page__mark {
	cursor: progress;
}

.logo-page__mark {
	cursor: pointer;
	display: flex;
	border-radius: 16px;
}

.logo-page__mark:focus {
	outline: none;
}

.logo-page__mark:focus-visible {
	outline: 2px solid var(--q-primary);
	outline-offset: 12px;
}

.logo-page__mark {
	align-items: center;
	gap: clamp(12px, 2.5vw, 28px);
}

/* Same gradient as the header's logo mark (layout/Logo.vue), just larger. */
.logo-page__icon {
	font-size: clamp(56px, 11vw, 132px);
	background: linear-gradient(135deg, var(--q-primary) 0%, color-mix(in srgb, var(--q-primary) 55%, var(--q-accent)) 100%);
	-webkit-background-clip: text;
	background-clip: text;
	-webkit-text-fill-color: transparent;
	color: transparent;
}

.logo-page__title {
	margin: 0;
	font-size: clamp(40px, 9vw, 112px);
	font-weight: 700;
	line-height: 1;
	letter-spacing: 0.02em;
}

/* The name in the header logo's own text gradient (layout/Logo.vue) — scrambling characters
   included: the transparent text fill they inherit here outranks ScrambleText's own active
   color, so the scramble shows as changing glyphs, not a color change. */
.logo-page__title :deep(.scramble-text__chars) {
	font-family: 'Martian Mono', var(--font-mono, ui-monospace, monospace);
	font-weight: 800;
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
