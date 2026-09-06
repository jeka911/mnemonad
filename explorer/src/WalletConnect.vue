<template>
	<div class="wallet-connect-wrapper">
		<GradientButton
			:label="walletLabel"
			:loading="isConnecting"
			loading-label="Connecting..."
			@click="onButtonClick"
			size="md"
		/>

		<q-dialog v-model="showModal" position="standard">
			<JPanel accent="header" icon="wallet" iconColor="var(--q-primary)" title="Connect Wallet" style="min-width: 420px;">
				<div class="dialog-content q-pa-md">
					<q-btn
						v-for="connector in connectors"
						:key="connector.uid"
						color="primary"
						@click="connectWallet(connector)"
						:disable="isConnecting"
						class="full-width wallet-btn"
						align="left"
						no-caps
						outline
					>
						<img
							v-if="connector.icon"
							:src="connector.icon"
							:alt="connector.name"
							class="wallet-icon"
						/>
						<span>{{ connector.name }}</span>
					</q-btn>
					<div v-if="!connectors.length" class="no-wallets">
						No wallet extensions detected. Install MetaMask or another browser wallet.
					</div>
				</div>

				<template #header-action>
					<q-btn flat round icon="close" size="sm" v-close-popup />
				</template>
				<template #footer>
					<div class="chain-info text-center">{{ activeChain.name }} (Chain ID: {{ activeChain.id }})</div>
				</template>
			</JPanel>
		</q-dialog>
	</div>
</template>

<script>
import { connect, getConnectors, watchConnectors } from '@wagmi/core';
import { mapStores } from 'pinia';
import { JPanel } from 'themed_varmory';
import { config } from './wagmi';
import { useWalletStore } from './stores/wallet';
import GradientButton from './components/GradientButton.vue';
import { getActiveNetwork } from './settings.js';

export default {
	name: 'WalletConnect',
	components: {
		JPanel,
		GradientButton,
	},
	data() {
		return {
			activeChain: getActiveNetwork().chain,
			showModal: false,
			// Locally tracked so it always resets, even when the user cancels in the wallet.
			isConnecting: false,
			connectors: getConnectors(config),
		};
	},
	computed: {
		...mapStores(useWalletStore),
		walletLabel: function() {
			// "Connecting..." is handled by GradientButton's loading state.
			return this.walletStore.isConnected
				? this.walletStore.formattedAddress
				: 'Connect Wallet';
		},
	},
	mounted() {
		this.walletStore.init();
		// Keep the wallet list in sync as EIP-6963 wallets are discovered.
		watchConnectors(config, {
			onChange: (connectors) => {
				this.connectors = connectors;
			},
		});
	},
	methods: {
		onButtonClick() {
			if (this.walletStore.isConnected) {
				this.walletStore.disconnect();
			} else {
				this.showModal = true;
			}
		},
		async connectWallet(connector) {
			this.isConnecting = true;
			try {
				// Connect on whatever chain the wallet is currently on — do NOT
				// pass a target chainId. Forcing one here shoved the wallet's
				// network around (and errored on wallets that can't switch
				// programmatically). If the wallet ends up on the wrong chain, the
				// sidebar shows a mismatch banner with an opt-in switch instead.
				await connect(config, { connector });
				this.showModal = false;
				this.walletStore.refreshAccount();
			} catch (error) {
				// User rejected the request (EIP-1193 code 4001) or the wallet errored.
				// Keep the dialog open so they can retry or pick another wallet.
				const rejected =
					error?.name === 'UserRejectedRequestError' || error?.code === 4001;
				this.$q.notify({
					type: rejected ? 'warning' : 'negative',
					message: rejected
						? 'Connection request rejected'
						: error?.shortMessage || error?.message || 'Failed to connect wallet',
					position: 'top',
				});
			} finally {
				this.isConnecting = false;
			}
		},
	},
};
</script>

<style scoped>
.wallet-connect-wrapper {
	display: contents;
}

.dialog-content {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin: 16px 0;
}

.wallet-icon {
	width: 24px;
	height: 24px;
	border-radius: 6px;
	margin-right: 12px;
	object-fit: contain;
}

.no-wallets {
	text-align: center;
	font-size: 13px;
	opacity: 0.8;
}

.chain-info {
	text-align: center;
	font-size: 12px;
	opacity: 0.8;
	margin-top: 12px;
}
</style>
