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
		<q-icon
			v-if="walletStore.isConnected && isPasskeySession"
			name="key"
			size="16px"
			class="passkey-badge"
		>
			<q-tooltip>
				Connected with a passkey-derived account, via Mera.
			</q-tooltip>
		</q-icon>
		<span class="wallet-btn-wrap">
			<GradientButton
				:label="walletLabel"
				:loading="isConnecting"
				loading-label="Connecting..."
				@click="onButtonClick"
				size="md"
			/>
			<!-- A sibling of GradientButton, not slotted inside it — GradientButton's own
			     slot has fallback content (the icon/label) that only renders when nothing is
			     passed into the slot, so nesting <q-menu> there instead of here silently ate
			     the address label. QMenu anchors to its DOM parent by default, and this
			     wrapper contains only the button, so a click anywhere on it still opens the
			     menu exactly as if it were nested. -->
			<q-menu v-if="walletStore.isConnected" auto-close>
				<q-list style="min-width: 180px">
					<q-item clickable v-close-popup @click="openExplorer">
						<q-item-section avatar>
							<q-icon name="open_in_new" size="18px" />
						</q-item-section>
						<q-item-section>Explore</q-item-section>
					</q-item>
					<q-item clickable v-close-popup @click="copyAddress">
						<q-item-section avatar>
							<q-icon name="content_copy" size="18px" />
						</q-item-section>
						<q-item-section>Copy address</q-item-section>
					</q-item>
					<q-separator />
					<q-item clickable v-close-popup @click="walletStore.disconnect()">
						<q-item-section avatar>
							<q-icon name="logout" size="18px" />
						</q-item-section>
						<q-item-section>Disconnect</q-item-section>
					</q-item>
				</q-list>
			</q-menu>
		</span>

		<q-dialog v-model="showModal" position="standard">
			<JPanel accent="header" icon="wallet" iconColor="var(--q-primary)" title="Sign In" style="min-width: 420px;">
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
					<template v-if="passkeySignerEnabled">
						<div v-if="connectors.length" class="wallet-divider"><span>or</span></div>
						<q-btn
							v-if="!showPasskeySigner"
							flat
							no-caps
							size="lg"
							color="primary"
							class="passkey-toggle"
							@click="showPasskeySigner = true"
						>
							<q-icon name="fingerprint" size="32px" class="q-mr-sm" />
							<span>Passkey</span>
							<q-tooltip>Use a passkey, powered by Mera</q-tooltip>
						</q-btn>
						<PasskeyCard v-else @connected="onPasskeySignerConnected" />
					</template>

					<template v-if="localSignerEnabled">
						<div v-if="connectors.length || passkeySignerEnabled" class="wallet-divider"><span>or</span></div>
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

					<p v-if="!connectors.length" class="no-wallets">
						Optionally, install any EVM-compatible browser wallet (MetaMask, Rabby,
						…) to sign in that way.
					</p>
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
import { copyToClipboard } from 'quasar';
import { JPanel } from 'themed_varmory';
import { config } from './wagmi';
import { useWalletStore } from './stores/wallet';
import GradientButton from './components/GradientButton.vue';
import { LOCAL_SIGNER_CONNECTOR_NAME } from './wallet/localSignerConnector.js';
import { PASSKEY_CONNECTOR_NAME } from './wallet/passkeyConnector.js';
import { getActiveNetwork } from './settings.js';
import { addressUrl } from './includes/explorerUrl.js';

// Off by default and read once at module load, matching `wagmi.js`'s own pattern.
const LOCAL_SIGNER_ENABLED = import.meta.env.VITE_ENABLE_LOCAL_SIGNER === 'true';
// On by default (unlike Local Signer): @category-labs/mera is still pre-1.0 and its own
// docs say the API may change, not that the feature itself is unsafe — so this stays a kill
// switch (VITE_ENABLE_PASSKEY_SIGNER=false) rather than an opt-in.
const PASSKEY_SIGNER_ENABLED = import.meta.env.VITE_ENABLE_PASSKEY_SIGNER !== 'false';

