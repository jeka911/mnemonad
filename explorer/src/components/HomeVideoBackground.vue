<template>
	<div class="home-video-bg" aria-hidden="true">
		<video
			ref="video"
			class="home-video-bg__video"
			:src="src"
			muted
			playsinline
			preload="auto"
		/>
	</div>
</template>

<script>
/**
 * Full-viewport video backdrop for the homepage — fixed behind all page content (header,
 * footer, the "My streams" panel), visible wherever that content doesn't fully cover it
 * (the page's own padding/gutters), rather than confined to Home.vue's own content box.
 *
 * Starts paused on its first frame; plays through to the end exactly once, triggered by
 * the page's first mouse movement, then stays on its last frame — not a `loop`ing
 * ambient background, a one-shot reveal.
 *
 * Deliberately its own component rather than inline in Home.vue: `position: fixed` needs
 * to escape `.app-container`'s padding to actually reach every edge of the viewport, and
 * keeping the play-once/reduced-motion handling isolated here means Home.vue itself stays
 * just markup, no lifecycle logic of its own.
 */
export default {
	name: 'HomeVideoBackground',
	props: {
		/** Public path to the video — served as-is from explorer/public, not bundled. */
		src: {
			type: String,
			default: '/video/generated-video-mnemonad.mp4',
		},
	},
	mounted() {
		const el = this.$refs.video;
		if (!el) return;
		// Autoplay-with-sound-off policies check the live `muted` property, not just the
		// attribute — belt and suspenders alongside the `muted` attribute above so a later
		// play() reliably works rather than sitting paused in browsers that are stricter
		// about it.
		el.muted = true;

		// Starts on its own first frame, paused, and stays that way under
		// prefers-reduced-motion — no listener attached at all, so it never plays.
		if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
			return;
		}

		const tryPlay = () => el.play().catch(() => {
			// A play() attempt can still be refused outright (e.g. data-saver mode) — the
			// <video> just stays on its current frame then, an acceptable static fallback
			// rather than a broken/blank background.
		});

		const playOnFirstMove = () => {
			// A play() called before the browser has buffered enough to start (readyState
			// < HAVE_FUTURE_DATA) can silently fail to actually start playback even though
			// the promise resolves — see this same guard's original use at mount time,
			// before this was gated behind a gesture. Unlikely by the time a visitor
			// actually moves the mouse, but cheap to keep correct regardless.
			if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
				tryPlay();
			} else {
				el.addEventListener('canplay', tryPlay, { once: true });
			}
		};

		// Only the page's very first mouse movement starts it — never again after that,
		// and never on its own. `{ once: true }` removes this listener itself once fired.
		document.addEventListener('mousemove', playOnFirstMove, { once: true });
		this._stopWaitingForMove = () => document.removeEventListener('mousemove', playOnFirstMove);
	},
	beforeUnmount() {
		// Home.vue's own root div unmounts this on route change — without removing the
		// listener too, navigating away before ever moving the mouse would leak it on
		// `document` forever (harmless here since `el` would just be gone, but not a habit
		// worth keeping).
		this._stopWaitingForMove?.();
	},
};
</script>

<style scoped>
.home-video-bg {
	position: fixed;
	inset: 0;
	z-index: -1;
	overflow: hidden;
	/* Purely decorative — never intercepts a click meant for the header/panel above it. */
	pointer-events: none;
}

.home-video-bg__video {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: cover;
	/* object-position alone tops out fast here — this video's own aspect ratio is close
	   enough to the viewport's that object-fit:cover leaves almost no horizontal overflow
	   to pan across (confirmed empirically: past a certain point, further object-position
	   shift had zero visible effect, it had already hit that edge). Scaling up first
	   manufactures however much overflow translateX then needs to pan further — still one
	   continuous cover-fit image with no edge gaps, just deliberately oversized. */
	transform: translateX(30%) scale(1.7);
}

/* Vignette: a soft radial falloff plus a left-heavy horizontal fade, both in the same
   dark navy the pre-mount boot screen in index.html uses — keeps whatever page content
   sits over the transparent gutters (header, panel edges) legible in both themes without
   fighting the video's own colors, darkest along the left/edges where content is most
   likely to overlap it. */
.home-video-bg::before {
	content: '';
	position: absolute;
	inset: 0;
	z-index: 2;

	background:
		radial-gradient(
			ellipse at 70% 48%,
			transparent 30%,
			rgba(4, 6, 18, .12) 65%,
			rgba(4, 6, 18, .55) 100%
		),
		linear-gradient(
			90deg,
			rgba(4, 6, 18, 1) 0%,
			rgba(4, 6, 18, 1) 25%,
			rgba(4, 6, 18, .45) 48%,
			rgba(4, 6, 18, .06) 75%
		);

	pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
	.home-video-bg__video {
		/* Belt and suspenders: mounted() already skips attaching the mousemove listener
		   under reduced motion, so this never actually needs to suppress a running CSS
		   animation on the video itself — kept as a harmless backstop regardless. */
		animation: none;
	}
}
</style>
