import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError } from '@category-labs/mera';
import { getRememberedPasskeyCredential } from './passkeyIdentity.js';

/**
 * Passkey-encrypted streams: the WebAuthn half of the SDK's `passkey` KEK method (see
 * `js/MnemonadCrypto.js` and docs/encryption/passkey.md).
 *
 * The SDK only ever calls `evaluate(salt)` and gets 32 bytes back — it never touches
 * WebAuthn, so it runs in Node too. This module is what runs the ceremony in the browser,
 * through Mera, with the stream's own salt instead of Mera's fixed default. That salt is
 * what keeps this apart from the passkey *wallet account* (`passkeyConnector.js`): the same
 * passkey yields an unrelated secret for every stream, and none of them is the account key.
 *
 * Independent of whatever wallet is connected. Someone signed in with a browser extension
 * can still key a stream to a passkey; the extension only pays for the transaction.
 */

const RELYING_PARTY_NAME = 'Mnemonad';

/** `user.name` for passkeys made here — kept apart from the wallet account's own name. */
const USER_NAME = 'mnemonad-stream-key';

const labelFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The site a passkey made here belongs to: the live hostname, for the same reason
 * `passkeyConnector.js` gives (a fixed production string would fail outright on localhost
 * and every preview deployment). It's published in the stream's metadata, because a
 * passkey only ever works on the domain that created it.
 */
export function currentRpId() {
	return window.location.hostname;
}

/**
 * Which passkey this browser last keyed a stream with, so "make the key" can go straight to
 * it — the same idea as `passkeyIdentity.js`'s pin for the passkey *account*, but its own
 * slot: a passkey made here for stream keys must never become the passkey "Sign in" lands
 * on, or signing in would open a different account. Reading falls back to the account's pin,
 * though — reusing the passkey someone already signs in with is the natural default.
 */
const STREAM_KEY_STORAGE_KEY = 'mnemonad.streamKeyPasskey';

/** @returns {?string} credential id of the passkey to use first, if this browser knows one */
export function getRememberedStreamPasskey() {
	try {
		const stored = localStorage.getItem(STREAM_KEY_STORAGE_KEY);
		if (stored) return stored;
	} catch {
		// Storage unavailable — fall through to the account pin, or to nothing.
	}
	return getRememberedPasskeyCredential()?.credentialId || null;
}

/** @param {string} credentialId */
export function rememberStreamPasskey(credentialId) {
	if (!credentialId) return;
	try {
		localStorage.setItem(STREAM_KEY_STORAGE_KEY, credentialId);
	} catch {
		// Next time just starts without a hint.
	}
}

/** The way out of a wrong pin, like PasskeyCard's "Not this passkey?". The account's own pin
 *  is left alone — it belongs to the Sign In dialog. */
export function forgetStreamPasskey() {
	try {
		localStorage.removeItem(STREAM_KEY_STORAGE_KEY);
	} catch {
		// Nothing to undo.
	}
}

/** Whether this browser can run a passkey ceremony at all. Actual PRF support is only
 *  knowable by trying (Mera's `PRF_UNAVAILABLE`), the same as for passkey accounts. */
export function passkeysAvailable() {
	return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

/**
 * Builds the `passkey` provider `Mnemonad.create()` / `unlockWithPasskey()` take.
 *
 * @param {Object} [params]
 * @param {'existing'|'create'} [params.mode='existing'] - `existing` asks for a passkey this
 *   site already has (any of them, unless `credentialId` narrows it); `create` registers a
 *   new one. A new one may ask twice on authenticators that don't return the PRF value at
 *   creation — Mera runs the second ceremony itself.
 * @param {?string} [params.credentialId] - the passkey to ask for — what a stream's own
 *   `streamMeta.kek.credentialId` holds, so unlocking goes straight to the right one.
 * @param {?string} [params.label] - shown in the OS passkey list when creating.
 * @param {() => void} [params.onPrompt] - called right before the ceremony, so a dialog can
 *   say a passkey prompt is on screen.
 * @param {() => void} [params.onDone] - called once the ceremony has succeeded. Not on
 *   failure, so a dialog still knows it was the passkey step that failed.
 * @returns {{rpId: string, credentialId: ?string, evaluate: (salt: Uint8Array) => Promise<{output: Uint8Array, credentialId: string}>}}
 */
export function passkeyKekProvider({ mode = 'existing', credentialId = null, label = null, onPrompt, onDone } = {}) {
	const rpId = currentRpId();
	return {
		rpId,
		credentialId,
		async evaluate(salt) {
			onPrompt?.();
			try {
				const result = mode === 'create'
					? await createPasskeyWithPrfOutput({
						rp: { id: rpId, name: RELYING_PARTY_NAME },
						user: { name: USER_NAME, displayName: label || `Stream key ${labelFormat.format(new Date())}` },
						prfSalt: salt,
					})
					: await getPasskeyPrfOutput({
						rpId,
						prfSalt: salt,
						...(credentialId ? { credential: { credentialId } } : {}),
					});
				onDone?.();
				return { output: result.prfOutput, credentialId: result.credentialId };
			} catch (error) {
				throw describePasskeyError(error);
			}
		},
	};
}

/** Mera's typed errors, in words a dialog can show as-is. */
export function describePasskeyError(error) {
	if (isMeraError(error)) {
		console.error('[passkeyPrf]', error.code, error.message, error.cause);
		if (error.code === 'PRF_UNAVAILABLE') {
			return new Error("This passkey's authenticator can't derive encryption keys (no PRF support). Pick another passkey or another method.");
		}
		if (error.code === 'PASSKEY_OPERATION_FAILED') {
			return new Error('Passkey request cancelled or unavailable.');
		}
		if (error.code === 'CRYPTO_UNAVAILABLE') {
			return new Error('This browser is missing a required security feature (Web Crypto).');
		}
	}
	return error;
}
