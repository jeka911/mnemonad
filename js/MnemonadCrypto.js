import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * @typedef {import('./Mnemonad.js').default} Mnemonad
 */

const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;

/** Domain separator for the key-wrapping signature. Changing it invalidates every key. */
const KEK_DOMAIN = 'mnemonad:kek:v1';

/**
 * Item ciphertext format version. Version 2 is framed (see below); version 1 was a single
 * GCM message per item and is not readable by this SDK.
 */
const FORMAT_VERSION = 2;

/**
 * Header: `version(1) || log2FrameSize(1) || baseNonce(8)`.
 *
 * Ten bytes plus one 16-byte tag per frame. For a small single-frame item that is 26 bytes
 * of overhead — slightly less than the 28 a single-shot GCM message cost — so framing is
 * not paid for at small sizes.
 */
const HEADER_BYTES = 10;
const BASE_NONCE_BYTES = 8;

/** 64 KiB frames: ~1 KB of tags per 4 MB item, and a small enough unit to fetch alone. */
const DEFAULT_LOG2_FRAME_SIZE = 16;

/**
 * Client-side encryption companion for Mnemonad. Attached as `mnemonad.crypto` on every
 * instance; only "enabled" when a signer (or an explicit AES key) is supplied.
 *
 * v1 is **self-wrapped**: a random AES-256-GCM data key is wrapped under a KEK derived
 * from the owner's own signature. No third-party key-server network, no delegation, and
 * losing the signing key loses the data.
 *
 * The wrapped key is stored on-chain in `encKeyWrapped`. That field is what a future
 * provider (e.g. Lit Protocol) would populate instead, with no contract change.
 *
 * Two consequences worth knowing:
 *   - The data key is random and merely *wrapped* by the signature-derived KEK, not
 *     derived from it. That indirection is what makes re-wrapping for a new owner possible
 *     at all — deriving the data key straight from a signature would bind the ciphertext to
 *     one signer forever.
 *   - Because a wrapped key is bound to its owner, the contract refuses to transfer an
 *     encrypted stream. Lifting that needs the propose/accept rewrap flow, which is not in
 *     v1 (see PLAN.md §3.9).
 *
 * The wrapped key itself (as opposed to item payloads, which use the framed layout below)
 * has a fixed layout: `nonce(12B) || ciphertext || tag(16B)` — 28 bytes of overhead.
 */
export default class MnemonadCrypto {
	/**
	 * @param {Object} params
	 * @param {Mnemonad} params.mnemonad - parent Mnemonad
	 * @param {?Object} [params.signer] - viem Account or WalletClient able to signMessage
	 * @param {?Uint8Array} [params.aesKey] - pre-known plaintext data key, skips unwrapping
	 * @param {boolean} [params.encrypt=false] - request encryption when creating a stream
	 */
	constructor(params = {}) {
		/** @type {Mnemonad} */
		this._mnemonad = params.mnemonad || null;
		/** @type {?Object} */
		this._signer = params.signer || null;
		/** @type {?Uint8Array} - cached plaintext data key */
		this._aesKey = params.aesKey || null;
		/** @type {boolean} */
		this._encryptRequested = !!params.encrypt;
	}

	/**
	 * True iff this companion can wrap or unwrap keys. Callers gate behaviour on this.
	 * @returns {boolean}
	 */
	get isEnabled() {
		return !!(this._signer || this._aesKey);
	}

	/** @returns {boolean} Whether `create()` was asked to produce an encrypted stream. */
	get isEncryptRequested() {
		return this._encryptRequested;
	}

	/** Generates a fresh AES-256 data key — used at `create()` time. */
	static generateAesKey() {
		return randomBytes(AES_KEY_BYTES);
	}

	/**
	 * Caches a plaintext data key, so the first push or read needn't unwrap.
	 * @param {Uint8Array} key
	 */
	setAesKey(key) {
		if (!(key instanceof Uint8Array) || key.length !== AES_KEY_BYTES) {
			throw new Error(`crypto: key must be a ${AES_KEY_BYTES}-byte Uint8Array`);
		}
		this._aesKey = key;
	}

	/** @returns {?Uint8Array} The cached plaintext data key, if any. */
	getAesKey() {
		return this._aesKey;
	}

