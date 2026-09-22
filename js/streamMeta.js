import { encodeMetaJson, decodeMetaJson } from './metaCodec.js';

/**
 * Stream-level metadata format.
 *
 * A stream's on-chain `meta` field is opaque bytes to the contract — historically just the
 * UTF-8 name typed into "New stream". Encryption needs more than a name to travel alongside a
 * stream (the password KDF's salt and iteration count, so a later reader can reproduce the
 * same key-encryption key), so `meta` is now a small JSON object instead:
 *
 *   { name?: string, kek?: { method: 'password'|'signature', salt?: string, iterations?: number } }
 *
 * `salt`/`iterations` belong to the password method alone; a signature-based stream publishes
 * only `{ method: 'signature' }`, since everything its KEK binds is already on chain and the
 * wallet itself is the secret. See `kekMethodOf` below for reading the method back safely.
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
 * @param {?{method: string, salt?: string, iterations?: number}} [fields.kek]
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
 * @returns {{name: ?string, kek: ?{method: string, salt?: string, iterations?: number}}}
 */
export function decodeStreamMeta(bytes) {
	const { parsed, legacyText } = decodeMetaJson(bytes);
	if (parsed) return { name: parsed.name || null, kek: parsed.kek || null };
	return { name: legacyText || null, kek: null };
}

/**
 * Which KEK method a stream uses, from what a reader can see without any secret.
 *
 * The `kek` block is the authoritative answer, but it only started carrying
 * `{method: 'signature'}` once signature streams got a marker of their own — before that,
 * only password streams published a block at all. So an encrypted stream with no block is
 * read as signature-based: that was the one method that never wrote one, and it stays the
 * correct inference for every stream created before the marker existed.
 *
 * @param {Object} params
 * @param {?{method?: string}} [params.kek] - `decodeStreamMeta(...).kek`, or
 *   `mnemonad.streamMeta.kek`
 * @param {boolean} params.encrypted - whether the stream has a wrapped key on chain at all
 *   (`await mnemonad.isEncrypted()`, or a non-empty `encKeyWrapped`)
 * @returns {?('password'|'signature'|string)} `null` for an unencrypted stream
 */
export function kekMethodOf({ kek, encrypted } = {}) {
	if (kek && kek.method) return kek.method;
	return encrypted ? 'signature' : null;
}
