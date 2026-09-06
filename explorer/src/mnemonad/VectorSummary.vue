<template>
	<div class="vector-summary">
		<div class="vector-summary__row">
			<span class="vector-summary__label">Id</span>
			<span class="vector-summary__value vector-summary__value--mono">{{ idHex }}</span>
		</div>
		<div class="vector-summary__row">
			<span class="vector-summary__label">Owner</span>
			<ExplorerLink type="address" :value="vector.owner" :chain="chain" :label="formatAddress(vector.owner)" />
		</div>
		<div class="vector-summary__row">
			<span class="vector-summary__label">Items</span>
			<span class="vector-summary__value vector-summary__value--stacked">
				<span class="vector-summary__value-line">{{ vector.length }}</span>
				<span class="vector-summary__value-line vector-summary__value-line--muted">
					{{ loadedItems }} loaded
					<q-icon name="help_outline" size="12px" class="vector-summary__help">
						<q-tooltip>{{ LOADED_HELP_TEXT }}</q-tooltip>
					</q-icon>
				</span>
			</span>
		</div>
		<div class="vector-summary__row">
			<span class="vector-summary__label">Total size</span>
			<span class="vector-summary__value vector-summary__value--stacked">
				<span class="vector-summary__value-line">{{ formatBytes(vector.binaryLength) }}</span>
				<span class="vector-summary__value-line vector-summary__value-line--muted">
					{{ formatBytes(loadedBinaryLength) }} loaded
					<q-icon name="help_outline" size="12px" class="vector-summary__help">
						<q-tooltip>{{ LOADED_HELP_TEXT }}</q-tooltip>
					</q-icon>
				</span>
			</span>
		</div>
		<div v-if="vector.firstAvailableIndex > 0" class="vector-summary__row">
			<span class="vector-summary__label">Truncated up to</span>
			<span class="vector-summary__value">index {{ vector.firstAvailableIndex - 1 }}</span>
		</div>
		<div class="vector-summary__row">
			<span class="vector-summary__label">Encrypted</span>
			<span class="vector-summary__value">
				<q-icon v-if="vector.encrypted" name="lock" size="14px" />
				{{ vector.encrypted ? 'Yes' : 'No' }}
			</span>
		</div>
		<div class="vector-summary__row">
			<span class="vector-summary__label">Contract version</span>
			<span class="vector-summary__value">{{ vector.madeWithVersion }}</span>
		</div>
	</div>
</template>

<script>
import ExplorerLink from './ExplorerLink.vue';
import { formatBytes } from '../includes/formatBytes.js';

/** Shown on both "loaded" help icons — same underlying stat, just counted vs summed. */
const LOADED_HELP_TEXT =
	"\"Loaded\" is what's already fetched from the RPC and cached in this page's memory — " +
	'not what\'s stored on-chain or IPFS. It grows as you preview, view, or download items below.';

export default {
	name: 'VectorSummary',
	components: { ExplorerLink },
	props: {
		vector: {
			type: Object,
			required: true,
		},
		chain: {
			type: Object,
			required: true,
		},
		// How many of the displayed items already have their payload cached in memory —
		// see Vector.vue's recomputeLoaded(). Polled rather than pushed live from every
		// place an item can become loaded (a preview click, View, or Download, several
		// components away), so this can lag the real state by a beat rather than never
		// updating at all.
		loadedItems: {
			type: Number,
			default: 0,
		},
		loadedBinaryLength: {
			type: Number,
			default: 0,
		},
	},
	data() {
		return {
			LOADED_HELP_TEXT,
		};
	},
	computed: {
		idHex: function() {
			const hex = BigInt(this.vector.id).toString(16).padStart(64, '0');
			return `0x${hex.slice(0, 10)}...${hex.slice(-8)}`;
		},
	},
	methods: {
		formatBytes,
		formatAddress: function(address) {
			return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
		},
	},
};
</script>

<style scoped>
.vector-summary {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 10px 24px;
}

.vector-summary__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 8px 0;
	border-bottom: 1px solid rgba(140, 120, 200, 0.1);
}

.vector-summary__label {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.85em;
}

.vector-summary__help {
	color: var(--q-text-muted, #8a94a6);
	opacity: 0.7;
	cursor: help;
}

.vector-summary__help:hover {
	opacity: 1;
}

.vector-summary__value {
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--q-text-bright, #ffffff);
	font-family: var(--font-mono, monospace);
	font-size: 0.9em;
}

.vector-summary__value--mono {
	font-size: 0.85em;
}

.vector-summary__value--stacked {
	flex-direction: column;
	align-items: flex-end;
	gap: 2px;
}

.vector-summary__value-line--muted {
	display: inline-flex;
	align-items: center;
	gap: 3px;
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.8em;
}

body.body--light .vector-summary__row {
	border-bottom-color: rgba(60, 40, 110, 0.1);
}

body.body--light .vector-summary__value {
	color: #2a2440;
}
</style>