	/**
	 * Wraps a data key so it can be stored on-chain. The caller stores the result via
	 * `setEncKeyWrapped` (or passes it to `create()`).
	 *
	 * @param {Uint8Array} aesKey
	 * @param {?bigint} [streamId] - target stream id; defaults to the parent's. Accepted
	 *        explicitly because ids are deterministic and therefore known BEFORE creation,
	 *        which is what allows create + key + push in a single transaction.
	 * @returns {Promise<Uint8Array>} `nonce || ciphertext || tag`
	 */
	async wrapAesKey(aesKey, streamId = null) {
		const kek = await this._deriveKek(streamId);
		const nonce = randomBytes(AES_NONCE_BYTES);
		const ct = gcm(kek, nonce).encrypt(aesKey);
		const out = new Uint8Array(AES_NONCE_BYTES + ct.length);
		out.set(nonce, 0);
		out.set(ct, AES_NONCE_BYTES);
		return out;
	}

	/**
	 * Unwraps a data key read from `encKeyWrapped`.
	 * @param {Uint8Array} wrapped
	 * @param {?bigint} [streamId]
	 * @returns {Promise<Uint8Array>}
	 */
	async unwrapAesKey(wrapped, streamId = null) {
		if (wrapped.length < AES_NONCE_BYTES + AES_TAG_BYTES) {
			throw new Error(`crypto.unwrapAesKey: wrapped key too short (${wrapped.length})`);
		}
		const kek = await this._deriveKek(streamId);
		const nonce = wrapped.subarray(0, AES_NONCE_BYTES);
		const ct = wrapped.subarray(AES_NONCE_BYTES);
		return gcm(kek, nonce).decrypt(ct);
	}

	/**
	 * Encrypts a single item before push, in independently-decryptable frames.
	 *
	 * Framing is what makes partial reads possible. A single GCM message per item would put
	 * one tag over the whole ciphertext, so reading one byte of a 4 MB item would mean
	 * fetching and authenticating all 4 MB — random access would exist for plaintext items
	 * and silently not for encrypted ones.
	 *
	 * Each frame is bound to its position, which is what keeps naive framing from being
	 * insecure: the AAD carries the frame index (blocking reordering and replay across
	 * positions) and a final-frame flag (blocking truncation, since dropping the real last
	 * frame leaves a reader expecting a final frame it never sees). This is the STREAM
	 * construction, as used by age and libsodium's secretstream.
	 *
	 * Layout: `version(1) || log2FrameSize(1) || baseNonce(8)`, then per frame
	 * `GCM(key, baseNonce||u32be(i), plaintext_i, aad_i)` including its 16-byte tag.
	 * Every frame but the last holds exactly `frameSize` plaintext bytes.
	 *
	 * @param {Uint8Array} plaintext
	 * @param {Object} [params={}]
	 * @param {number} [params.log2FrameSize=16]
	 * @returns {Promise<Uint8Array>}
	 */
	async encryptItem(plaintext, params = {}) {
		const key = await this._ensureAesKey();
		const log2FrameSize = params.log2FrameSize ?? DEFAULT_LOG2_FRAME_SIZE;
		if (log2FrameSize < 5 || log2FrameSize > 30) {
			throw new Error(`crypto: log2FrameSize out of range (${log2FrameSize})`);
		}
		const frameSize = 1 << log2FrameSize;
		const baseNonce = randomBytes(BASE_NONCE_BYTES);

		const frameCount = Math.max(1, Math.ceil(plaintext.length / frameSize));
		const out = new Uint8Array(HEADER_BYTES + plaintext.length + frameCount * AES_TAG_BYTES);
		out[0] = FORMAT_VERSION;
		out[1] = log2FrameSize;
		out.set(baseNonce, 2);

		let cursor = HEADER_BYTES;
		for (let i = 0; i < frameCount; i += 1) {
			const from = i * frameSize;
			const to = Math.min(from + frameSize, plaintext.length);
			const isFinal = i === frameCount - 1;
			const frame = gcm(
				key,
				MnemonadCrypto._frameNonce(baseNonce, i),
				MnemonadCrypto._frameAad(i, isFinal)
			).encrypt(plaintext.subarray(from, to));
			out.set(frame, cursor);
			cursor += frame.length;
		}
		return out;
	}

	/**
	 * Decrypts a whole item.
	 * @param {Uint8Array} payload
	 * @returns {Promise<Uint8Array>}
	 */
	async decryptItem(payload) {
		const layout = MnemonadCrypto.parseLayout(payload);
		const out = new Uint8Array(layout.plaintextLength);
		let outPos = 0;
		for (let i = 0; i < layout.frameCount; i += 1) {
			const frame = payload.subarray(
				layout.frameOffset(i),
				layout.frameOffset(i) + layout.frameCipherLength(i)
			);
			const plain = await this.decryptFrame(frame, i, i === layout.frameCount - 1, layout);
			out.set(plain, outPos);
			outPos += plain.length;
		}
		return out;
	}