// A dynamic import rather than a static one: `components: { LocalSignerCard }` with a
// static import would still bundle the component into this chunk regardless of the flag
// above — Rollup sees it referenced in the components map and keeps it, runtime env check
// or not. Loading it lazily means a build with the flag off never fetches this component's
// code at all, not merely never renders it — genuinely absent from what ships to a user who
// never clicks the toggle, not just hidden behind one.
const LocalSignerCard = defineAsyncComponent(() => import('./wallet/LocalSignerCard.vue'));
const PasskeyCard = defineAsyncComponent(() => import('./wallet/PasskeyCard.vue'));

export default {
	name: 'WalletConnect',
	components: {
		JPanel,
		GradientButton,
		LocalSignerCard,
		PasskeyCard,
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
			passkeySignerEnabled: PASSKEY_SIGNER_ENABLED,
			showPasskeySigner: false,
		};
	},
	computed: {
		...mapStores(useWalletStore),
		walletLabel: function() {
			// "Connecting..." is handled by GradientButton's loading state.
			return this.walletStore.isConnected
				? this.walletStore.formattedAddress
				: 'Sign In';
		},
		// Whichever session is live — real extension or local signer — this only ever
		// reads `connectorName`, which every connector (including ours) already reports
		// via wagmi's own `account.connector.name`. No separate flag to keep in sync.
		isLocalSignerSession: function() {
			return this.walletStore.connectorName === LOCAL_SIGNER_CONNECTOR_NAME;
		},
		isPasskeySession: function() {
			return this.walletStore.connectorName === PASSKEY_CONNECTOR_NAME;
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
			// When connected, the click that reaches here also reaches the q-menu nested in
			// the button (its own listener opens the dropdown) — nothing to do on this side;
			// the dropdown's own items are what disconnect/explore/copy now.
			if (!this.walletStore.isConnected) {
				this.showModal = true;
			}
		},
		openExplorer() {
			const url = addressUrl(this.activeChain, this.walletStore.address);
			if (url) window.open(url, '_blank', 'noopener,noreferrer');
		},
		copyAddress() {
			copyToClipboard(this.walletStore.address)
				.then(() => {
					this.$q.notify({ type: 'positive', message: 'Address copied', position: 'top' });
				})
				.catch(() => {
					this.$q.notify({ type: 'negative', message: 'Could not copy address', position: 'top' });
				});
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
		onPasskeySignerConnected() {
			this.showModal = false;
			this.walletStore.refreshAccount();
		},
	},
	watch: {
		// Reopening later should offer the toggle again, not a form left expanded (or
		// mid-edit) from the last time the dialog was open.
		showModal(isOpen) {
			if (!isOpen) this.showLocalSigner = false;
			if (!isOpen) this.showPasskeySigner = false;
		},
	},
};
</script>

<style scoped>
.wallet-connect-wrapper {
	display: contents;
}

.wallet-btn-wrap {
	display: inline-flex;
}

.local-signer-badge {
	color: var(--q-warning, #f2c037);
	margin-right: 4px;
}

.passkey-badge {
	color: var(--q-primary);
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
	margin: 4px 0 0;
	text-align: center;
	font-size: 12px;
	opacity: 0.7;
}

.wallet-divider {
	display: flex;
	align-items: center;
	gap: 10px;
	color: var(--q-text-muted, #8a94a6);
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
}

.wallet-divider::before,
.wallet-divider::after {
	content: '';
	flex: 1;
	height: 1px;
	background: rgba(255, 255, 255, 0.12);
}

.local-signer-toggle {
	align-self: center;
}

.passkey-toggle {
	align-self: center;
}

.chain-info {
	text-align: center;
	font-size: 12px;
	opacity: 0.8;
	margin-top: 12px;
}
</style>
