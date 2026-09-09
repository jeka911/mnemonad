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
 * `decodeStreamMeta` falls back to treating the whole decoded string as a legacy plain-text
 * name when it isn't valid JSON (or decodes to something that isn't a plain object) — no
 * migration needed for any stream created before this format existed, and nothing in this
 * app reads `meta` back today anyway (verified before introducing this format), so there is
 * no existing display path this could break.
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
	if (Object.keys(out).length === 0) return undefined;
	return new TextEncoder().encode(JSON.stringify(out));
}

/**
 * @param {?Uint8Array} bytes
 * @returns {{name: ?string, kek: ?{method: string, salt: string, iterations: number}}}
 */
export function decodeStreamMeta(bytes) {
	if (!bytes || bytes.length === 0) return { name: null, kek: null };
	let text;
	try {
		text = new TextDecoder().decode(bytes);
	} catch {
		return { name: null, kek: null };
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { name: parsed.name || null, kek: parsed.kek || null };
		}
	} catch {
		// Not JSON — a legacy plain-text name, or something this format doesn't recognize.
	}
	return { name: text || null, kek: null };
}
