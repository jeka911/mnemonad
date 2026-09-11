import { describe, it, expect } from 'vitest';
import { encodeMetaJson, decodeMetaJson } from '../metaCodec.js';
import { encodeStreamMeta, decodeStreamMeta } from '../streamMeta.js';
import { encodeItemMeta, decodeItemMeta } from '../itemMeta.js';

/**
 * Pure unit tests — no chain, no node. `Mnemonad.streamMeta`/`MnemonadItem.itemMeta` (the
 * getters built on top of these) are covered end to end against a real stream in
 * `base.test.js`'s own `describe('metadata', ...)`; this file is only about the encode/
 * decode logic itself: the gzip-or-plain size choice, and tolerant decoding of whatever
 * either produced (or of something from before this format, or gzip, existed at all).
 */

describe('metaCodec', () => {
	it('returns undefined for an empty object — nothing to store costs nothing on chain', () => {
		expect(encodeMetaJson({})).toBeUndefined();
	});

	it('round-trips a small object, choosing whichever encoding is actually smaller', () => {
		// A bare short field loses to gzip (measured: header/trailer overhead alone exceeds
		// what there is to compress) — this must come back exactly as plain JSON bytes.
		const small = { name: 'a' };
		const smallEncoded = encodeMetaJson(small);
		expect(smallEncoded.length).toBe(new TextEncoder().encode(JSON.stringify(small)).length);
		expect(decodeMetaJson(smallEncoded)).toEqual({ parsed: small, legacyText: null });

		// A larger, more repetitive object wins from gzip — this must come back smaller than
		// its own plain JSON encoding would have been, not just "some valid encoding".
		const large = { name: 'a'.repeat(200) };
		const largeEncoded = encodeMetaJson(large);
		expect(largeEncoded.length).toBeLessThan(new TextEncoder().encode(JSON.stringify(large)).length);
		expect(decodeMetaJson(largeEncoded)).toEqual({ parsed: large, legacyText: null });
	});

	it('never produces gzip output for a payload gzip could not shrink', () => {
		// Same assertion as above stated as its own invariant: encodeMetaJson must never
		// make an on-chain write MORE expensive than plain JSON would have been.
		for (const fields of [{ name: 'x' }, { a: 1, b: 2 }, { name: 'photo.jpg', type: 'image/jpeg' }]) {
			const plainLen = new TextEncoder().encode(JSON.stringify(fields)).length;
			expect(encodeMetaJson(fields).length).toBeLessThanOrEqual(plainLen);
		}
	});

	it('falls back to legacy plain text for bytes that are not gzip and not JSON', () => {
		const legacy = new TextEncoder().encode('My Old Stream Name');
		expect(decodeMetaJson(legacy)).toEqual({ parsed: null, legacyText: 'My Old Stream Name' });
	});

	it('treats an empty/absent byte array as nothing at all', () => {
		expect(decodeMetaJson(undefined)).toEqual({ parsed: null, legacyText: null });
		expect(decodeMetaJson(null)).toEqual({ parsed: null, legacyText: null });
		expect(decodeMetaJson(new Uint8Array())).toEqual({ parsed: null, legacyText: null });
	});

	it('does not mistake a JSON array for a metadata object', () => {
		const bytes = new TextEncoder().encode(JSON.stringify([1, 2, 3]));
		// An array parses as valid JSON but isn't the plain-object shape this format
		// expects — falls through to being reported as legacy text instead, same as any
		// other JSON value that isn't a plain object (a string, a number, `null`).
		expect(decodeMetaJson(bytes)).toEqual({ parsed: null, legacyText: '[1,2,3]' });
	});
});

describe('streamMeta', () => {
	it('round-trips name and kek together', () => {
		const kek = { method: 'password', salt: `0x${'11'.repeat(16)}`, iterations: 600_000 };
		const encoded = encodeStreamMeta({ name: 'My Documents', kek });
		expect(decodeStreamMeta(encoded)).toEqual({ name: 'My Documents', kek });
	});

	it('omits kek entirely for an unencrypted stream, and stores nothing at all for neither field', () => {
		expect(decodeStreamMeta(encodeStreamMeta({ name: 'Plain Stream' }))).toEqual({
			name: 'Plain Stream',
			kek: null,
		});
		expect(encodeStreamMeta({})).toBeUndefined();
		expect(encodeStreamMeta()).toBeUndefined();
	});

	it('reads a legacy pre-JSON plain-text name as `name`, with no kek', () => {
		const legacy = new TextEncoder().encode('A Name From Before This Format Existed');
		expect(decodeStreamMeta(legacy)).toEqual({
			name: 'A Name From Before This Format Existed',
			kek: null,
		});
	});

	it('decodes an absent/empty meta field to nulls, not a throw', () => {
		expect(decodeStreamMeta(undefined)).toEqual({ name: null, kek: null });
		expect(decodeStreamMeta(new Uint8Array())).toEqual({ name: null, kek: null });
	});
});

describe('itemMeta', () => {
	it('round-trips name and type together', () => {
		const encoded = encodeItemMeta({ name: 'photo.jpg', type: 'image/jpeg' });
		expect(decodeItemMeta(encoded)).toEqual({ name: 'photo.jpg', type: 'image/jpeg' });
	});

	it('stores nothing at all when neither field is given', () => {
		expect(encodeItemMeta({})).toBeUndefined();
		expect(encodeItemMeta()).toBeUndefined();
	});

	it('never treats non-JSON bytes as a legacy name — unlike streamMeta, itemMeta is a free-form field', () => {
		const bytes = new TextEncoder().encode('some other tool wrote this');
		expect(decodeItemMeta(bytes)).toEqual({ name: null, type: null });
	});

	it('decodes an absent/empty meta field to nulls, not a throw', () => {
		expect(decodeItemMeta(undefined)).toEqual({ name: null, type: null });
		expect(decodeItemMeta(new Uint8Array())).toEqual({ name: null, type: null });
	});
});
