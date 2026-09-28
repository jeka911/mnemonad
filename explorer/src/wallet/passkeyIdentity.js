/**
 * Remembers which passkey credential this browser last connected with, so "Sign in with an
 * existing passkey" can ask for that exact one instead of leaving WebAuthn to offer *any*
 * synced passkey matching this site.
 *
 * Why that ambiguity is worth closing: `createPasskeyWithPrfOutput` makes a brand-new
 * credential on every call (a fresh random `user.id`), and even a *failed* ceremony after the
 * creation step still leaves that passkey behind on the authenticator (see its own doc).
 * Anyone who hits "Create" more than once — testing, retrying after an earlier failure —
 * ends up with several credentials that all show the identical label in the OS picker (see
 * `passkeyLabel()` in passkeyConnector.js for the one piece of that this doesn't fix), and
 * "Sign in" can then resolve to a different one of them each time with no way to tell which.
 * Pinning the last-used credential turns that into "same browser → same account, every time".
 *
 * This is a preference, never a requirement: `passkeyConnector.js` only uses it as an
 * `allowCredential` hint, still falls back to an open discoverable-credential search if
 * nothing is remembered (a fresh browser, cleared storage), and `forgetPasskeyCredential`
 * exists specifically so a user can deliberately break out of a wrong pin — see
 * `PasskeyCard.vue`'s "Not this passkey?" link. Never a hard requirement, because that would
 * break the one thing that makes a passkey account worth having: opening the exact same
 * account on a second device the passkey has synced to, which necessarily starts with no
 * memory of any credential id at all.
 *
 * Storage is plain `localStorage`, not a secret store — a credential id identifies *which*
 * passkey to ask for, the same as a username would; it carries no signing authority on its
 * own and reveals nothing WebAuthn's own resident-credential list on the device doesn't
 * already have.
 */

const STORAGE_KEY = 'mnemonad.passkeyCredential';

function isCredential(value) {
	return !!value && typeof value === 'object' && typeof value.credentialId === 'string' && value.credentialId.length > 0;
}

/** @param {{credentialId: string, transports?: string[]}} credential */
export function rememberPasskeyCredential(credential) {
	if (!isCredential(credential)) return;
	try {
		const stored = { credentialId: credential.credentialId };
		if (credential.transports !== undefined) stored.transports = credential.transports;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
	} catch {
		// Storage unavailable (private mode, quota, disabled) — sign-in just falls back to the
		// open discoverable-credential search every time, same as a first-ever visit.
	}
}

/** @returns {?{credentialId: string, transports?: string[]}} */
export function getRememberedPasskeyCredential() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return isCredential(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function forgetPasskeyCredential() {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to undo if storage can't be touched at all.
	}
}
