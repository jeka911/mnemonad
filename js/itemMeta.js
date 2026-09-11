import { encodeMetaJson, decodeMetaJson } from './metaCodec.js';

/**
 * Per-item metadata format — distinct from `streamMeta.js` (stream-level, a different JSON
 * shape entirely; kept in its own file rather than merged, since the two live at different
 * layers and have nothing to do with each other beyond both being "some JSON in a metadata
 * field", gzipped the same way via the shared `metaCodec.js`).
 *
 * An item's on-chain `meta` is opaque bytes to the contract. A typical use, and the one the
 * explorer's own "File" tab relies on, is carrying `{name, type}` — the original filename
 * and MIME type — so a UI can label a listed item and restore its real filename on download
 * instead of a generic `item-{index}.bin`.
 *
 * Deliberately **not encrypted**, even on an encrypted stream — same as stream-level meta,
 * and worth stating plainly in any UI built on this: a filename shouldn't be anything
 * sensitive.
 */

/**
 * @param {Object} [fields]
 * @param {?string} [fields.name]
 * @param {?string} [fields.type]
 * @returns {Uint8Array|undefined} `undefined` when there's nothing to store, so an item
 *   pushed with no name/type costs nothing extra on-chain.
 */
export function encodeItemMeta(fields = {}) {
	const out = {};
	if (fields.name) out.name = fields.name;
	if (fields.type) out.type = fields.type;
	return encodeMetaJson(out);
}

/**
 * @param {?Uint8Array} bytes
 * @returns {{name: ?string, type: ?string}}
 */
export function decodeItemMeta(bytes) {
	const { parsed } = decodeMetaJson(bytes);
	if (parsed) return { name: parsed.name || null, type: parsed.type || null };
	// Unlike streamMeta, a non-JSON (or absent) value is never treated as a legacy name —
	// itemMeta is a free-form field, other tools/scripts can legitimately put anything
	// there, and there's no established "the whole field was just a filename" convention
	// the way there was for a stream's own name.
	return { name: null, type: null };
}
