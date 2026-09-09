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

				<template v-if="encrypt">
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
					loading-label="Creating..."
					:loading="mnemonadStore.creating"
					:disable="walletStore.wrongNetwork || (encrypt && !isPasswordValid)"
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
			password: '',
			confirmPassword: '',
			passwordTouched: false,
			confirmTouched: false,
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
	},
	methods: {
		async submit() {
			if (this.walletStore.wrongNetwork || this.mnemonadStore.creating) return;
			if (this.encrypt) {
				this.passwordTouched = true;
				this.confirmTouched = true;
				if (!this.isPasswordValid) return;
			}
			try {
				await this.mnemonadStore.createStream({
					name: this.name,
					password: this.encrypt ? this.password : undefined,
				});
				this.reset();
				this.$emit('update:modelValue', false);
			} catch (error) {
				this.$q.notify({
					type: 'negative',
					message: error?.shortMessage || error?.message || 'Failed to create stream',
					position: 'top',
				});
			}
		},
		reset() {
			this.name = '';
			this.encrypt = false;
			this.password = '';
			this.confirmPassword = '';
			this.passwordTouched = false;
			this.confirmTouched = false;
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
