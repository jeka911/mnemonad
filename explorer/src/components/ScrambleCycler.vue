<template>
	<span class="scramble-cycler" :style="wrapperStyle"><span class="scramble-cycler__clip">
		<span class="scramble-cycler__sr" v-if="srOnly">{{ words[index] }}</span>
		<span class="scramble-cycler__chars" :aria-hidden="srOnly ? 'true' : null">
			<span
				v-for="(char, i) in displayChars"
				:key="i"
				class="scramble-cycler__char"
				:class="{ 'scramble-cycler__char--active': scrambling[i] }"
				>{{ char === ' ' ? ' ' : char }}</span
			>
		</span></span><span class="scramble-cycler__baseline-anchor">&#8203;</span><span ref="ruler" class="scramble-cycler__chars scramble-cycler__ruler" aria-hidden="true"></span></span>
</template>

<script>
/**
 * ScrambleText's own hover reveal, but looping through a whole list of words on a timer
 * instead of once on hover — same per-character random-resolve scramble (via the shared
 * `runScramble` in scrambleCore.js), just re-triggered every `intervalMs` against the
 * *next* word rather than a single fixed target.
 *
 * The one genuinely new problem this adds: consecutive words are rarely the same length,
 * so the visible box has to resize as it switches. That's handled by animating `width`
 * toward the incoming word's rendered pixel width, via a plain CSS `width` transition that
 * runs on its own clock, fully independent of the character tick loop — the box eases to
 * its new size while the letters are still mid-scramble, exactly like on monad.xyz's own
 * site (its hero cycles a keyword the same way).
 *
 * That target width comes from actually measuring the word with a hidden DOM "ruler"
 * element (see `_measureWidth`), not from character-count math — this component uses
 * whatever font the surrounding text already does (see `__chars` below), so per-character
 * width isn't uniform or knowable in advance the way it would be in a monospace font.
 * Measuring the real rendered width sidesteps that entirely, along with anything else
 * that'd otherwise have to be accounted for by hand (the surrounding text's own
 * `letter-spacing`, for one — confirmed live that it inherits in and isn't optional).
 */
import { DEFAULT_SCRAMBLE_CHARSET, runScramble } from './scrambleCore.js';

export default {
	name: 'ScrambleCycler',
	props: {
		/** Words to rotate through, in order, looping back to the start. */
		words: {
			type: Array,
			required: true,
			validator: (v) => v.length > 0 && v.every((w) => typeof w === 'string'),
		},
		/** ms each word stays fully resolved before scrambling into the next one. */
		intervalMs: {
			type: Number,
			default: 2500,
		},
		/** Pool of glyphs shown while a character is still "scrambling" — see
		 * ScrambleText's own doc for why this is broad alphanumeric, not just hex. */
		charset: {
			type: String,
			default: DEFAULT_SCRAMBLE_CHARSET,
		},
		/** ms — the window within which every character of the incoming word resolves. */
		duration: {
			type: Number,
			default: 400,
		},
		/** ms between redraws of the characters still scrambling. */
		tickMs: {
			type: Number,
			default: 50,
		},
		/** ms the box's own width transition takes to ease to the incoming word's width.
		 * Independent of `duration` on purpose — the box arriving at its final size a
		 * touch before the last letters lock in reads better than both landing at once. */
		widthEaseMs: {
			type: Number,
			default: 350,
		},
		/** Render a screen-reader-only span carrying the current word — see ScrambleText's
		 * own doc on this same prop for why (no aria-live: it just updates like ordinary
		 * text, rather than interrupting with an announcement on every rotation). */
		srOnly: {
			type: Boolean,
			default: true,
		},
	},
	data() {
		const first = [...this.words[0]];
		return {
			index: 0,
			displayChars: first.slice(),
			scrambling: first.map(() => false),
			// Pixel width, not character count — see the class doc for why. Starts null
			// (falls back to an Nch estimate for the very first paint, before mounted() has
			// measured anything yet) and gets a real measured value immediately on mount.
			targetWidthPx: null,
			targetLen: first.length,
			_cancelScramble: null,
			_rotateTimer: null,
		};
	},
	computed: {
		wrapperStyle() {
			return {
				width: this.targetWidthPx != null ? `${this.targetWidthPx}px` : `${this.targetLen}ch`,
				transitionDuration: `${this.widthEaseMs}ms`,
			};
		},
	},
	mounted() {
		this.targetWidthPx = this._measureWidth(this.words[this.index]);
		if (this.words.length > 1) this._scheduleNext();
	},
	beforeUnmount() {
		this.stop();
	},
	watch: {
		words() {
			// A different word list entirely — restart from the top rather than risk
			// `index` pointing past the end of a shorter new array.
			this.stop();
			const chars = [...this.words[0]];
			this.index = 0;
			this.displayChars = chars.slice();
			this.scrambling = chars.map(() => false);
			this.targetLen = chars.length;
			this.targetWidthPx = this._measureWidth(this.words[0]);
			if (this.words.length > 1) this._scheduleNext();
		},
	},
	methods: {
		_measureWidth(word) {
			this.$refs.ruler.textContent = word;
			return this.$refs.ruler.getBoundingClientRect().width;
		},
		_scheduleNext() {
			this._rotateTimer = setTimeout(() => this._advance(), this.intervalMs);
		},
		_advance() {
			this.index = (this.index + 1) % this.words.length;
			const toChars = [...this.words[this.index]];
			// Reactive width change — the CSS transition on .scramble-cycler picks this up
			// and eases toward it on its own, no coordination with the character tick loop
			// needed beyond both starting at roughly the same moment.
			this.targetLen = toChars.length;
			this.targetWidthPx = this._measureWidth(this.words[this.index]);

			this._cancelScramble?.();
			if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
				this.displayChars = toChars;
				this.scrambling = toChars.map(() => false);
			} else {
				this._cancelScramble = runScramble({
					fromChars: this.displayChars,
					toChars,
					duration: this.duration,
					tickMs: this.tickMs,
					charset: this.charset,
					onFrame: (display, scrambling) => {
						this.displayChars = display;
						this.scrambling = scrambling;
					},
				});
			}

			this._scheduleNext();
		},
		stop() {
			clearTimeout(this._rotateTimer);
			this._rotateTimer = null;
			this._cancelScramble?.();
			this._cancelScramble = null;
		},
	},
};
</script>

