import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { DEFAULT_SCRAMBLE_CHARSET } from '../components/scrambleCore.js';

/**
 * Renders the /logo page's mark — hexagon + scrambling name — into an animated image, frame by
 * frame on a canvas, rather than screen-capturing the page: every frame is exact, the size is
 * fixed whatever the window, and nothing about the live page has to hold still while it runs.
 *
 * It replays the same algorithm as scrambleCore.js's runScramble (a random resolve moment per
 * character, glyphs from the same charset), but on a fixed timeline instead of real time, so
 * no frame is ever skipped. Colors come from the live theme's CSS variables, so the result
 * matches whichever theme (dark/light) is showing when it's made. The background is
 * transparent.
 *
 * Two formats, sharing the same frames:
 *  - APNG (renderLogoApng) — the default. Full 8-bit alpha and full color: smooth edges on any
 *    background and no banding in the gradients. Plays in every current browser.
 *  - GIF (renderLogoGif) — for places that only take GIF. 256 colors, and all-or-nothing
 *    transparency per pixel, so edges are snapped (see ALPHA_CUTOFF).
 */

const SCRAMBLE_MS = 1200; // same reveal window as the page
const FRAME_MS = 50; // GIF delays are in 1/100 s; 50 ms keeps every frame the same length
const HOLD_MS = 4000; // the finished mark, before the loop starts over

// Layout at scale 1 — the size the page itself shows at its widest. `scale` multiplies all of it.
const FONT_PX = 112;
const ICON_PX = 132;
const GAP_PX = 28;
const PAD_X = 64;
const PAD_Y = 56;
const LETTER_SPACING = 0.02; // em, as on the page

// GIF only: edge pixels at least this opaque (0–255) are kept, the rest dropped. Half-way
// keeps glyph weight the same as on screen.
const ALPHA_CUTOFF = 128;

/**
 * The scramble's glyph pool on /logo — the shared default minus Q, whose tail reaches below
 * the baseline and gets clipped by the title's tight line box (and its gradient's text clip).
 * Shared by the page and these animations, so both scramble through the same glyphs.
 */
export const LOGO_SCRAMBLE_CHARSET = DEFAULT_SCRAMBLE_CHARSET.replace('Q', '');

// Material Icons' "hexagon" glyph (24×24 viewBox) — the same mark the page shows via <q-icon>.
const HEXAGON_PATH = 'M17.2 3H6.8l-5.2 9 5.2 9h10.4l5.2-9z';

/** Any CSS color → [r, g, b], resolved by the browser itself. */
function rgbOf(cssColor) {
	const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
	c.fillStyle = '#000';
	c.fillStyle = cssColor;
	c.fillRect(0, 0, 1, 1);
	const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
	return [r, g, b];
}

/** CSS color-mix(in srgb, a p%, b) */
function mix(a, b, p) {
	return `rgb(${a.map((v, i) => Math.round(v * p + b[i] * (1 - p))).join(',')})`;
}

function themeColors() {
	const style = getComputedStyle(document.body);
	const primary = rgbOf(style.getPropertyValue('--q-primary').trim() || '#836ef9');
	const accent = rgbOf(style.getPropertyValue('--q-accent').trim() || '#a0055d');
	const white = [255, 255, 255];
	return {
		// The same stops as the page's CSS gradients (pages/Logo.vue, layout/Logo.vue).
		icon: [`rgb(${primary.join(',')})`, mix(primary, accent, 0.55)],
		text: [mix(primary, white, 0.8), `rgb(${primary.join(',')})`, mix(primary, accent, 0.6)],
	};
}

/**
 * The scramble as a list of frames: each one the characters to draw and how long to show it.
 *
 * @param {string} title - e.g. 'Mnemonad'; drawn uppercase, as ScrambleText renders it
 * @returns {Array<{chars: string[], delay: number}>}
 */
function scrambleFrames(title) {
	const chars = [...title.toUpperCase()];
	const resolveAt = chars.map(() => Math.random() * SCRAMBLE_MS);
	const random = () => LOGO_SCRAMBLE_CHARSET[(Math.random() * LOGO_SCRAMBLE_CHARSET.length) | 0];
	const frames = [];
	for (let t = 0; t < SCRAMBLE_MS; t += FRAME_MS) {
		frames.push({
			chars: chars.map((ch, i) => (ch === ' ' || t >= resolveAt[i] ? ch : random())),
			delay: FRAME_MS,
		});
	}
	frames.push({ chars, delay: HOLD_MS });
	return frames;
}

