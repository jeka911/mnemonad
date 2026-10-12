import { kekMethodOf } from '@mnemonad';

/**
 * Which key-encryption method a loaded stream uses, and what the UI is allowed to do about
 * it. One module so the pages, the add panel and the store all agree — the alternative is
 * the `kek?.method === 'password'` check that used to sit in three components, which read
 * every wallet-encrypted stream as permanently locked.
 *
 * The stream's published `kek` block is a *hint*, never the authority: stream metadata is
 * written once at creation and can never be corrected, while the owner can rewrap under a
 * different method at any time via `setEncKeyWrapped`. Only the GCM tag on the wrapped key
 * decides whether a credential actually works, so nothing here ever blocks an unlock
 * attempt — it only picks which credential to ask for first.
 */

/** @returns {boolean} whether this stream carries a wrapped key on chain at all */
export function isEncrypted(stream) {
	return !!(stream?.encKeyWrapped && stream.encKeyWrapped.length);
}

/**
 * @param {?Object} stream - a live `Mnemonad` instance (post-`initialize()`)
 * @returns {?('password'|'signature'|'passkey'|string)} `null` when the stream isn't encrypted
 */
export function methodOf(stream) {
	if (!stream) return null;
	return kekMethodOf({ kek: stream.streamMeta?.kek, encrypted: isEncrypted(stream) });
}

/** @returns {boolean} whether the unwrapped data key is already in hand for this session */
export function isUnlocked(stream) {
	return !!stream?.crypto?.getAesKey();
}

/**
 * Whether the stream still needs a credential before its items can be read or written.
 * Method-agnostic on purpose — every method has an unlock affordance now.
 */
export function isLocked(stream) {
	return isEncrypted(stream) && !isUnlocked(stream);
}

/**
 * Whether writes are safe right now. An encrypted stream that hasn't been unlocked has no
 * key to encrypt *with*, and the SDK's `_maybeEncrypt` silently no-ops without one — which
 * would write plaintext into a stream everything else assumes is encrypted.
 */
export function hasUsableKey(stream) {
	return !isEncrypted(stream) || isUnlocked(stream);
}

/** Short label for the credential this stream needs, for buttons and lock icons. */
export function methodLabel(stream) {
	const method = methodOf(stream);
	if (method === 'password') return 'password';
	if (method === 'passkey') return 'passkey';
	return 'owner wallet';
}
