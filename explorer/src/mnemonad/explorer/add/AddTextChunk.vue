<template>
	<div class="add-text-chunk">
		<q-input
			v-model="text"
			type="textarea"
			label="Text to append"
			dense
			outlined
			autogrow
			:disable="disable || loading"
			:error="overLimit"
			@keyup.ctrl.enter="submit"
		/>
		<div class="add-text-chunk__row">
			<span v-if="sizeHint" class="add-text-chunk__hint" :class="{ 'add-text-chunk__hint--error': overLimit }">
				{{ sizeHint }}
			</span>
			<span v-else-if="hint" class="add-text-chunk__hint">{{ hint }}</span>
			<GradientButton
				label="Add"
				loading-label="Adding..."
				size="sm"
				class="add-text-chunk__submit"
				:loading="loading"
				:disable="disable || !text.trim() || overLimit"
				@click="submit"
			/>
		</div>
		<div v-if="costLine" class="add-text-chunk__cost">{{ costLine }}</div>
	</div>
</template>

<script>
import GradientButton from '../../../components/GradientButton.vue';
import { formatBytes } from '../../../includes/formatBytes.js';
import { formatMon } from '../../../includes/formatMon.js';

/** Wait for typing to pause before spending an RPC round-trip on an estimate. */
const ESTIMATE_DEBOUNCE_MS = 500;

export default {
	name: 'AddTextChunk',
	components: { GradientButton },
	props: {
		// True when the connected wallet can't push right now (disconnected, wrong
		// network, or not authorized) — see Stream.vue's canWrite/wrongNetwork check.
		disable: {
			type: Boolean,
			default: false,
		},
		hint: {
			type: String,
			default: '',
		},
		loading: {
			type: Boolean,
			default: false,
		},
		// The stream's maxChunkBytes — a single push() above this throws rather than
		// offloading itself (that needs `{ onChain: true }`'s staged multi-transaction
		// append, which this simple text box doesn't drive), *unless* an off-chain
		// transport is configured (`canOffload`), in which case push() routes it to IPFS
		// on its own. Checking client-side turns the no-transport case into an inline
		// message before the wallet prompt ever opens, instead of a thrown exception.
		maxBytes: {
			type: Number,
			default: Infinity,
		},
		// Whether an off-chain transport (e.g. Pinata) is configured — an oversized item
		// becomes informational ("will go to IPFS") instead of blocked when true.
		canOffload: {
			type: Boolean,
			default: false,
		},
		// (text: string) => Promise<CostEstimate|null> — Stream.vue owns the actual SDK
		// instance/clients, so estimation is delegated up rather than reached for here.
		estimate: {
			type: Function,
			default: null,
		},
	},
	emits: ['submit'],
	data() {
		return {
			text: '',
			estimating: false,
			costEstimate: null,
		};
	},
	computed: {
		byteLength: function() {
			return new TextEncoder().encode(this.text).length;
		},
		oversized: function() {
			return this.byteLength > this.maxBytes;
		},
		// Only actually blocking when there's no off-chain transport to fall back to —
		// with one configured, push() itself routes an oversized item to IPFS.
		overLimit: function() {
			return this.oversized && !this.canOffload;
		},
		sizeHint: function() {
			if (!this.text) return '';
			if (this.oversized) {
				return this.canOffload
					? `${formatBytes(this.byteLength)} exceeds the on-chain limit (${formatBytes(this.maxBytes)}) — will be stored via IPFS instead.`
					: `${formatBytes(this.byteLength)} exceeds this stream's ${formatBytes(this.maxBytes)} single-item limit — shorten it.`;
			}
			return `${formatBytes(this.byteLength)} / ${formatBytes(this.maxBytes)}`;
		},
		canEstimate: function() {
			return !this.disable && !this.overLimit && !!this.text.trim() && !!this.estimate;
		},
		costLine: function() {
			if (this.estimating) return 'Estimating cost…';
			if (!this.costEstimate) return '';
			const { total, transactionCount } = this.costEstimate;
			const txNote = transactionCount > 1 ? ` across ${transactionCount} transactions` : '';
			return `~${formatMon(total)} MON (gas + fee)${txNote}`;
		},
	},
	watch: {
		text: function() {
			this.scheduleEstimate();
		},
		disable: function() {
			this.scheduleEstimate();
		},
	},
	created() {
		// A plain timer handle, not reactive state — same reasoning as stores/wallet.js
		// keeping its own timers off Pinia state.
		this._debounceTimer = null;
	},
	beforeUnmount() {
		clearTimeout(this._debounceTimer);
	},
	methods: {
		scheduleEstimate: function() {
			clearTimeout(this._debounceTimer);
			this.costEstimate = null;
			if (!this.canEstimate) return;
			this._debounceTimer = setTimeout(() => this.runEstimate(), ESTIMATE_DEBOUNCE_MS);
		},
		runEstimate: async function() {
			if (!this.canEstimate) return;
			this.estimating = true;
			try {
				this.costEstimate = await this.estimate(this.text.trim());
			} catch {
				this.costEstimate = null; // best-effort — a failed estimate just shows nothing
			} finally {
				this.estimating = false;
			}
		},
		submit: function() {
			const value = this.text.trim();
			if (!value || this.disable || this.loading || this.overLimit) return;
			this.$emit('submit', value);
			this.text = '';
			this.costEstimate = null;
		},
	},
};
</script>

<style scoped>
.add-text-chunk {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.add-text-chunk__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.add-text-chunk__hint {
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
}

.add-text-chunk__hint--error {
	opacity: 1;
	color: var(--q-negative, #e57373);
}

/* The hint span is conditional (v-if/v-else-if) — when neither renders, this is the
   row's only flex child, and `justify-content: space-between` alone would leave a lone
   child at flex-start instead of the right. margin-left: auto pins it right regardless. */
.add-text-chunk__submit {
	margin-left: auto;
}

.add-text-chunk__cost {
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-mono, monospace);
}
</style>
