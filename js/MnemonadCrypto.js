import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes, bytesToHex as toHex } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
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

/** Salt length for password-based key derivation — 128 bits, the standard recommendation. */
const PBKDF2_SALT_BYTES = 16;

/**
 * Default PBKDF2-HMAC-SHA256 iteration count for password-based key derivation.
 *
 * Deliberately high. Unlike the signature-based KEK — whose only "key" is possession of a
 * wallet, never exposed to anything this SDK stores — a password KEK's salt and iteration
 * count have to be public: a reader needs both to reproduce the KEK, so they end up in the
 * stream's (already-cleartext) metadata. Iteration cost is therefore the *only* thing
 * standing between a stolen wrapped key and an offline brute force of the password. 600,000
 * is OWASP's 2023 floor for PBKDF2-HMAC-SHA256; raise it per-stream via `passwordIterations`
 * if a slower, costlier derivation is worth the wait.
 */
const PBKDF2_ITERATIONS = 600_000;

/**
 * Client-side encryption companion for Mnemonad. Attached as `mnemonad.crypto` on every
 * instance; only "enabled" when a signer, a password, or an explicit AES key is supplied.
 *
 * A random AES-256-GCM data key is always generated at `create()` time; what differs is
 * only *how it gets wrapped* — the key-encryption key (KEK). Two methods exist today:
 *
 *   - **Signature-based** (`signer`): the KEK is derived from the owner's own signature.
 *     No third-party key-server network, no delegation, and losing the signing key loses
 *     the data. Because this KEK is intrinsically bound to one wallet, the contract refuses
 *     to transfer an encrypted stream wrapped this way — lifting that needs the
 *     propose/accept rewrap flow, which is not in v1 (see PLAN.md §3.9).
 *   - **Password-based** (`password`): the KEK is derived via PBKDF2-HMAC-SHA256 from a
 *     plaintext password plus a per-stream salt. Not owner-bound — anyone with the password
 *     can unwrap, regardless of wallet — but the salt and iteration count are necessarily
 *     public (they have to live somewhere a reader can find them before ever entering a
 *     password, typically the stream's own cleartext metadata), so the password's strength
 *     and the iteration count are the *only* defenses against offline brute force.
 *
 * The wrapped key is stored on-chain in `encKeyWrapped`, opaque to the contract either way.
 * That field is also what a future provider (e.g. Lit Protocol, WebAuthn PRF) would
 * populate instead, with no contract change — `wrapAesKey`/`unwrapAesKey` only need *some*
 * 32-byte KEK, not a specific way of getting one.
 *
 * The data key is always random and merely *wrapped* by whichever KEK, never derived
 * straight from it — that indirection is what makes re-wrapping for a new owner (or a
 * changed password) possible at all.
 *
 * The wrapped key itself (as opposed to item payloads, which use the framed layout below)
 * has a fixed layout: `nonce(12B) || ciphertext || tag(16B)` — 28 bytes of overhead,
 * regardless of KEK method.
 */
export default class MnemonadCrypto {
	/**
	 * @param {Object} params
	 * @param {Mnemonad} params.mnemonad - parent Mnemonad
	 * @param {?Object} [params.signer] - viem Account or WalletClient able to signMessage
	 * @param {?Uint8Array} [params.aesKey] - pre-known plaintext data key, skips unwrapping
	 * @param {?string} [params.password] - plaintext password; an alternative to `signer`
	 *   for deriving the key-encryption key. Must not be empty — an empty string is rejected
	 *   here rather than silently treated as "no password", since that mistake would
	 *   otherwise wrap the data key under a KEK derived from nothing.
	 * @param {?(string|Uint8Array)} [params.passwordSalt] - salt for the password KDF, as a
	 *   0x-prefixed hex string or raw bytes. A fresh one is generated on first use if
	 *   omitted — read it back via `getPasswordSalt()` and persist it (e.g. in the stream's
	 *   own metadata) so a later reader can supply the *same* salt to unwrap. Ignored unless
	 *   `password` is also given.
	 * @param {?number} [params.passwordIterations] - PBKDF2 iteration count; defaults to
	 *   `MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS`. Persist whatever value was actually used
	 *   alongside the salt — raising the default later must not change what an existing
	 *   stream needs to unwrap.
	 * @param {boolean} [params.encrypt=false] - request encryption when creating a stream
	 */
	constructor(params = {}) {
		/** @type {Mnemonad} */
		this._mnemonad = params.mnemonad || null;
		/** @type {?Object} */
		this._signer = params.signer || null;
		/** @type {?Uint8Array} - cached plaintext data key */
		this._aesKey = params.aesKey || null;

		if (params.password !== undefined && params.password !== null && params.password.length === 0) {
			throw new Error('crypto: password must not be empty');
		}
		// Rejected rather than resolved by precedence: `_deriveKek` has to pick one, and a
		// caller who supplied both has no way to know which it picked — the failure would
		// only show up later as a key that the *other* method can't unwrap.
		if (params.password && params.signer) {
			throw new Error(
				'crypto: pass either a password or a signer, not both — they derive different ' +
				'key-encryption keys, and a stream can only be wrapped under one of them'
			);
		}
		/** @type {?string} */
		this._password = params.password || null;
		/** @type {?Uint8Array} */
		this._passwordSalt = params.passwordSalt != null ? normalizeSalt(params.passwordSalt) : null;
		/** @type {number} */
		this._passwordIterations = params.passwordIterations || PBKDF2_ITERATIONS;

		/** @type {boolean} */
		this._encryptRequested = !!params.encrypt;
	}