/**
 * A canvas laid out for the mark, and a function that paints one frame on it.
 *
 * @param {Object} params
 * @param {string} params.title - the name to scramble
 * @param {string} params.fontFamily - a loaded monospace face, e.g. '"Martian Mono"'
 * @param {number} params.scale - multiplies the whole layout (1 = the page's own size,
 *   about 930×245 px; 3 = about 2790×730 px)
 */
async function createRenderer({ title, fontFamily, scale }) {
	const fontPx = FONT_PX * scale;
	const iconPx = ICON_PX * scale;
	const font = `800 ${fontPx}px ${fontFamily}`;
	await document.fonts?.load(font, title);

	const measure = document.createElement('canvas').getContext('2d');
	measure.font = font;
	// Monospace: one advance for every glyph, scrambling or not — plus the page's letter-spacing.
	const advance = measure.measureText('M').width + LETTER_SPACING * fontPx;
	const metrics = measure.measureText('M');
	const capHeight = metrics.actualBoundingBoxAscent;
	// The font's own ascent/descent — tall enough for any glyph in it, scrambling or not.
	const fontAscent = metrics.fontBoundingBoxAscent ?? fontPx;
	const fontDescent = metrics.fontBoundingBoxDescent ?? fontPx * 0.3;
	const textWidth = advance * title.length - LETTER_SPACING * fontPx;

	const width = Math.ceil((PAD_X * 2 + GAP_PX) * scale + iconPx + textWidth);
	const height = Math.ceil(PAD_Y * 2 * scale + Math.max(iconPx, fontPx));
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	const colors = themeColors();

	const iconX = PAD_X * scale;
	const iconY = (height - iconPx) / 2;
	const textX = iconX + iconPx + GAP_PX * scale;
	const baseline = (height + capHeight) / 2;

	// Built once: the same gradients on every frame. A canvas gradient is applied in whatever
	// transform is active when it fills, so the icon's is in the hexagon path's own 24×24
	// units (the path is drawn scaled up), running corner to corner like the page's 135deg one.
	const iconGradient = ctx.createLinearGradient(0, 0, 24, 24);
	iconGradient.addColorStop(0, colors.icon[0]);
	iconGradient.addColorStop(1, colors.icon[1]);
	const textGradient = ctx.createLinearGradient(textX, baseline - capHeight, textX + textWidth, baseline);
	textGradient.addColorStop(0, colors.text[0]);
	textGradient.addColorStop(0.45, colors.text[1]);
	textGradient.addColorStop(1, colors.text[2]);
	const hexagon = new Path2D(HEXAGON_PATH);

	function paint(chars) {
		ctx.clearRect(0, 0, width, height);

		ctx.save();
		ctx.setTransform(iconPx / 24, 0, 0, iconPx / 24, iconX, iconY);
		ctx.fillStyle = iconGradient;
		ctx.fill(hexagon);
		ctx.restore();

		ctx.font = font;
		ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = textGradient;
		chars.forEach((ch, i) => ctx.fillText(ch, textX + i * advance, baseline));
	}

	/** The canvas columns character `i`'s glyph can paint into, with a margin for
	 *  antialiasing and any glyph wider than its advance. */
	function charSpan(i) {
		const margin = Math.ceil(advance * 0.25);
		const x0 = Math.max(0, Math.floor(textX + i * advance) - margin);
		const x1 = Math.min(width, Math.ceil(textX + (i + 1) * advance) + margin);
		return [x0, x1];
	}

	/** The canvas rows any character can paint into: the font's full height plus a margin. */
	function textRows() {
		const margin = Math.ceil(fontPx * 0.05);
		return [Math.max(0, Math.floor(baseline - fontAscent) - margin), Math.min(height, Math.ceil(baseline + fontDescent) + margin)];
	}

	return { canvas, ctx, width, height, paint, charSpan, textRows, frames: scrambleFrames(title) };
}

/** Lets the page breathe between frames — seconds of work at 3× (the busy cursor shows). */
const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

