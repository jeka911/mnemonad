<template>
	<div class="passkey-card">
		<template v-if="!supported">
			<p class="warning warning--blocking">
				Passkeys aren't supported in this browser. Try a recent Chrome, Edge, or Safari.
			</p>
		</template>
		<template v-else>
			<p class="hint">
				No password, no seed phrase — your device's passkey (Face ID, a fingerprint, or
				your screen lock) is the account. <strong>There is no recovery path</strong> if
				the passkey and every device it's synced to (iCloud Keychain, Google Password
				Manager) are lost — same tradeoff as encrypting a stream to your wallet.
			</p>

			<!-- No API can tell us "does a passkey already exist for this site" without running a
			     real ceremony — WebAuthn deliberately doesn't expose that (see
			     docs/wallet/passkey-accounts.md). hasRememberedCredential is the one honest signal
			     we have, so it decides which action leads: sign-in first and filled once this
			     browser has pinned a credential, create first otherwise. -->
			<template v-if="hasRememberedCredential">
				<GradientButton
					label="Sign in with an existing passkey"
					loading-label="Waiting for your passkey..."
					:loading="connectingMode === 'signin'"
					:disable="!!connectingMode"
					@click="run('signin')"
				/>
				<GradientButton
					label="Create a new passkey account"
					loading-label="Waiting for your passkey..."
					:loading="connectingMode === 'create'"
					:disable="!!connectingMode"
					outline
					@click="run('create')"
				/>
			</template>
			<template v-else>
				<GradientButton
					label="Create a new passkey account"
					loading-label="Waiting for your passkey..."
					:loading="connectingMode === 'create'"
					:disable="!!connectingMode"
					@click="run('create')"
				/>
				<GradientButton
					label="Sign in with an existing passkey"
					loading-label="Waiting for your passkey..."
					:loading="connectingMode === 'signin'"
					:disable="!!connectingMode"
					outline
					@click="run('signin')"
				/>
			</template>

			<button
				v-if="hasRememberedCredential"
				type="button"
				class="link-btn"
				:disabled="!!connectingMode"
				@click="useDifferentPasskey"
			>
				Not this passkey? Forget it and choose again
			</button>

			<p class="hint hint--small">
				Creating one may prompt twice — some authenticators need a second check right
				after registering.
			</p>

			<p v-if="error" class="error">{{ error }}</p>
		</template>
	</div>
</template>

<script>
import GradientButton from '../components/GradientButton.vue';
import { connectPasskeySigner } from './connectPasskeySigner.js';
import { getRememberedPasskeyCredential, forgetPasskeyCredential } from './passkeyIdentity.js';

/**
 * The passkey half of the wallet picker: create a brand-new passkey-derived account, or sign
 * back into one already registered — no extension, no typed-in key. See
 * `passkeyConnector.js` and `docs/wallet/passkey-accounts.md` for how the account is derived
 * and what it does and doesn't recover from.
 *
 * Mirrors `LocalSignerCard.vue`'s shape (a self-contained card owning its own connect flow,
 * emitting `connected` on success) but with two actions instead of one field, since "create"
 * and "sign in" are genuinely different WebAuthn ceremonies — not two labels on one button.
 */
export default {
	name: 'PasskeyCard',
	components: { GradientButton },
	emits: ['connected'],
	data() {
		return {
			// Null when idle, otherwise which button is mid-ceremony — drives that button's
			// own loading state and disables the other one, rather than one shared boolean
			// that can't say which action is actually running.
			connectingMode: null,
			error: null,
			// Whether the WebAuthn credential API exists at all — cheap and synchronous.
			// Actual PRF support isn't checkable up front (Mera exposes no capability probe;
			// see docs/wallet/passkey-accounts.md) — that only surfaces from an attempted
			// ceremony, as the PRF_UNAVAILABLE error `passkeyConnector.js` already handles.
			supported: typeof navigator !== 'undefined' && !!navigator.credentials && !!window.PublicKeyCredential,
			// Whether this browser has a credential pinned from an earlier connect (see
			// passkeyIdentity.js) — the "Not this passkey?" escape hatch only makes sense to
			// show when there's actually a pin it would clear.
			hasRememberedCredential: !!getRememberedPasskeyCredential(),
		};
	},
	methods: {
		async run(mode) {
			if (this.connectingMode) return;
			this.connectingMode = mode;
			this.error = null;
			try {
				await connectPasskeySigner(mode);
				this.$emit('connected');
			} catch (e) {
				this.error = e?.message || 'Failed to connect with a passkey.';
			} finally {
				this.connectingMode = null;
			}
		},
		/**
		 * The deliberate way out of a wrong pin — see passkeyConnector.js's own doc on why
		 * this can't just be an automatic retry-without-the-hint on failure: WebAuthn can't
		 * tell us "that credential isn't here" apart from "the user cancelled", so guessing
		 * would mean silently re-prompting someone who'd genuinely just declined.
		 */
		async useDifferentPasskey() {
			forgetPasskeyCredential();
			this.hasRememberedCredential = false;
			await this.run('signin');
		},
	},
};
</script>

<style scoped>
.passkey-card {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.hint {
	font-size: 12px;
	line-height: 1.5;
	opacity: 0.85;
	margin: 0;
}

.hint--small {
	font-size: 11px;
	opacity: 0.7;
}

.link-btn {
	align-self: flex-start;
	padding: 0;
	border: none;
	background: none;
	font: inherit;
	font-size: 11px;
	color: var(--q-primary, #836ef9);
	text-decoration: underline;
	text-underline-offset: 2px;
	cursor: pointer;
}

.link-btn:disabled {
	opacity: 0.5;
	cursor: default;
}

.warning--blocking {
	color: var(--q-negative, #e57373);
	opacity: 1;
	font-size: 12px;
	margin: 0;
}

.error {
	color: var(--q-negative, #e57373);
	font-size: 12px;
	margin: 0;
}
</style>