	/**
	 * True iff this companion can wrap or unwrap keys. Callers gate behaviour on this.
	 * @returns {boolean}
	 */
	get isEnabled() {
		return !!(this._signer || this._aesKey || this._password);
	}

	/** @returns {number} The default PBKDF2 iteration count new password streams get. */
	static get DEFAULT_PBKDF2_ITERATIONS() {
		return PBKDF2_ITERATIONS;
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
	 * Generates a fresh salt for password-based key derivation. Callers that need to embed
	 * it in stream metadata before `create()` runs (so it exists to read back before ever
	 * prompting for the password) can generate it up front and pass it in as
	 * `params.passwordSalt`; otherwise `wrapAesKey`/`_deriveKekFromPassword` generates one
	 * lazily on first use and it's retrievable afterwards via `getPasswordSalt()`.
	 * @returns {Uint8Array}
	 */
	static generatePasswordSalt() {
		return randomBytes(PBKDF2_SALT_BYTES);
	}

	/** @param {Uint8Array} bytes @returns {string} 0x-prefixed hex */
	static saltToHex(bytes) {
		return `0x${toHex(bytes)}`;
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
	 * @returns {?Uint8Array} The salt in use for password-based key derivation, if any —
	 *   `null` until either supplied via the constructor or generated lazily on first wrap.
	 *   Persist this (e.g. `MnemonadCrypto.saltToHex(salt)` into stream metadata) so a later
	 *   reader can supply the same salt back in to unwrap.
	 */
	getPasswordSalt() {
		return this._passwordSalt;
	}

	/**
	 * @returns {?number} The iteration count in use for password-based key derivation, or
	 *   `null` when this instance isn't using the password method at all. Persist this
	 *   alongside the salt (see `getPasswordSalt()`) — raising the shipped default later
	 *   must not change what an existing stream needs to unwrap.
	 */
	getPasswordIterations() {
		return this._password ? this._passwordIterations : null;
	}

	/**
	 * This instance's stream-metadata `kek` block — the marker telling a later reader *which*
	 * method reproduces this stream's KEK, plus (password only) the public parameters needed
	 * to do it:
	 *
	 *   - password → `{method: 'password', salt, iterations}`. Both values have to be public:
	 *     a reader needs them before it can so much as prompt for a password. See
	 *     `streamMeta.js`'s own doc on why that's acceptable.
	 *   - signature → `{method: 'signature'}`. Owner-bound, so there is nothing to publish
	 *     beyond the method itself — the wallet is the secret, and everything the signed
	 *     message binds (chain id, contract, stream id) is already on chain.
	 *   - neither → `null`: an unencrypted stream, an instance holding only a raw `aesKey`,
	 *     or a password-based one whose salt doesn't exist yet.
	 *
	 * That last case matters: on a fresh instance constructed with a password but no
	 * explicit `passwordSalt`, one is only generated lazily on first `wrapAesKey()`/
	 * `unwrapAesKey()` call. Reading this getter never generates one as a side effect — it
	 * reports what's actually in hand right now, which is why `Mnemonad.create()` reads it
	 * only *after* `wrapAesKey()` has already run once for the stream being created.
	 *
	 * @returns {?{method: 'password'|'signature', salt?: string, iterations?: number}}
	 */
	getKekBlock() {
		// Same precedence `_deriveKek` itself uses, so the published marker can never
		// disagree with the method that actually wrapped the key.
		if (this._password) {
			if (!this._passwordSalt) return null;
			return {
				method: 'password',
				salt: MnemonadCrypto.saltToHex(this._passwordSalt),
				iterations: this._passwordIterations,
			};
		}
		if (this._signer) return { method: 'signature' };
		return null;
	}

	/**
	 * The password-method half of `getKekBlock()`, kept under its original name because it
	 * was the published API before signature streams had a marker of their own.
	 *
	 * @returns {?{method: 'password', salt: string, iterations: number}}
	 */
	getPasswordKek() {
		const kek = this.getKekBlock();
		return kek && kek.method === 'password' ? kek : null;
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
		try {
			return gcm(kek, nonce).decrypt(ct);
		} catch (err) {
			// The GCM tag is the only authority on whether a KEK is the right one, and its
			// own message ("aes-gcm: invalid tag") says nothing about *why*. Rethrow a
			// typed, self-explaining error so callers can branch on `err.code` instead of
			// string-matching, and so the common cases (wrong password, wrong wallet) read
			// as what they are rather than as a corrupt stream.
			const mismatch = new Error(
				'crypto.unwrapAesKey: the derived key-encryption key does not match the one ' +
				'this stream was wrapped with — wrong ' +
				(this._password ? 'password (or salt/iterations)' : 'wallet') + '?'
			);
			mismatch.code = 'KEK_MISMATCH';
			mismatch.cause = err;
			throw mismatch;
		}
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
		if (!this._signer && !this._password) {
			throw new Error('crypto: a signer or password is required to unwrap the encryption key');
		}

		this._aesKey = await this.unwrapAesKey(ev.encKeyWrapped);
		return this._aesKey;
	}

	/**
	 * Derives the key-encryption key, from whichever method this instance was given.
	 * @param {?bigint} [streamId]
	 * @returns {Promise<Uint8Array>}
	 */
	async _deriveKek(streamId = null) {
		if (this._password) return await this._deriveKekFromPassword();
		return await this._deriveKekFromSignature(streamId);
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
	async _deriveKekFromSignature(streamId = null) {
		if (!this._signer) {
			throw new Error('crypto: a signer or password is required to derive the key-encryption key');
		}
		const ev = this._mnemonad;
		const id = streamId ?? ev?.id;
		if (id === null || id === undefined) {
			throw new Error('crypto: a stream id is required to derive the key-encryption key');
		}
		// Every one of these binds into the signed message, so a missing one doesn't fail —
		// it silently derives a *different* key, which is the worst way for this to go wrong
		// (wrap succeeds, and the stream is then undecryptable by the very wallet that made
		// it). Both are populated by `_loadConstants()`, which every real caller runs first:
		// `Mnemonad.create()` before wrapping, `unlockWithSignature`/`_ensureAesKey` via
		// `initialize()` before unwrapping.
		if (ev?.chainId === null || ev?.chainId === undefined) {
			throw new Error(
				'crypto: chainId is unknown — initialize() the stream before deriving a ' +
				'signature-based key, or the derived key will not match the one it was wrapped with'
			);
		}
		if (!ev?.contractAddress) {
			throw new Error(
				'crypto: contractAddress is unknown — initialize() the stream before deriving a ' +
				'signature-based key, or the derived key will not match the one it was wrapped with'
			);
		}

		const message = [
			KEK_DOMAIN,
			`chainId:${ev.chainId}`,
			`contract:${ev.contractAddress.toLowerCase()}`,
			`stream:${id.toString()}`,
		].join('\n');

		const signature = await this._signMessage(message);
		const ikm = hexToBytes(signature);
		return hkdf(sha256, ikm, undefined, new TextEncoder().encode(KEK_DOMAIN), AES_KEY_BYTES);
	}

	/**
	 * Derives the key-encryption key from a password via PBKDF2-HMAC-SHA256.
	 *
	 * Unlike the signature-based KEK, there is no stream id to bind in — the salt itself
	 * provides that separation (a fresh one per stream means the same password never
	 * derives the same KEK twice). A salt is generated on first use if none was supplied;
	 * this only happens naturally when *wrapping* (creation) — unwrapping always needs the
	 * *same* salt the stream was created with, which the caller must supply via the
	 * constructor's `passwordSalt` (there is nowhere else for it to come from: this class
	 * never reads stream metadata itself).
	 *
	 * @returns {Promise<Uint8Array>}
	 */
	async _deriveKekFromPassword() {
		if (!this._password) {
			throw new Error('crypto: a password is required to derive the key-encryption key');
		}
		if (!this._passwordSalt) {
			this._passwordSalt = MnemonadCrypto.generatePasswordSalt();
		}
		return await pbkdf2Async(sha256, this._password, this._passwordSalt, {
			c: this._passwordIterations,
			dkLen: AES_KEY_BYTES,
		});
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

/**
 * Accepts a password salt as either raw bytes or a 0x-prefixed hex string — the latter is
 * what round-trips through JSON stream metadata.
 * @param {string|Uint8Array} value
 * @returns {Uint8Array}
 */
function normalizeSalt(value) {
	if (value instanceof Uint8Array) return value;
	if (typeof value === 'string') return hexToBytes(value);
	throw new Error('crypto: passwordSalt must be a hex string or Uint8Array');
}
