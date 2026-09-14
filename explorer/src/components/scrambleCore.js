/**
 * Shared tick-loop behind ScrambleText.vue and ScrambleCycler.vue — factored out so the
 * cycler can reuse the exact same character-scramble algorithm (random per-character
 * resolve time, not a deterministic left-to-right sweep — see ScrambleText.vue's own doc
 * comment for why that matters) instead of duplicating it, and so it can additionally
 * handle transitioning between two DIFFERENT-length words (ScrambleText only ever
 * transitions a word into itself; the cycler transitions word A into word B).
 */
export const DEFAULT_SCRAMBLE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomChar(charset) {
	return charset[(Math.random() * charset.length) | 0];
}

/**
 * Drives one scramble transition from `fromChars` to `toChars` (arrays of single
 * characters; may differ in length — shorter/longer than `fromChars` is fine). Calls
 * `onFrame(displayChars, scrambling, done)` on every tick, and once more with `done: true`
 * carrying the exact final `toChars` when it finishes (either every real character
 * resolved, or `duration` elapsed — whichever comes first, so a call site never hangs on a
 * tail of never-resolving placeholder characters when `toChars` is shorter than
 * `fromChars`).
 *
 * @param {Object} params
 * @param {string[]} [params.fromChars] - only used for its length (how many extra
 *   placeholder positions to scramble before they're clipped away) — its actual content
 *   never shows, every position starts scrambling immediately.
 * @param {string[]} params.toChars - the real destination characters.
 * @param {number} params.duration - ms ceiling; every character resolves by this point.
 * @param {number} params.tickMs - ms between redraws of the not-yet-resolved characters.
 * @param {string} params.charset - pool of glyphs shown while a character scrambles.
 * @param {(display: string[], scrambling: boolean[], done: boolean) => void} params.onFrame
 * @returns {() => void} cancel — stops the tick loop early (no final onFrame call).
 */
export function runScramble({ fromChars = [], toChars, duration, tickMs, charset, onFrame }) {
	const targetLen = toChars.length;
	const maxLen = Math.max(fromChars.length, targetLen);
	// One random resolve moment per real target character — an extra (soon-to-be-clipped)
	// tail position beyond targetLen has no real character to resolve to, so it just
	// scrambles for the whole window and gets dropped in the final onFrame instead.
	const resolveAt = new Array(maxLen).fill(0).map((_, i) => (i < targetLen ? Math.random() * duration : duration));
	const begin = performance.now();
	let timer = null;
	let cancelled = false;

	const tick = () => {
		if (cancelled) return;
		const elapsed = performance.now() - begin;
		const nextDisplay = new Array(maxLen);
		const nextScrambling = new Array(maxLen);
		let stillGoing = false;

		for (let i = 0; i < maxLen; i++) {
			const target = i < targetLen ? toChars[i] : null;
			const resolved = target !== null && (target === ' ' || elapsed >= resolveAt[i]);
			if (resolved) {
				nextDisplay[i] = target;
				nextScrambling[i] = false;
			} else {
				nextDisplay[i] = target === ' ' ? ' ' : randomChar(charset);
				nextScrambling[i] = true;
				if (target !== null) stillGoing = true; // placeholder tail never counts
			}
		}

		if (elapsed >= duration || !stillGoing) {
			onFrame(toChars.slice(), toChars.map(() => false), true);
			timer = null;
			return;
		}

		onFrame(nextDisplay, nextScrambling, false);
		timer = setTimeout(tick, tickMs);
	};
	tick();

	return () => {
		cancelled = true;
		if (timer) clearTimeout(timer);
	};
}
