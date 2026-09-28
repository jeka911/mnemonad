<template>
	<q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
		<JPanel accent="header" icon="lock" iconColor="var(--q-primary)" title="Unlock stream" style="min-width: 360px;">
			<div class="unlock-content q-pa-md">
				<template v-if="kekMethod === 'password'">
					<p class="unlock-hint">
						Enter the password this stream was encrypted with to {{ purpose }}.
					</p>
					<q-input
						v-model="unlockPassword"
						label="Password"
						type="password"
						dense
						outlined
						autofocus
						:disable="unlocking"
						:error="!!unlockError"
						:error-message="unlockError"
						@keyup.enter="submitUnlock"
					/>
					<GradientButton
						label="Unlock"
						loading-label="Unlocking..."
						:loading="unlocking"
						@click="submitUnlock"
					/>
				</template>
				<template v-else-if="walletStore.isConnected">
					<p v-if="isPasskeySession" class="unlock-hint">
						This stream is encrypted to its owner's passkey-derived wallet — click
						below to derive the decryption key for this stream. Nothing leaves your
						browser, and it costs nothing, via Mera.
					</p>
					<p v-else class="unlock-hint">
						This stream is encrypted to its owner's wallet. Sign the prompt to derive
						its key — the signature never leaves your browser, and costs nothing.
					</p>
					<p v-if="unlockError" class="unlock-error">{{ unlockError }}</p>
					<GradientButton
						:label="isPasskeySession ? 'Unlock with passkey' : 'Unlock with wallet'"
						loading-label="Unlocking..."
						:loading="unlocking"
						@click="submitUnlock"
					/>
				</template>
				<!-- Not connected: attempting the unlock would just fail (there's no address to
				     derive the key for), so there's nothing useful to click here — the header's
				     own always-visible Sign In button is the way out, same as every other
				     "connect a wallet first" moment in this app (e.g. MyStreams.vue). -->
				<template v-else>
					<p class="unlock-hint">
						This stream is encrypted to its owner's wallet. Sign in first to unlock it.
					</p>
				</template>
			</div>

			<template #header-action>
				<q-btn flat round icon="close" size="sm" v-close-popup />
			</template>
		</JPanel>
	</q-dialog>
</template>

<script>
import { mapStores } from 'pinia';
import { JPanel } from 'themed_varmory';
import GradientButton from '../components/GradientButton.vue';
import { useWalletStore } from '../stores/wallet.js';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { methodOf } from './kek.js';
import { PASSKEY_CONNECTOR_NAME } from '../wallet/passkeyConnector.js';

/**
 * The unlock dialog shared by Stream.vue and FileBrowser.vue (previously two near-identical
 * copies — a password field for a password-keyed stream, a "sign a prompt" button for a
 * wallet-keyed one). Owns its own password/error/loading state and the actual unlock call;
 * the parent only owns whether it's open (`v-model`) and reacts to `@unlocked`.
 *
 * `stream` is deliberately a prop straight off the page's own non-reactive `_stream` (see
 * Stream.vue/FileBrowser.vue's own `created()` doc for why that's not in `data()`) — same
 * shape AddPanel.vue and FileManagerBrowserSync already take it in.
 */
export default {
	name: 'UnlockStreamDialog',
	components: { JPanel, GradientButton },
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
		/** A live `Mnemonad` instance (post-`initialize()`) — see the note above. */
		stream: {
			type: Object,
			default: null,
		},
		/** Fills "...to {purpose}" in the password branch's hint — the one wording difference
		 *  the two former copies had ("browse its files" vs "view its items"). */
		purpose: {
			type: String,
			default: 'unlock it',
		},
	},
	emits: ['update:modelValue', 'unlocked'],
	data() {
		return {
			unlockPassword: '',
			unlockError: null,
			unlocking: false,
		};
	},
	computed: {
		...mapStores(useWalletStore, useMnemonadStore),
		// Hung off `modelValue` rather than `stream` alone: `stream` is a plain (non-reactive)
		// object, so a computed that only ever read through it would track no reactive
		// dependency at all and permanently cache whatever it saw on its first access. Reading
		// `modelValue` here (genuinely reactive) forces a fresh `methodOf(this.stream)` every
		// time the dialog opens — the exact same trick Stream.vue/FileBrowser.vue's own
		// `kekMethod` used before this was extracted.
		kekMethod: function() {
			if (!this.modelValue) return null;
			return methodOf(this.stream);
		},
		// Same check WalletConnect.vue's own `isPasskeySession` makes — only ever reads
		// `connectorName`, which every connector (including the passkey one) reports via
		// wagmi's own `account.connector.name`, so there's nothing extra to keep in sync.
		// The wallet-signature ceremony is identical either way (unlockStreamWithWallet
		// doesn't care what kind of signer it's handed); this only changes the wording so
		// someone connected via a passkey isn't told to "sign a prompt" as if it were an
		// extension popup.
		isPasskeySession: function() {
			return this.walletStore.connectorName === PASSKEY_CONNECTOR_NAME;
		},
	},
	watch: {
		// Mirrors what each page's own openUnlock() used to do — a stale password or error
		// from a previous attempt (or a previous stream) shouldn't greet the next time this
		// opens.
		modelValue(isOpen) {
			if (isOpen) {
				this.unlockPassword = '';
				this.unlockError = null;
			}
		},
	},
	methods: {
		async submitUnlock() {
			// Deliberately not gated on `streamMeta.kek` existing: metadata is written once at
			// creation and can never be corrected, and a stream encrypted before the method
			// marker existed publishes no block at all — gating here would lock those out
			// permanently. Whether the credential is right is the GCM tag's call.
			if (this.unlocking || !this.stream) return;
			if (this.kekMethod === 'password' && !this.unlockPassword) {
				this.unlockError = 'Password is required.';
				return;
			}
			this.unlocking = true;
			this.unlockError = null;
			try {
				if (this.kekMethod === 'password') {
					await this.stream.unlockWithPassword(this.unlockPassword);
				} else {
					// The store checks ownership before prompting, so the common "wrong account
					// connected" case never costs the user a popup.
					await this.mnemonadStore.unlockStreamWithWallet(this.stream.id, this.walletStore.address);
				}
				this.$emit('unlocked');
				this.$emit('update:modelValue', false);
			} catch (error) {
				this.unlockError = this.kekMethod === 'password'
					? 'Incorrect password.'
					: (error?.message || 'Could not unlock with this wallet.');
			} finally {
				this.unlocking = false;
			}
		},
	},
};
</script>

<style scoped>
.unlock-content {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin: 16px 0;
}

.unlock-hint {
	margin: 0;
	font-size: 12px;
	opacity: 0.75;
}

/* The wallet branch has no q-input to carry an :error-message, so the failure renders
   here instead. */
.unlock-error {
	margin: 0;
	font-size: 12px;
	color: var(--q-negative);
}
</style>
