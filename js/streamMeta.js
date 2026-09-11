import { encodeMetaJson, decodeMetaJson } from './metaCodec.js';

/**
 * Stream-level metadata format.
 *
 * A stream's on-chain `meta` field is opaque bytes to the contract — historically just the
 * UTF-8 name typed into "New stream". Encryption needs more than a name to travel alongside a
 * stream (the password KDF's salt and iteration count, so a later reader can reproduce the
 * same key-encryption key), so `meta` is now a small JSON object instead:
 *
 *   { name?: string, kek?: { method: 'password', salt: string, iterations: number } }
 *
 * gzip-compressed on-chain when that's actually smaller (see `metaCodec.js`'s own doc for
 * why a bare name usually isn't, but a name alongside a `kek` block usually is).
 *
 * `decodeStreamMeta` falls back to treating the whole decoded string as a legacy plain-text
 * name when it isn't valid JSON (or decodes to something that isn't a plain object) — no
 * migration needed for any stream created before this format (or gzip) existed.
 */

/**
 * @param {Object} [fields]
 * @param {?string} [fields.name]
 * @param {?{method: string, salt: string, iterations: number}} [fields.kek]
 * @returns {Uint8Array|undefined} `undefined` when there is nothing at all to store — keeps
 *   the common "no name, not encrypted" case exactly as small on-chain as before this format
 *   existed, rather than paying for an empty `{}`.
 */
export function encodeStreamMeta(fields = {}) {
	const out = {};
	if (fields.name) out.name = fields.name;
	if (fields.kek) out.kek = fields.kek;
	return encodeMetaJson(out);
}

/**
 * @param {?Uint8Array} bytes
 * @returns {{name: ?string, kek: ?{method: string, salt: string, iterations: number}}}
 */
export function decodeStreamMeta(bytes) {
	const { parsed, legacyText } = decodeMetaJson(bytes);
	if (parsed) return { name: parsed.name || null, kek: parsed.kek || null };
	return { name: legacyText || null, kek: null };
}
