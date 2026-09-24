<template>
	<q-dialog :model-value="modelValue" @update:model-value="onModelValue">
		<JPanel accent="header" icon="local_fire_department" iconColor="var(--q-negative)" title="Burn this stream" style="min-width: 380px;">
			<div class="dialog-content q-pa-md">
				<p class="burn-target">
					<span class="burn-target__id">{{ formattedId }}</span>
					<span class="burn-target__meta">{{ length }} {{ length === 1 ? 'version' : 'versions' }} · {{ formatBytes(binaryLength) }}</span>
				</p>

				<p class="hint hint--warning">
					This permanently destroys the stream: the token and its metadata are gone,
					and — because ids are deterministic — creating a new stream later can never
					reuse this id to recover the old data. There is no undo.
				</p>
				<p class="hint">
					Item bytes already deployed as their own on-chain code (the CODE tier)
					physically survive regardless of this — burning removes the stream as a
					usable, readable thing, not necessarily every trace of its bytes.
				</p>

				<q-input
					v-model="confirmText"
					label="Type BURN to confirm"
					dense
					outlined
					autofocus
					:disable="burning"
					@keyup.enter="submit"
				/>

				<q-btn
					color="negative"
					unelevated
					no-caps
					class="burn-confirm"
					label="Burn this stream"
					:loading="burning"
					:disable="confirmText !== 'BURN'"
					@click="submit"
				/>
			</div>

			<template #header-action>
				<q-btn flat round icon="close" size="sm" :disable="burning" v-close-popup />
			</template>
		</JPanel>
	</q-dialog>
</template>

<script>
/**
 * Confirmation for DebugPanel.vue's "Burn stream" row — the one destructive, no-undo action
 * exposed in this app, so it gets more friction than a plain confirm click: the same
 * type-the-word pattern common for "delete this repo" flows, not just a second button.
 *
 * Deliberately its own component (mirrors CreateStreamDialog/CloneStreamDialog) rather than
 * inline in DebugPanel — a confirm-and-write flow with its own loading/error state is a
 * self-contained unit, not a couple of extra template lines.
 */
import { JPanel } from 'themed_varmory';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { formatStreamId } from '../includes/formatStreamId.js';
import { formatBytes } from '../includes/formatBytes.js';

export default {
	name: 'BurnStreamDialog',
	components: { JPanel },
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
		streamId: {
			type: [String, BigInt],
			required: true,
		},
		length: {
			type: Number,
			default: 0,
		},
		binaryLength: {
			type: Number,
			default: 0,
		},
	},
	emits: ['update:modelValue', 'burned'],
	data() {
		return {
			confirmText: '',
			burning: false,
		};
	},
	computed: {
		mnemonadStore() {
			return useMnemonadStore();
		},
		formattedId() {
			return formatStreamId(this.streamId);
		},
	},
	watch: {
		// Cleared on every open/close, not just after a successful burn — reopening the
		// dialog on the same stream (having backed out once) shouldn't start pre-confirmed.
		modelValue(open) {
			if (!open) this.confirmText = '';
		},
	},
	methods: {
		formatBytes,
		onModelValue(value) {
			if (this.burning) return; // no closing mid-write — see the disabled close button too
			this.$emit('update:modelValue', value);
		},
		async submit() {
			if (this.burning || this.confirmText !== 'BURN') return;
			this.burning = true;
			try {
				await this.mnemonadStore.burnStream(this.streamId);
				this.$emit('update:modelValue', false);
				this.$emit('burned');
			} catch (error) {
				this.$q.notify({
					type: 'negative',
					message: error?.shortMessage || error?.message || 'Failed to burn stream',
					position: 'top',
				});
			} finally {
				this.burning = false;
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

.burn-target {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
	padding: 10px 12px;
	border-radius: 8px;
	background: rgba(193, 0, 21, 0.08);
	border: 1px solid rgba(193, 0, 21, 0.2);
}

.burn-target__id {
	font-family: var(--font-mono, monospace);
	font-size: 0.95em;
	color: var(--q-text-bright, #ffffff);
}

.burn-target__meta {
	font-size: 12px;
	color: var(--q-text-muted, #8a94a6);
}

.hint {
	margin: 0;
	font-size: 12px;
	line-height: 1.5;
	opacity: 0.75;
}

.hint--warning {
	color: var(--q-negative, #e57373);
	opacity: 1;
}

.burn-confirm {
	margin-top: 4px;
}

body.body--light .burn-target__id {
	color: #2a2440;
}
</style>