/* ---------------------------------------------------------------------- APNG */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type + data. */
function chunk(type, data) {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

function u32(...values) {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((v, i) => view.setUint32(i * 4, v));
	return out;
}

/** Bytes → zlib-wrapped deflate, by the browser's own compressor. */
async function zlibDeflate(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * PNG image data (the zlib stream that goes into IDAT/fdAT) for an RGBA rectangle — encoded
 * here rather than by canvas.toBlob, whose encoder favors speed over size (11.8 MB for this
 * animation at 3× as full frames, against 3–4 MB this way plus changed-rectangle frames,
 * depending on how the random scramble falls). Each row gets whichever of the five PNG
 * filters leaves the smallest residuals (the usual sum-of-absolute-values heuristic); the
 * smooth gradients here mostly pick Up or Paeth, which then deflate very well.
 */
async function encodePngData(rgba, w, h) {
	const stride = w * 4;
	const out = new Uint8Array(h * (stride + 1));
	const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
	for (let y = 0; y < h; y++) {
		const row = rgba.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
		let best = 0;
		let bestScore = Infinity;
		for (let f = 0; f < 5; f++) {
			const c = candidates[f];
			let score = 0;
			for (let x = 0; x < stride; x++) {
				const a = x >= 4 ? row[x - 4] : 0; // left
				const b = prev ? prev[x] : 0; // up
				const d = prev && x >= 4 ? prev[x - 4] : 0; // up-left
				let pred = 0;
				if (f === 1) pred = a;
				else if (f === 2) pred = b;
				else if (f === 3) pred = (a + b) >> 1;
				else if (f === 4) {
					const p = a + b - d;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - d);
					pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : d;
				}
				const v = (row[x] - pred) & 0xff;
				c[x] = v;
				score += v < 128 ? v : 256 - v;
				if (score >= bestScore) break;
			}
			if (score < bestScore) {
				bestScore = score;
				best = f;
			}
		}
		// The winning candidate may have stopped early; recompute it in full.
		const c = candidates[best];
		for (let x = 0; x < stride; x++) {
			const a = x >= 4 ? row[x - 4] : 0;
			const b = prev ? prev[x] : 0;
			const d = prev && x >= 4 ? prev[x - 4] : 0;
			let pred = 0;
			if (best === 1) pred = a;
			else if (best === 2) pred = b;
			else if (best === 3) pred = (a + b) >> 1;
			else if (best === 4) {
				const p = a + b - d;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - d);
				pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : d;
			}
			c[x] = (row[x] - pred) & 0xff;
		}
		out[y * (stride + 1)] = best;
		out.set(c, y * (stride + 1) + 1);
	}
	return zlibDeflate(out);
}

/**
 * Builds the animation as an APNG.
 *
 * Its first frame is the whole canvas, as plain IDAT (so a viewer without APNG support still
 * shows the logo). Every later frame stores only the rectangle that changed since the frame
 * before — the columns of the characters that changed glyph and the rows text can reach,
 * never the hexagon — and
 * replaces just that rectangle (dispose NONE, blend SOURCE: a transparent pixel in it really
 * becomes transparent, it doesn't show what was there through).
 *
 * @param {Object} params
 * @param {string} params.title - the name to scramble
 * @param {string} params.fontFamily - a loaded monospace face, e.g. '"Martian Mono"'
 * @param {number} [params.scale=3] - see createRenderer
 * @returns {Promise<Blob>} image/png (animated)
 */
export async function renderLogoApng({ title, fontFamily, scale = 3 }) {
	const { ctx, width, height, paint, charSpan, textRows, frames } = await createRenderer({ title, fontFamily, scale });

	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
	// IHDR: size, 8-bit, color type 6 (RGBA), default compression/filter, no interlace.
	const ihdr = new Uint8Array(13);
	new DataView(ihdr.buffer).setUint32(0, width);
	new DataView(ihdr.buffer).setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8);
	parts.push(chunk('IHDR', ihdr));
	parts.push(chunk('acTL', u32(frames.length, 0))); // 0 plays = loop forever

	let sequence = 0;
	let previous = null;
	for (let i = 0; i < frames.length; i++) {
		const chars = frames[i].chars;
		let x0 = 0;
		let x1 = width;
		let y0 = 0;
		let y1 = height;
		if (previous) {
			[y0, y1] = textRows();
			const changed = chars.map((ch, k) => ch !== previous[k]).reduce((acc, c, k) => (c ? acc.concat(k) : acc), []);
			if (changed.length) {
				x0 = charSpan(changed[0])[0];
				x1 = charSpan(changed[changed.length - 1])[1];
			} else {
				// Nothing changed (two identical draws in a row): still a frame, for its delay —
				// a 1×1 rectangle copied as it already is.
				x0 = charSpan(0)[0];
				x1 = x0 + 1;
				y1 = y0 + 1;
			}
		}
		previous = chars;

		paint(chars);
		const w = x1 - x0;
		const h = y1 - y0;
		const data = await encodePngData(ctx.getImageData(x0, y0, w, h).data, w, h);

		// fcTL: sequence, rect size and offset, delay as a fraction (ms / 1000), dispose NONE,
		// blend SOURCE.
		const fcTL = new Uint8Array(26);
		const view = new DataView(fcTL.buffer);
		view.setUint32(0, sequence++);
		view.setUint32(4, w);
		view.setUint32(8, h);
		view.setUint32(12, x0);
		view.setUint32(16, y0);
		view.setUint16(20, frames[i].delay);
		view.setUint16(22, 1000);
		fcTL[24] = 0;
		fcTL[25] = 0;
		parts.push(chunk('fcTL', fcTL));

		if (i === 0) {
			parts.push(chunk('IDAT', data));
		} else {
			const fdAT = new Uint8Array(4 + data.length);
			new DataView(fdAT.buffer).setUint32(0, sequence++);
			fdAT.set(data, 4);
			parts.push(chunk('fdAT', fdAT));
		}
		await yieldToPage();
	}
	parts.push(chunk('IEND', new Uint8Array(0)));
	return new Blob(parts, { type: 'image/png' });
}

