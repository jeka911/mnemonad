<template>
	<GradientPanel
		v-if="walletStore.gasPrice !== null"
		variant="streak"
		dense
		inline
		class="gas-panel"
	>
		<template #icon>
			<q-icon name="local_gas_station" class="gas-icon" />
		</template>
		<div class="gas-status">
			<span class="gas-value">{{ formattedGas }}</span>
			<span class="gas-unit">gwei</span>
		</div>
	</GradientPanel>
</template>

<script>
import { mapStores } from 'pinia';
import { useWalletStore } from './stores/wallet';
import GradientPanel from './components/GradientPanel.vue';

export default {
	name: 'GasPrice',
	components: { GradientPanel },
	computed: {
		...mapStores(useWalletStore),
		formattedGas: function() {
			return this.walletStore.gasPriceGwei;
		},
	},
	mounted() {
		// Safe if already initialized elsewhere — init() is guarded.
		this.walletStore.init();
	},
};
</script>

<style scoped>
.gas-panel {
	/* Match the block-number pill / button height in the header. */
	height: 36px;
	user-select: none;
	-webkit-user-select: none;
}

.gas-icon {
	font-size: 18px;
}

.gas-status {
	display: flex;
	align-items: center;
	gap: 8px;
	font-family: var(--font-mono);
	font-size: 12px;
	line-height: 1;
	white-space: nowrap;
}

.gas-value {
	color: var(--q-text-bright);
	font-weight: 400;
	font-variant-numeric: tabular-nums;
}

.gas-unit {
	color: var(--q-text-muted);
}
</style>
