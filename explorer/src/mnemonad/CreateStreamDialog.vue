<template>
	<q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" position="standard">
		<JPanel accent="header" icon="add" iconColor="var(--q-primary)" title="New stream" style="min-width: 420px;">
			<div class="dialog-content q-pa-md">
				<q-input
					v-model="name"
					label="Name (optional)"
					dense
					outlined
					:disable="mnemonadStore.creating"
					@keyup.enter="submit"
				/>

				<div class="encrypt-row">
					<span class="encrypt-row__label">Encrypt this stream</span>
					<q-toggle
						v-model="encrypt"
						color="primary"
						dense
						:disable="mnemonadStore.creating"
					/>
				</div>

				<q-option-group
					v-if="encrypt"
					v-model="encryptWith"
					:options="methodOptions"
					color="primary"
					dense
					:disable="mnemonadStore.creating"
				/>

				<template v-if="encrypt && encryptWith === 'wallet'">
					<p class="hint hint--warning">
						Only this wallet can ever decrypt it. There is no recovery: lose the
						account and the contents are permanently unreadable, and an encrypted
						stream can never be transferred to another owner.
					</p>
					<p class="hint">
						Creating it asks the wallet twice — once for a free signature that
						derives the key, then for the create transaction itself.
					</p>
				</template>

				<template v-if="encrypt && encryptWith === 'password'">
					<q-input
						v-model="password"
						label="Password"
						type="password"
						dense
						outlined
						:disable="mnemonadStore.creating"
						:error="passwordTouched && !!passwordError"
						:error-message="passwordError"
						@blur="passwordTouched = true"
						@keyup.enter="submit"
					/>
					<q-input
						v-model="confirmPassword"
						label="Confirm password"
						type="password"
						dense
						outlined
						:disable="mnemonadStore.creating"
						:error="confirmTouched && !!confirmError"
						:error-message="confirmError"
						@blur="confirmTouched = true"
						@keyup.enter="submit"
					/>
					<p class="hint hint--warning">
						There is no password recovery. If it's lost, this stream's contents are
						permanently unreadable — there is no reset.
					</p>
					<p class="hint">
						Stream name (if any) and the password's salt stay in the clear in stream
						metadata so a later reader only needs the password itself. Only item
						contents are encrypted.
					</p>
				</template>
				<p v-else class="hint">
					Name is stored as stream metadata, in the clear — good enough to tell streams
					apart before per-item browsing exists.
				</p>

				<p v-if="walletStore.wrongNetwork" class="hint hint--warning">
					Switch to {{ activeNetwork.label }} to create a stream.
				</p>
				<GradientButton
					label="Create"
					:loading-label="creatingStep === 'sign' ? 'Check your wallet to sign...' : 'Creating...'"
					:loading="mnemonadStore.creating"
					:disable="walletStore.wrongNetwork || (encrypt && encryptWith === 'password' && !isPasswordValid)"
					@click="submit"
				/>
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
import { getActiveNetwork } from '../settings.js';

const MIN_PASSWORD_LENGTH = 8;

export default {
	name: 'CreateStreamDialog',
	components: {
		JPanel,
		GradientButton,
	},
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:modelValue'],
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			name: '',
			encrypt: false,
			// Which credential keys the stream. Password is the default because it's the
			// recoverable-by-anyone-who-knows-it option; wallet trades that for a key nobody
			// but this account can derive.
			encryptWith: 'password',
			password: '',
			confirmPassword: '',
			passwordTouched: false,
			confirmTouched: false,
			/** 'sign' | 'tx' — which wallet prompt the create flow is waiting on. */
			creatingStep: null,
		};
	},
	computed: {
		...mapStores(useWalletStore, useMnemonadStore),
		passwordError() {
			if (this.password.length === 0) return 'Password is required.';
			if (this.password.length < MIN_PASSWORD_LENGTH) {
				return `Must be at least ${MIN_PASSWORD_LENGTH} characters.`;
			}
			return '';
		},
		confirmError() {
			if (this.confirmPassword !== this.password) return 'Passwords do not match.';
			return '';
		},
		isPasswordValid() {
			return !this.passwordError && !this.confirmError;
		},
		methodOptions() {
			return [
				{ label: 'With a password', value: 'password' },
				{ label: "With this wallet's signature", value: 'wallet' },
			];
		},
	},
	methods: {
		async submit() {
			if (this.walletStore.wrongNetwork || this.mnemonadStore.creating) return;
			if (this.encrypt && this.encryptWith === 'password') {
				this.passwordTouched = true;
				this.confirmTouched = true;
				if (!this.isPasswordValid) return;
			}
			try {
				await this.mnemonadStore.createStream({
					name: this.name,
					encryptWith: this.encrypt ? this.encryptWith : null,
					password: this.encrypt && this.encryptWith === 'password' ? this.password : undefined,
					// Two wallet prompts for the wallet method (key signature, then the
					// transaction) — this keeps the button honest about which one is up.
					onStep: (step) => { this.creatingStep = step; },
				});
				this.reset();
				this.$emit('update:modelValue', false);
			} catch (error) {
				// Rejecting either prompt lands here. The signature one leaves nothing
				// behind at all (no transaction was sent yet), and the derivation is
				// deterministic, so retrying re-derives the identical key.
				const rejected = error?.name === 'UserRejectedRequestError'
					|| /user rejected|denied/i.test(error?.shortMessage || error?.message || '');
				this.$q.notify({
					type: 'negative',
					message: rejected
						? (this.creatingStep === 'sign' ? 'Signature rejected — nothing was created.' : 'Transaction rejected — nothing was created.')
						: (error?.shortMessage || error?.message || 'Failed to create stream'),
					position: 'top',
				});
			} finally {
				this.creatingStep = null;
			}
		},
		reset() {
			this.name = '';
			this.encrypt = false;
			this.encryptWith = 'password';
			this.password = '';
			this.confirmPassword = '';
			this.passwordTouched = false;
			this.confirmTouched = false;
			this.creatingStep = null;
		},
	},
};
</script>

<style scoped>
.dialog-content {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin: 16px 0;
}

.encrypt-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.encrypt-row__label {
	font-size: 14px;
}

.hint {
	margin: 0;
	font-size: 12px;
	opacity: 0.75;
}

.hint--warning {
	color: var(--q-negative, #e57373);
	opacity: 1;
}
</style>
