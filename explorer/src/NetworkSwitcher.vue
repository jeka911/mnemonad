<template>
	<div class="network-switcher">
		<q-btn
			v-for="net in networkList"
			:key="net.id"
			:label="net.label"
			dense
			no-caps
			unelevated
			size="sm"
			:color="net.id === activeNetworkId ? 'primary' : undefined"
			:class="['network-switcher__btn', { 'network-switcher__btn--inactive': net.id !== activeNetworkId }]"
			@click="select(net.id)"
		/>
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import { useWalletStore } from './stores/wallet';
import { NETWORKS, getActiveNetworkId, setActiveNetworkId } from './settings.js';

export default {
	name: 'NetworkSwitcher',
	data() {
		return {
			activeNetworkId: getActiveNetworkId(),
			networkList: Object.values(NETWORKS),
		};
	},
	computed: {
		...mapStores(useWalletStore),
	},
	methods: {
		select: async function(id) {
			if (id === this.activeNetworkId || !NETWORKS[id]) {
				return;
			}
			// Ask the wallet to switch to the target chain FIRST (raw EIP-3326
			// request, which works even for wallets that refuse wagmi's
			// switchChain). Keeping the connection means that after the reload the
			// wallet is already on the matching chain — no wrong-network banner.
			// Best-effort: if the wallet declines, the app still switches and the
			// mismatch banner (with its own switch button) covers the gap.
			if (this.walletStore.isConnected) {
				await this.walletStore.requestWalletChain(NETWORKS[id].chain);
			}
			// Persists the choice and reloads the page so the whole app (wagmi
			// config, contract addresses, cached chain state) boots fresh on the new
			// network — see settings.js.
			setActiveNetworkId(id);
		},
	},
};
</script>

<style scoped>
.network-switcher {
	display: inline-flex;
	align-items: center;
	height: 36px;
	padding: 3px;
	gap: 2px;
	border-radius: 10px;
	background: var(--q-surface-1);
	border: 1px solid var(--q-surface-border);
}

.network-switcher__btn {
	border-radius: 7px;
	min-height: 28px;
	padding: 0 10px;
	font-family: var(--font-mono);
	font-size: 12px;
}

.network-switcher__btn--inactive {
	color: var(--q-text-muted);
}
</style>
