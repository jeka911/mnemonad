import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';

/**
 * Shared low-level codec behind `streamMeta.js` and `itemMeta.js` — both encode a small
 * JSON object into a stream's or item's opaque on-chain `meta` bytes; this is the part
 * that's actually identical between them (gzip-or-not, tolerant decoding), while each of
 * those two files keeps its own field shape and legacy-fallback behavior on top. Not part
 * of the SDK's public surface (not re-exported from `index.js`) — an implementation detail
 * shared between two call sites, not something a consumer should need directly.
 */

/**
 * Encodes `fields` as JSON, gzipped only when that's actually smaller than plain — for a
 * payload this small (a name, a password KEK's salt + iteration count), gzip's own
 * header/trailer/checksum overhead (~20 bytes) outweighs the savings unless the JSON has
 * enough redundancy to compress past that floor. Measured directly (not assumed): a bare
 * short name or a `{name, type}` item tag loses to gzip every time; a name alongside a KEK
 * block (long hex salt, repeated key names) or anything with repeated substrings wins.
 * Picking whichever is smaller means this can never make an on-chain write more expensive
 * than plain JSON would have been — only cheaper, or exactly equal.
 *
 * Gzip's own magic header (`0x1F 0x8B`) can never start a JSON object's UTF-8 bytes (a
 * plain object always starts with `{`, 0x7B), so the compressed and plain forms are
 * already self-distinguishing on decode — no separate format-version byte needed.
 *
 * @param {Object} fields
 * @returns {Uint8Array|undefined} `undefined` when there are no own keys at all — costs
 *   zero bytes on chain rather than paying for a compressed (or plain) empty `{}`.
 */
export function encodeMetaJson(fields) {
	if (!fields || Object.keys(fields).length === 0) return undefined;
	const plain = strToU8(JSON.stringify(fields));
	const gzipped = gzipSync(plain);
	return gzipped.length < plain.length ? gzipped : plain;
}

/**
 * Reverses `encodeMetaJson`, tolerantly. Gzip-decompression is tried first (the case for
 * anything encoded by this file where compressing actually won); a decompress failure —
 * confirmed to throw cleanly on non-gzip bytes, rather than silently returning garbage —
 * falls through to treating the bytes as plain UTF-8 text instead, which covers both a
 * small payload `encodeMetaJson` deliberately left uncompressed and a legacy pre-JSON
 * plain-text value from before this format existed at all. Whichever text results is then
 * JSON-parsed.
 *
 * @param {?Uint8Array} bytes
 * @returns {{parsed: ?Object, legacyText: ?string}} at most one of the two is non-null:
 *   `parsed` for a genuine JSON object, `legacyText` for anything else decodable as text.
 */
export function decodeMetaJson(bytes) {
	if (!bytes || bytes.length === 0) return { parsed: null, legacyText: null };
	let text;
	try {
		text = strFromU8(gunzipSync(bytes));
	} catch {
		// Not gzip -- plain JSON small enough that compressing it wouldn't have won (see
		// encodeMetaJson), or a legacy value from before this format existed at all.
		// strFromU8 never itself throws (lenient decode, same as TextDecoder without
		// `fatal: true`) -- confirmed, not assumed -- so this is the final fallback.
		text = strFromU8(bytes);
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { parsed, legacyText: null };
		}
	} catch {
		// Not JSON.
	}
	return { parsed: null, legacyText: text || null };
}