/* ----------------------------------------------------------------------- GIF */

/**
 * Builds the animation as a GIF.
 *
 * Defaults to 5× (about 4650×1220 px) — larger than the APNG's 3×: a GIF's hard edges need
 * the extra resolution to look smooth once scaled down, and at 256 colors it stays far
 * smaller than the APNG anyway.
 *
 * Frames are drawn and encoded one at a time, never all held at once: at 5× a single frame's
 * RGBA is ~23 MB, so keeping all 25 around would cost over half a gigabyte.
 *
 * GIF transparency is all-or-nothing per pixel, so every antialiased edge pixel is snapped to
 * either fully opaque — in its own true color, never blended with a background — or fully
 * transparent (see ALPHA_CUTOFF): no fringe on whatever it's placed on, at the cost of
 * slightly hard edges. APNG has neither limit.
 *
 * @param {Object} params - see renderLogoApng
 * @param {number} [params.scale=5]
 * @returns {Promise<Blob>} image/gif
 */
export async function renderLogoGif({ title, fontFamily, scale = 5 }) {
	const { ctx, width, height, paint, frames } = await createRenderer({ title, fontFamily, scale });

	function draw(chars) {
		paint(chars);
		// getImageData is unpremultiplied: an edge pixel already carries its true color, so
		// only its alpha needs snapping.
		const rgba = ctx.getImageData(0, 0, width, height).data;
		for (let p = 3; p < rgba.length; p += 4) {
			if (rgba[p] >= ALPHA_CUTOFF) {
				rgba[p] = 255;
			} else {
				rgba[p - 3] = rgba[p - 2] = rgba[p - 1] = rgba[p] = 0;
			}
		}
		return rgba;
	}

	// One palette for the whole animation, from a mid-scramble frame and the finished mark
	// together, so colors don't shift between frames. These two are drawn just for this.
	const mid = draw(frames[Math.floor(frames.length / 2)].chars);
	const sample = new Uint8ClampedArray(mid.length * 2);
	sample.set(mid, 0);
	sample.set(draw(frames[frames.length - 1].chars), mid.length);
	const palette = quantize(sample, 256, { format: 'rgba4444', oneBitAlpha: true });
	let transparentIndex = palette.findIndex((c) => c[3] === 0);
	if (transparentIndex < 0) {
		// Only possible if no pixel is transparent at all — never for this layout, but keep
		// the index valid rather than marking a real color as see-through.
		palette.push([0, 0, 0, 0]);
		transparentIndex = palette.length - 1;
	}

	const gif = GIFEncoder({ initialCapacity: 1 << 20 });
	for (let i = 0; i < frames.length; i++) {
		const index = applyPalette(draw(frames[i].chars), palette, 'rgba4444');
		// With `transparent` set, gifenc also marks each frame "restore to background", so a
		// frame's transparent pixels never show the previous frame's glyphs through them.
		const opts = { delay: frames[i].delay, transparent: true, transparentIndex };
		gif.writeFrame(index, width, height, i === 0 ? { ...opts, palette, repeat: 0 } : opts);
		await yieldToPage();
	}
	gif.finish();
	return new Blob([gif.bytes()], { type: 'image/gif' });
}

/** Hands `blob` to the browser as a download named `filename`. */
export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
