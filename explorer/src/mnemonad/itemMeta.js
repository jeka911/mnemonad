/**
 * Per-item metadata format — distinct from `streamMeta.js` (stream-level, a different JSON
 * shape entirely; kept in its own file rather than merged, since the two live at different
 * layers and have nothing to do with each other beyond both being "some JSON in a metadata
 * field").
 *
 * An item's on-chain `meta` is opaque bytes to the contract. For a file pushed via the
 * "File" tab, it carries `{name, type}` — the original filename and MIME type — so the item
 * list can label it and Download can restore the real filename instead of a generic
 * `item-{index}.bin`.
 *
 * Deliberately **not encrypted**, even on an encrypted stream — same as stream-level meta,
 * and worth stating plainly in the UI: a filename shouldn't be anything sensitive.
 */

/**
 * @param {Object} [fields]
 * @param {?string} [fields.name]
 * @param {?string} [fields.type]
 * @returns {Uint8Array|undefined} `undefined` when there's nothing to store, so an item
 *   pushed with no name/type (every existing tab) costs nothing extra on-chain.
 */
export function encodeItemMeta(fields = {}) {
	const out = {};
	if (fields.name) out.name = fields.name;
	if (fields.type) out.type = fields.type;
	if (Object.keys(out).length === 0) return undefined;
	return new TextEncoder().encode(JSON.stringify(out));
}

/**
 * @param {?Uint8Array} bytes
 * @returns {{name: ?string, type: ?string}}
 */
export function decodeItemMeta(bytes) {
	if (!bytes || bytes.length === 0) return { name: null, type: null };
	let text;
	try {
		text = new TextDecoder().decode(bytes);
	} catch {
		return { name: null, type: null };
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { name: parsed.name || null, type: parsed.type || null };
		}
	} catch {
		// Not JSON — some other per-item metadata this format doesn't recognize. Not an
		// error: itemMeta is a free-form field, other tools/scripts can put anything there.
	}
	return { name: null, type: null };
}
