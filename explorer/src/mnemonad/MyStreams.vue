<template>
	<div class="my-streams">
		<!-- Not deployed on this network: same pattern Home.vue already used for the
		     canvas-era placeholder. -->
		<div v-if="!mnemonadStore.isDeployed" class="my-streams__state">
			<p>Mnemonad isn't deployed on {{ activeNetwork.label }} yet.</p>
		</div>

		<!-- Disconnected: nothing to list without an address to list it for. -->
		<div v-else-if="!walletStore.isConnected" class="my-streams__state">
			<p>Connect a wallet to see your streams.</p>
			<WalletConnect />
		</div>

		<template v-else>
			<div class="my-streams__toolbar">
				<ExplorerLink
					type="address"
					:value="mnemonadStore.contractAddress"
					:chain="activeNetwork.chain"
					label="View registry"
				/>
				<GradientButton
					label="New stream"
					icon="add"
					size="sm"
					:disable="walletStore.wrongNetwork"
					@click="showCreate = true"
				/>
			</div>

			<!-- Loading: skeleton rows shaped like the real ones, not a spinner. -->
			<div v-if="mnemonadStore.loading" class="my-streams__list">
				<div v-for="i in 3" :key="i" class="stream-row stream-row--skeleton">
					<q-skeleton type="text" width="140px" />
					<q-skeleton type="text" width="60px" />
				</div>
			</div>

			<!-- Error: inline retry, not a toast — this is the initial load, not a
			     transient event. -->
			<div v-else-if="mnemonadStore.error" class="my-streams__state">
				<p>{{ mnemonadStore.error }}</p>
				<GradientButton label="Retry" size="sm" @click="load" />
			</div>

			<div v-else-if="!mnemonadStore.streams.length" class="my-streams__state">
				<p>No streams yet.</p>
			</div>

			<div v-else class="my-streams__list">
				<router-link
					v-for="v in mnemonadStore.streams"
					:key="String(v.id)"
					:to="`/stream/${v.id}`"
					class="stream-row"
				>
					<span class="stream-row__id">{{ formatId(v.id) }}</span>
					<span class="stream-row__meta">
						<q-icon v-if="v.encrypted" name="lock" size="14px" class="stream-row__lock" />
						{{ v.length }} {{ v.length === 1 ? 'item' : 'items' }}
					</span>
				</router-link>
			</div>
		</template>

		<CreateStreamDialog v-model="showCreate" />
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import GradientButton from '../components/GradientButton.vue';
import ExplorerLink from './ExplorerLink.vue';
import CreateStreamDialog from './CreateStreamDialog.vue';
import WalletConnect from '../WalletConnect.vue';
import { useWalletStore } from '../stores/wallet.js';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { getActiveNetwork } from '../settings.js';

export default {
	name: 'MyStreams',
	components: {
		GradientButton,
		ExplorerLink,
		CreateStreamDialog,
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
				this.mnemonadStore.fetchOwnedStreams(this.walletStore.address);
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
.my-streams {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.my-streams__state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	padding: 24px 0;
	text-align: center;
	color: var(--q-text-muted, #8a94a6);
}

.my-streams__toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.my-streams__list {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.stream-row {
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

.stream-row:hover {
	background: rgba(140, 120, 200, 0.12);
	border-color: rgba(140, 120, 200, 0.24);
}

.stream-row--skeleton {
	background: rgba(140, 120, 200, 0.04);
}

.stream-row__id {
	color: var(--q-text-bright, #ffffff);
}

.stream-row__meta {
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-body, system-ui, sans-serif);
}

.stream-row__lock {
	opacity: 0.8;
}

body.body--light .stream-row {
	background: rgba(60, 40, 110, 0.04);
	border-color: rgba(60, 40, 110, 0.1);
}

body.body--light .stream-row:hover {
	background: rgba(60, 40, 110, 0.08);
	border-color: rgba(60, 40, 110, 0.2);
}

body.body--light .stream-row__id {
	color: #2a2440;
}
</style>