	/**
	 * Decrypts one frame in isolation. The primitive behind partial and streaming reads.
	 *
	 * @param {Uint8Array} frameCiphertext - frame body including its tag
	 * @param {number} index
	 * @param {boolean} isFinal
	 * @param {Object} layout - from `parseLayout` or `parseHeader`
	 * @returns {Promise<Uint8Array>}
	 */
	async decryptFrame(frameCiphertext, index, isFinal, layout) {
		const key = await this._ensureAesKey();
		return gcm(
			key,
			MnemonadCrypto._frameNonce(layout.baseNonce, index),
			MnemonadCrypto._frameAad(index, isFinal)
		).decrypt(frameCiphertext);
	}

	/**
	 * Reads the 10-byte header and derives the full frame layout from the ciphertext length.
	 *
	 * A reader therefore needs only the header plus the on-chain item size to locate any
	 * frame — no scan, no trial decryption.
	 *
	 * @param {Uint8Array} header - at least the first HEADER_BYTES bytes
	 * @param {number} ciphertextLength - total item size on-chain
	 * @returns {Object} layout
	 */
	static parseHeader(header, ciphertextLength) {
		if (header.length < HEADER_BYTES) {
			throw new Error(`crypto: header too short (${header.length})`);
		}
		if (header[0] !== FORMAT_VERSION) {
			throw new Error(
				`crypto: unsupported ciphertext format version ${header[0]} (expected ${FORMAT_VERSION})`
			);
		}
		const log2FrameSize = header[1];
		if (log2FrameSize < 5 || log2FrameSize > 30) {
			throw new Error(`crypto: bad log2FrameSize in header (${log2FrameSize})`);
		}
		const frameSize = 1 << log2FrameSize;
		const baseNonce = header.slice(2, 2 + BASE_NONCE_BYTES);

		const body = ciphertextLength - HEADER_BYTES;
		if (body <= 0) throw new Error(`crypto: ciphertext too short (${ciphertextLength})`);

		// body === frameCount*TAG + plaintextLength, and every frame but the last is full.
		// With plaintextLength = (n-1)*F + r and 1 <= r <= F:
		//   r === F  → body is an exact multiple of (F+TAG)
		//   r <  F   → floor(body/(F+TAG)) === n-1
		const perFullFrame = frameSize + AES_TAG_BYTES;
		const frameCount =
			body % perFullFrame === 0
				? body / perFullFrame
				: Math.floor(body / perFullFrame) + 1;
		const plaintextLength = body - frameCount * AES_TAG_BYTES;
		if (plaintextLength < 0) {
			throw new Error(`crypto: inconsistent ciphertext length (${ciphertextLength})`);
		}

		return {
			version: FORMAT_VERSION,
			frameSize,
			baseNonce,
			frameCount,
			plaintextLength,
			ciphertextLength,
			headerBytes: HEADER_BYTES,
			/** Ciphertext offset where frame `i` begins. */
			frameOffset: (i) => HEADER_BYTES + i * perFullFrame,
			/** Ciphertext length of frame `i`, including its tag. */
			frameCipherLength: (i) =>
				i === frameCount - 1
					? plaintextLength - (frameCount - 1) * frameSize + AES_TAG_BYTES
					: perFullFrame,
			/** Plaintext offset where frame `i` begins. */
			framePlainOffset: (i) => i * frameSize,
		};
	}

	/**
	 * Layout for a payload already held whole in memory.
	 * @param {Uint8Array} payload
	 * @returns {Object} layout
	 */
	static parseLayout(payload) {
		if (payload.length < HEADER_BYTES + AES_TAG_BYTES) {
			throw new Error(`crypto.decryptItem: payload too short (${payload.length})`);
		}
		return MnemonadCrypto.parseHeader(payload, payload.length);
	}

	/**
	 * Frames covering plaintext range `[start, start+len)`.
	 * @param {Object} layout
	 * @param {number} start
	 * @param {number} len
	 * @returns {{first: number, last: number}}
	 */
	static framesForRange(layout, start, len) {
		if (start < 0 || len < 0 || start + len > layout.plaintextLength) {
			throw new Error(
				`crypto: range ${start}..${start + len} outside item of ${layout.plaintextLength} bytes`
			);
		}
		if (len === 0) return { first: 0, last: -1 };
		return {
			first: Math.floor(start / layout.frameSize),
			last: Math.floor((start + len - 1) / layout.frameSize),
		};
	}

