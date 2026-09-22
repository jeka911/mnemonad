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
				<div class="my-streams__toolbar-actions">
					<!-- fetchOwnedStreams caches by owner — a plain reconnect/account-switch
					     never re-fetches for nothing, but it also has no way to notice a
					     stream created/transferred/burned outside this session, hence this. -->
					<GradientButton
						label="Refresh"
						icon="refresh"
						size="sm"
						:loading="mnemonadStore.loading"
						@click="refresh"
					/>
					<GradientButton
						label="New stream"
						icon="add"
						size="sm"
						:disable="walletStore.wrongNetwork"
						@click="showCreate = true"
					/>
				</div>
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
				<StreamRow
					v-for="v in mnemonadStore.streams"
					:key="String(v.id)"
					:id="String(v.id)"
					:count="v.length"
					:encrypted="v.encrypted"
				/>
			</div>
		</template>

		<CreateStreamDialog v-model="showCreate" />
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import GradientButton from '../components/GradientButton.vue';
import StreamRow from './StreamRow.vue';
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
		StreamRow,
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
		/**
		 * The "Refresh" button — bypasses fetchOwnedStreams' own by-owner cache, for
		 * whatever it has no way to notice on its own (a stream created/transferred/burned
		 * outside this session). Unlike `load()`, this can throw: the store deliberately
		 * re-throws rather than clobbering an already-good list with a blocking `error`
		 * state just because one refresh attempt hit a blip — surfaced here as a toast
		 * instead, non-blocking, so the still-good list underneath stays visible.
		 */
		async refresh() {
			if (!this.walletStore.isConnected) return;
			try {
				await this.mnemonadStore.fetchOwnedStreams(this.walletStore.address, { force: true });
			} catch (e) {
				this.$q.notify({
					type: 'negative',
					message: e?.message || 'Failed to refresh streams',
					position: 'top',
				});
			}
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

.my-streams__toolbar-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}

.my-streams__list {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.stream-row--skeleton {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 10px 14px;
	border-radius: 8px;
	background: rgba(140, 120, 200, 0.04);
	border: 1px solid rgba(140, 120, 200, 0.12);
}

body.body--light .stream-row--skeleton {
	background: rgba(60, 40, 110, 0.04);
	border-color: rgba(60, 40, 110, 0.1);
}
</style>
