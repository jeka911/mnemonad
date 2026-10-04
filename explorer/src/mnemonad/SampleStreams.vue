<template>
	<div class="sample-streams">
		<div v-if="!mnemonadStore.isDeployed" class="sample-streams__state">
			<p>Mnemonad isn't deployed on {{ activeNetwork.label }} yet.</p>
			<GradientButton
				v-if="activeNetwork.id !== 'testnet'"
				label="Switch to Testnet"
				size="sm"
				outline
				@click="setActiveNetworkId('testnet')"
			/>
		</div>

		<div v-else-if="!samples.length" class="sample-streams__state">
			<p>No sample streams on {{ activeNetwork.label }} yet.</p>
		</div>

		<template v-else>
			<p class="sample-streams__intro">
				Public streams you can browse without connecting a wallet.
			</p>

			<div class="sample-streams__list">
				<StreamRow
					v-for="sample in samples"
					:key="sample.id"
					:id="sample.id"
					:title="sample.name"
					:subtitle="sample.description"
					:count="counts[sample.id] ?? null"
					:loading="loading"
					:unit="sample.unit || 'item'"
					:encrypted="encrypted[sample.id] || false"
				/>
			</div>
		</template>
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import StreamRow from './StreamRow.vue';
import GradientButton from '../components/GradientButton.vue';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { getActiveNetwork, getActiveNetworkId, setActiveNetworkId } from '../settings.js';
import { sampleStreamsFor } from './sampleStreams.js';

/**
 * The curated half of /select — a handful of known-good streams anyone can open, including
 * a visitor with no wallet connected and nothing of their own yet.
 *
 * Item counts are fetched opportunistically and never gate the rows: a sample that fails to
 * load still renders and still links, because the list's job is to offer somewhere to go,
 * and a count is decoration next to that. There is deliberately no error state here for the
 * same reason — a curated sample failing to read is worth a quiet omission, not a red box
 * on the first screen someone sees.
 */
export default {
	name: 'SampleStreams',
	components: { StreamRow, GradientButton },
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			samples: sampleStreamsFor(getActiveNetworkId()),
			/** @type {Record<string, number>} id -> item count, filled in as each loads */
			counts: {},
			/** @type {Record<string, boolean>} */
			encrypted: {},
			loading: false,
		};
	},
	computed: {
		...mapStores(useMnemonadStore),
	},
	mounted() {
		this.loadCounts();
	},
	methods: {
		// Exposed for the template: an Options-API render function can't see module imports.
		setActiveNetworkId,
		/**
		 * Reads each sample's current state. Goes through the store's own `loadStream`, so
		 * these share the same cached instances the stream page will use a click later —
		 * opening a sample from here costs no second round of RPC calls.
		 */
		async loadCounts() {
			if (!this.mnemonadStore.isDeployed || !this.samples.length) return;
			this.loading = true;
			await Promise.all(this.samples.map(async (sample) => {
				try {
					const { stream } = await this.mnemonadStore.loadStream(BigInt(sample.id));
					this.counts = { ...this.counts, [sample.id]: stream.length };
					this.encrypted = {
						...this.encrypted,
						[sample.id]: !!(stream.encKeyWrapped && stream.encKeyWrapped.length),
					};
				} catch {
					// Left without a count — see the class comment on why this stays quiet.
				}
			}));
			this.loading = false;
		},
	},
};
</script>

<style scoped>
.sample-streams {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.sample-streams__intro {
	margin: 0;
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.85em;
}

.sample-streams__state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	padding: 24px 0;
	text-align: center;
	color: var(--q-text-muted, #8a94a6);
}

.sample-streams__list {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
</style>
