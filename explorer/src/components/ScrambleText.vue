<template>
	<span class="scramble-text">
		<span class="scramble-text__sr" v-if="srOnly">{{ text }}</span>
		<span class="scramble-text__chars" :aria-hidden="srOnly ? 'true' : null">
			<span
				v-for="(char, i) in displayChars"
				:key="i"
				class="scramble-text__char"
				:class="{ 'scramble-text__char--active': scrambling[i] }"
				>{{ char === ' ' ? ' ' : char }}</span
			>
		</span>
	</span>
</template>

<script>
/**
 * The nav hover effect from monad.xyz itself (inspect any of its dropdown-opening nav
 * items — Build/Ecosystem/Resources — while hovering): each character rapidly cycles
 * through random glyphs in the brand purple, then locks in to its real letter, at a
 * RANDOM moment per character rather than a clean left-to-right sweep — captured this by
 * recording the real site and stepping through the video frame by frame. One frame showed
 * "ECOSYSTEM"'s very first and very last letters both already resolved while everything
 * between them was still scrambling, which a deterministic index-based stagger could
 * never produce; a per-character *random* resolve delay within the total window explains
 * it exactly, so that's what this implements.
 *
 * Character content changing over time is not something CSS can do on its own (unlike the
 * lift-and-color-tint version of this component that came before it and got scrapped for
 * exactly that reason) — this one really does need a JS-driven tick loop.
 *
 * The tick loop itself lives in `scrambleCore.js`, shared with ScrambleCycler.vue (which
 * needs the same per-character resolve behavior but transitioning between two different
 * words on a timer, rather than a single word revealing itself on hover).
 */
import { DEFAULT_SCRAMBLE_CHARSET, runScramble } from './scrambleCore.js';

export default {
	name: 'ScrambleText',
	props: {
		text: {
			type: String,
			required: true,
		},
		/** Pool of glyphs shown while a character is still "scrambling". Uppercase
		 * letters + digits, matching what monad.xyz's own effect actually cycles through
		 * (confirmed frame by frame — plain hex digits alone was too narrow a guess). */
		charset: {
			type: String,
			default: DEFAULT_SCRAMBLE_CHARSET,
		},
		/** ms — the window within which every character will have resolved. Each
		 * character's own resolve moment is randomized somewhere inside this window
		 * (see the class doc above for why), so this is a ceiling, not a fixed pace. */
		duration: {
			type: Number,
			default: 400,
		},
		/** ms between redraws of the characters still scrambling. */
		tickMs: {
			type: Number,
			default: 50,
		},
		/** Render a screen-reader-only full-text span alongside the per-character
		 * (aria-hidden) ones, so assistive tech reads the real word throughout — the
		 * animated spans never touch it. Matches monad.xyz's own pairing of an sr-only
		 * span with its animated one. Turn off only if a parent already provides the
		 * accessible name itself (e.g. via aria-label). */
		srOnly: {
			type: Boolean,
			default: true,
		},
	},
	data() {
		const chars = [...this.text];
		return {
			displayChars: chars.slice(),
			scrambling: chars.map(() => false),
			_cancel: null,
		};
	},
	beforeUnmount() {
		this.stop();
	},
	methods: {
		/** Starts (or restarts) the scramble-in — call on mouseenter/focus. Safe to call
		 * again mid-animation; it just re-rolls fresh resolve times and keeps going. */
		start() {
			this.stop();
			const chars = [...this.text];
			if (!chars.length) return;

			if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
				// Skip the flicker entirely — just show the real text, already resolved.
				this.displayChars = chars;
				this.scrambling = chars.map(() => false);
				return;
			}

			this._cancel = runScramble({
				toChars: chars,
				duration: this.duration,
				tickMs: this.tickMs,
				charset: this.charset,
				onFrame: (display, scrambling) => {
					this.displayChars = display;
					this.scrambling = scrambling;
				},
			});
		},
		stop() {
			this._cancel?.();
			this._cancel = null;
		},
	},
};
</script>

<style scoped>
.scramble-text {
	display: inline-block;
}

.scramble-text__sr {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

.scramble-text__chars {
	display: inline-block;
	/* Visual only — the underlying `text` prop, the sr-only span, and the scramble/resolve
	   logic all stay whatever case was passed in ("Home", not "HOME"); this just renders
	   it uppercase, matching monad.xyz's own nav labels. */
	text-transform: uppercase;
	/* Monospace so mid-scramble characters don't jitter width on their own, on top of the
	   deliberate width transition — a proportional font gives every random glyph a
	   different advance width, making the scramble visibly jiggle as characters cycle.
	   Matches monad.xyz's own element, which sets this same var(--font-mono) inline.
	   See ScrambleCycler's own copy of this comment for why an earlier "Space Mono renders
	   taller than Inter" finding here turned out to be a flawed measurement, not a real
	   metrics mismatch — nothing to compensate for after all. */
	font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
}

.scramble-text__char {
	display: inline-block;
	white-space: pre;
}

.scramble-text__char--active {
	color: var(--q-primary, #836ef9);
}
</style>