<style scoped>
/* `overflow: hidden` on an inline-block quietly redefines ITS OWN baseline, per spec, to
   its bottom margin edge instead of its text's true baseline — a `vertical-align:
   text-bottom` compensation on THIS element was still off by ~17px once .mn-eyebrow's own
   line-height entered into it, and any such fixed-keyword fix is fragile across different
   font/line-height contexts anyway. So `overflow` itself lives one level in, on `__clip` —
   NEVER on this element, even though this is also where the animated `width` lives (see
   below) and it's tempting to put both on the same box. This one stays a completely
   normal inline-block whose baseline is just "the baseline of its last in-flow child",
   full stop. That last child is `__baseline-anchor`, a zero-width span with nothing
   special applied to it — an ordinary text-bearing box whose own baseline is simply
   correct — so this element inherits a correct baseline for free. (Confirmed live: adding
   `overflow: hidden` back here too, while chasing the width bug below, silently
   reintroduced this exact baseline bug a second time.)
   The animated `width` lives HERE, on the outer element, not on `__clip` — confirmed live
   that the reverse (width+transition on the inner `__clip`, this element left auto/
   shrink-to-fit) doesn't work: a shrink-to-fit parent wrapping a child whose OWN width is
   mid-CSS-transition doesn't reliably track that child's live, still-interpolating width,
   and ended up sized for something narrower than the child actually needed — clipping the
   child against its own parent. Giving *this* element the explicit, independently
   transitioning width sidesteps that entirely: `__clip` just fills 100% of whatever this
   element's current (animating) width already is, and clips (via ITS OWN overflow:hidden,
   not this element's) whatever of the character content still exceeds that. */
.scramble-cycler {
	display: inline-block;
	white-space: nowrap;
	transition-property: width;
	transition-timing-function: ease;
}

.scramble-cycler__clip {
	display: inline-block;
	width: 100%;
	overflow: hidden;
	white-space: nowrap;
	vertical-align: top;
}

.scramble-cycler__baseline-anchor {
	/* Deliberately NOT display:inline-block and NOT overflow:hidden — either one would
	   trigger the exact same baseline-override quirk on THIS element that all of this is
	   working around, defeating the point of it. Plain inline with a zero-width-space
	   character: nothing to clip, nothing to override, just a normal, correct baseline. */
	width: 0;
	display: inline;
}

.scramble-cycler__sr {
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

.scramble-cycler__ruler {
	/* Off-screen, not just invisible — `visibility: hidden` alone would still occupy its
	   own layout space right here inline, widening this component unpredictably. Still
	   fully laid out and measurable (unlike display:none), just nowhere anyone can see. */
	position: absolute;
	left: -9999px;
	top: 0;
	white-space: pre;
	visibility: hidden;
	pointer-events: none;
}

.scramble-cycler__chars {
	display: inline-block;
	/* Visual only, matching ScrambleText — the `words` prop, the sr-only span, and the
	   scramble/resolve logic all stay whatever case was passed in. */
	text-transform: uppercase;
	/* Monospace so mid-scramble characters don't jitter width on their own, on top of the
	   deliberate width transition — a proportional font gives every random glyph a
	   different advance width, making the scramble visibly jiggle as characters cycle.
	   Matches monad.xyz's own element, which sets this same var(--font-mono) inline.
	   Whatever uses this needs to put its OWN surrounding text in the same font too (see
	   .mn-eyebrow) — an earlier check here comparing this against a plain-Inter sibling
	   line measured a large height mismatch and briefly "fixed" it with a compensating
	   font-size scale, but that comparison turned out to be measuring an inline-block
	   span's own box height (its line-height) rather than actual glyph ink; redone
	   correctly (text node vs text node), Space Mono and Inter's glyph ink heights match
	   at the same font-size — there was never a real metrics mismatch to correct for. */
	font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
}

.scramble-cycler__char {
	display: inline-block;
	white-space: pre;
}

.scramble-cycler__char--active {
	color: var(--q-primary, #836ef9);
}

@media (prefers-reduced-motion: reduce) {
	.scramble-cycler {
		transition: none;
	}
}
</style>
