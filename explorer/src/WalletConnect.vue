<template>
	<div class="wallet-connect-wrapper">
		<q-icon
			v-if="walletStore.isConnected && isLocalSignerSession"
			name="vpn_key"
			size="16px"
			class="local-signer-badge"
		>
			<q-tooltip>
				Connected with a local private key — every transaction signs immediately, with
				no wallet confirmation.
			</q-tooltip>
		</q-icon>
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

					<template v-if="localSignerEnabled">
						<q-separator />
						<q-btn
							v-if="!showLocalSigner"
							flat
							dense
							no-caps
							color="primary"
							label="Use a private key instead"
							class="local-signer-toggle"
							@click="showLocalSigner = true"
						/>
						<LocalSignerCard v-else @connected="onLocalSignerConnected" />
					</template>
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
import { defineAsyncComponent } from 'vue';
import { connect, getConnectors, watchConnectors } from '@wagmi/core';
import { mapStores } from 'pinia';
import { JPanel } from 'themed_varmory';
import { config } from './wagmi';
import { useWalletStore } from './stores/wallet';
import GradientButton from './components/GradientButton.vue';
import { LOCAL_SIGNER_CONNECTOR_NAME } from './wallet/localSignerConnector.js';
import { getActiveNetwork } from './settings.js';

// Off by default and read once at module load, matching `wagmi.js`'s own pattern.
const LOCAL_SIGNER_ENABLED = import.meta.env.VITE_ENABLE_LOCAL_SIGNER === 'true';

// A dynamic import rather than a static one: `components: { LocalSignerCard }` with a
// static import would still bundle the component into this chunk regardless of the flag
// above — Rollup sees it referenced in the components map and keeps it, runtime env check
// or not. Loading it lazily means a build with the flag off never fetches this component's
// code at all, not merely never renders it — genuinely absent from what ships to a user who
// never clicks the toggle, not just hidden behind one.
const LocalSignerCard = defineAsyncComponent(() => import('./wallet/LocalSignerCard.vue'));

export default {
	name: 'WalletConnect',
	components: {
		JPanel,
		GradientButton,
		LocalSignerCard,
	},
	data() {
		return {
			activeChain: getActiveNetwork().chain,
			showModal: false,
			// Locally tracked so it always resets, even when the user cancels in the wallet.
			isConnecting: false,
			connectors: getConnectors(config),
			localSignerEnabled: LOCAL_SIGNER_ENABLED,
			showLocalSigner: false,
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
		// Whichever session is live — real extension or local signer — this only ever
		// reads `connectorName`, which every connector (including ours) already reports
		// via wagmi's own `account.connector.name`. No separate flag to keep in sync.
		isLocalSignerSession: function() {
			return this.walletStore.connectorName === LOCAL_SIGNER_CONNECTOR_NAME;
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
		onLocalSignerConnected() {
			this.showModal = false;
			this.walletStore.refreshAccount();
		},
	},
	watch: {
		// Reopening later should offer the toggle again, not a form left expanded (or
		// mid-edit) from the last time the dialog was open.
		showModal(isOpen) {
			if (!isOpen) this.showLocalSigner = false;
		},
	},
};
</script>

<style scoped>
.wallet-connect-wrapper {
	display: contents;
}

.local-signer-badge {
	color: var(--q-warning, #f2c037);
	margin-right: 4px;
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

.local-signer-toggle {
	align-self: center;
}

.chain-info {
	text-align: center;
	font-size: 12px;
	opacity: 0.8;
	margin-top: 12px;
}
</style>
