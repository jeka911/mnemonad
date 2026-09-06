<template>
	<GradientPanel
		v-if="walletStore.blockNumber !== null"
		variant="beam"
		dense
		inline
		class="block-panel"
	>
		<template #icon>
			<span class="live-dot" />
		</template>
		<div class="block-status">
			<span class="live-label">{{ chainName }}</span>
			<span class="divider" />
			<span class="block-label">BLOCK</span>
			<span class="block-value">{{ formattedBlock }}</span>
			<span class="dot-sep">•</span>
			<span class="block-time">{{ blockTime }}</span>
		</div>
	</GradientPanel>
</template>

<script>
import { mapStores } from 'pinia';
import { useWalletStore } from './stores/wallet';
import GradientPanel from './components/GradientPanel.vue';

export default {
	name: 'BlockStatus',
	components: { GradientPanel },
	computed: {
		...mapStores(useWalletStore),
		chainName: function() {
			return this.walletStore.chainName.toUpperCase();
		},
		formattedBlock: function() {
			const bn = this.walletStore.blockNumber;
			return bn === null ? '' : bn.toLocaleString('en-US');
		},
		blockTime: function() {
			const k = this.walletStore.secondsPerBlock;
			return k ? Math.round(k * 1000) + 'ms' : '—';
		},
	},
	mounted() {
		// Safe if already initialized elsewhere — init() is guarded.
		this.walletStore.init();
	},
};
</script>

<style scoped>
.block-panel {
	/* Match the GradientButton height (36px) sitting beside it in the header,
	   rather than the dense default of 40px. */
	height: 36px;
	user-select: none;
	-webkit-user-select: none;
}

.block-status {
	display: flex;
	align-items: center;
	gap: 8px;
	font-family: var(--font-mono);
	font-size: 12px;
	line-height: 1;
	white-space: nowrap;
}

.live-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--q-positive);
	box-shadow: 0 0 8px var(--q-positive);
}

.live-label {
	color: var(--q-positive);
	font-weight: 400;
	letter-spacing: 0.06em;
}

.divider {
	width: 1px;
	height: 12px;
	background: var(--q-surface-border);
}

.block-label {
	color: var(--q-text-muted);
	letter-spacing: 0.06em;
}

.block-value {
	color: var(--q-text-bright);
	font-weight: 400;
	font-variant-numeric: tabular-nums;
}

.dot-sep {
	color: var(--q-text-muted);
}

.block-time {
	color: var(--q-info);
}

body.body--light .block-time {
	color: color-mix(in srgb, var(--q-info) 60%, black);
}
</style>
