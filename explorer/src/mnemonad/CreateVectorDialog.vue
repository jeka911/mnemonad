<template>
	<q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" position="standard">
		<JPanel accent="header" icon="add" iconColor="var(--q-primary)" title="New vector" style="min-width: 420px;">
			<div class="dialog-content q-pa-md">
				<q-input
					v-model="name"
					label="Name (optional)"
					dense
					outlined
					:disable="mnemonadStore.creating"
					@keyup.enter="submit"
				/>
				<p class="hint">
					Stored as vector metadata, in the clear — good enough to tell vectors apart
					before per-item browsing exists. Not encrypted.
				</p>
				<p v-if="walletStore.wrongNetwork" class="hint hint--warning">
					Switch to {{ activeNetwork.label }} to create a vector.
				</p>
				<GradientButton
					label="Create"
					loading-label="Creating..."
					:loading="mnemonadStore.creating"
					:disable="walletStore.wrongNetwork"
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

export default {
	name: 'CreateVectorDialog',
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
		};
	},
	computed: {
		...mapStores(useWalletStore, useMnemonadStore),
	},
	methods: {
		async submit() {
			if (this.walletStore.wrongNetwork || this.mnemonadStore.creating) return;
			try {
				await this.mnemonadStore.createVector({ name: this.name });
				this.name = '';
				this.$emit('update:modelValue', false);
			} catch (error) {
				this.$q.notify({
					type: 'negative',
					message: error?.shortMessage || error?.message || 'Failed to create vector',
					position: 'top',
				});
			}
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