	/** Ciphertext bytes needed to cover the plaintext bytes of frames `first..last`. */
	static cipherSpanForFrames(layout, first, last) {
		const offset = layout.frameOffset(first);
		let length = 0;
		for (let i = first; i <= last; i += 1) length += layout.frameCipherLength(i);
		return { offset, length };
	}

	/** @returns {number} Ciphertext size an item of `plaintextLength` bytes will occupy. */
	static ciphertextLengthFor(plaintextLength, log2FrameSize = DEFAULT_LOG2_FRAME_SIZE) {
		const frameSize = 1 << log2FrameSize;
		const frameCount = Math.max(1, Math.ceil(plaintextLength / frameSize));
		return HEADER_BYTES + plaintextLength + frameCount * AES_TAG_BYTES;
	}

	/** @param {Uint8Array} baseNonce @param {number} index */
	static _frameNonce(baseNonce, index) {
		const nonce = new Uint8Array(AES_NONCE_BYTES);
		nonce.set(baseNonce, 0);
		nonce[8] = (index >>> 24) & 0xff;
		nonce[9] = (index >>> 16) & 0xff;
		nonce[10] = (index >>> 8) & 0xff;
		nonce[11] = index & 0xff;
		return nonce;
	}

	/**
	 * Additional authenticated data binding a frame to its position and finality.
	 * @param {number} index
	 * @param {boolean} isFinal
	 */
	static _frameAad(index, isFinal) {
		return new Uint8Array([
			FORMAT_VERSION,
			isFinal ? 1 : 0,
			(index >>> 24) & 0xff,
			(index >>> 16) & 0xff,
			(index >>> 8) & 0xff,
			index & 0xff,
		]);
	}

	/**
	 * Resolves the plaintext data key: returns the cached one, else fetches the wrapped key
	 * from the stream's on-chain state and unwraps it.
	 * @returns {Promise<Uint8Array>}
	 */
	async _ensureAesKey() {
		if (this._aesKey) return this._aesKey;

		const ev = this._mnemonad;
		if (!ev) throw new Error('crypto: no parent Mnemonad');
		await ev.initialize();

		if (!ev.encKeyWrapped || ev.encKeyWrapped.length === 0) {
			throw new Error('crypto: stream has no encryption key on-chain');
		}
		if (!this._signer) {
			throw new Error('crypto: a signer is required to unwrap the encryption key');
		}

		this._aesKey = await this.unwrapAesKey(ev.encKeyWrapped);
		return this._aesKey;
	}

	/**
	 * Derives the key-encryption key from an owner signature.
	 *
	 * The signed message binds chain id, contract address and stream id, so the same wallet
	 * produces a different KEK per stream and a key wrapped on one deployment cannot be
	 * replayed against another.
	 *
	 * @param {?bigint} [streamId]
	 * @returns {Promise<Uint8Array>}
	 */
	async _deriveKek(streamId = null) {
		if (!this._signer) {
			throw new Error('crypto: a signer is required to derive the key-encryption key');
		}
		const ev = this._mnemonad;
		const id = streamId ?? ev?.id;
		if (id === null || id === undefined) {
			throw new Error('crypto: a stream id is required to derive the key-encryption key');
		}

		const message = [
			KEK_DOMAIN,
			`chainId:${ev?.chainId ?? 0}`,
			`contract:${(ev?.contractAddress ?? '').toLowerCase()}`,
			`stream:${id.toString()}`,
		].join('\n');

		const signature = await this._signMessage(message);
		const ikm = hexToBytes(signature);
		return hkdf(sha256, ikm, undefined, new TextEncoder().encode(KEK_DOMAIN), AES_KEY_BYTES);
	}

	/**
	 * Signs a message with whatever signer shape was supplied — a viem WalletClient, a
	 * viem Account, or anything exposing `signMessage`.
	 * @param {string} message
	 * @returns {Promise<string>} 0x-prefixed signature
	 */
	async _signMessage(message) {
		const signer = this._signer;
		if (typeof signer.signMessage !== 'function') {
			throw new Error('crypto: signer must expose signMessage()');
		}
		// A viem WalletClient needs an explicit account; a raw Account does not.
		if (signer.account) {
			return await signer.signMessage({ account: signer.account, message });
		}
		return await signer.signMessage({ message });
	}
}

/**
 * @param {string} hex - 0x-prefixed hex string
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
	const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = parseInt(clean.substr(i * 2, 2), 16);
	}
	return out;
}
