<template>
	<div class="my-vectors">
		<!-- Not deployed on this network: same pattern Home.vue already used for the
		     canvas-era placeholder. -->
		<div v-if="!mnemonadStore.isDeployed" class="my-vectors__state">
			<p>Mnemonad isn't deployed on {{ activeNetwork.label }} yet.</p>
		</div>

		<!-- Disconnected: nothing to list without an address to list it for. -->
		<div v-else-if="!walletStore.isConnected" class="my-vectors__state">
			<p>Connect a wallet to see your vectors.</p>
			<WalletConnect />
		</div>

		<template v-else>
			<div class="my-vectors__toolbar">
				<ExplorerLink
					type="address"
					:value="mnemonadStore.contractAddress"
					:chain="activeNetwork.chain"
					label="View registry"
				/>
				<GradientButton
					label="New vector"
					icon="add"
					size="sm"
					:disable="walletStore.wrongNetwork"
					@click="showCreate = true"
				/>
			</div>

			<!-- Loading: skeleton rows shaped like the real ones, not a spinner. -->
			<div v-if="mnemonadStore.loading" class="my-vectors__list">
				<div v-for="i in 3" :key="i" class="vector-row vector-row--skeleton">
					<q-skeleton type="text" width="140px" />
					<q-skeleton type="text" width="60px" />
				</div>
			</div>

			<!-- Error: inline retry, not a toast — this is the initial load, not a
			     transient event. -->
			<div v-else-if="mnemonadStore.error" class="my-vectors__state">
				<p>{{ mnemonadStore.error }}</p>
				<GradientButton label="Retry" size="sm" @click="load" />
			</div>

			<div v-else-if="!mnemonadStore.vectors.length" class="my-vectors__state">
				<p>No vectors yet.</p>
			</div>

			<div v-else class="my-vectors__list">
				<router-link
					v-for="v in mnemonadStore.vectors"
					:key="String(v.id)"
					:to="`/vector/${v.id}`"
					class="vector-row"
				>
					<span class="vector-row__id">{{ formatId(v.id) }}</span>
					<span class="vector-row__meta">
						<q-icon v-if="v.encrypted" name="lock" size="14px" class="vector-row__lock" />
						{{ v.length }} {{ v.length === 1 ? 'item' : 'items' }}
					</span>
				</router-link>
			</div>
		</template>

		<CreateVectorDialog v-model="showCreate" />
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import GradientButton from '../components/GradientButton.vue';
import ExplorerLink from './ExplorerLink.vue';
import CreateVectorDialog from './CreateVectorDialog.vue';
import WalletConnect from '../WalletConnect.vue';
import { useWalletStore } from '../stores/wallet.js';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { getActiveNetwork } from '../settings.js';

export default {
	name: 'MyVectors',
	components: {
		GradientButton,
		ExplorerLink,
		CreateVectorDialog,
		WalletConnect,
	},
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			showCreate: false,
		};
	},
	computed: {
		...mapStores(useWalletStore, useMnemonadStore),
	},
	watch: {
		// Re-fetch on connect, disconnect, account switch, or chain switch — all of
		// which change what "owned" means. connectionId bundles address+chainId into
		// one comparable value, matching the pattern stores/wallet.js already defines
		// it for.
		'walletStore.connectionId': {
			immediate: true,
			handler: function() {
				this.load();
			},
		},
	},
	methods: {
		load: function() {
			if (this.walletStore.isConnected) {
				this.mnemonadStore.fetchOwnedVectors(this.walletStore.address);
			}
		},
		formatId: function(id) {
			const hex = BigInt(id).toString(16).padStart(64, '0');
			return `0x${hex.slice(0, 6)}...${hex.slice(-4)}`;
		},
	},
};
</script>

<style scoped>
.my-vectors {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.my-vectors__state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	padding: 24px 0;
	text-align: center;
	color: var(--q-text-muted, #8a94a6);
}

.my-vectors__toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.my-vectors__list {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.vector-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 10px 14px;
	border-radius: 8px;
	background: rgba(140, 120, 200, 0.06);
	border: 1px solid rgba(140, 120, 200, 0.12);
	font-family: var(--font-mono, monospace);
	font-size: 0.9em;
	text-decoration: none;
	cursor: pointer;
	transition: background var(--q-transition-fast, 0.15s), border-color var(--q-transition-fast, 0.15s);
}

.vector-row:hover {
	background: rgba(140, 120, 200, 0.12);
	border-color: rgba(140, 120, 200, 0.24);
}

.vector-row--skeleton {
	background: rgba(140, 120, 200, 0.04);
}

.vector-row__id {
	color: var(--q-text-bright, #ffffff);
}

.vector-row__meta {
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-body, system-ui, sans-serif);
}

.vector-row__lock {
	opacity: 0.8;
}

body.body--light .vector-row {
	background: rgba(60, 40, 110, 0.04);
	border-color: rgba(60, 40, 110, 0.1);
}

body.body--light .vector-row:hover {
	background: rgba(60, 40, 110, 0.08);
	border-color: rgba(60, 40, 110, 0.2);
}

body.body--light .vector-row__id {
	color: #2a2440;
}
</style>
