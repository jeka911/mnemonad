<template>
	<div class="stream-summary">
		<div class="stream-summary__row">
			<span class="stream-summary__label">Id</span>
			<ExplorerLink
				type="token"
				:value="stream.id"
				:contract-address="contractAddress"
				:chain="chain"
				:label="idHex"
			/>
		</div>
		<div class="stream-summary__row">
			<span class="stream-summary__label">Owner</span>
			<ExplorerLink type="address" :value="stream.owner" :chain="chain" :label="formatAddress(stream.owner)" />
		</div>
		<div class="stream-summary__row">
			<span class="stream-summary__label">Items</span>
			<span class="stream-summary__value stream-summary__value--stacked">
				<span class="stream-summary__value-line">{{ stream.length }}</span>
				<span class="stream-summary__value-line stream-summary__value-line--muted">
					{{ loadedItems }} loaded
					<q-icon name="help_outline" size="12px" class="stream-summary__help">
						<q-tooltip>{{ LOADED_HELP_TEXT }}</q-tooltip>
					</q-icon>
				</span>
			</span>
		</div>
		<div class="stream-summary__row">
			<span class="stream-summary__label">Total size</span>
			<span class="stream-summary__value stream-summary__value--stacked">
				<span class="stream-summary__value-line">{{ formatBytes(stream.binaryLength) }}</span>
				<span class="stream-summary__value-line stream-summary__value-line--muted">
					{{ formatBytes(loadedBinaryLength) }} loaded
					<q-icon name="help_outline" size="12px" class="stream-summary__help">
						<q-tooltip>{{ LOADED_HELP_TEXT }}</q-tooltip>
					</q-icon>
				</span>
			</span>
		</div>
		<div v-if="stream.firstAvailableIndex > 0" class="stream-summary__row">
			<span class="stream-summary__label">Truncated up to</span>
			<span class="stream-summary__value">index {{ stream.firstAvailableIndex - 1 }}</span>
		</div>
		<div class="stream-summary__row">
			<span class="stream-summary__label">Encrypted</span>
			<span class="stream-summary__value">
				<q-icon v-if="stream.encrypted" name="lock" size="14px" />
				{{ stream.encrypted ? 'Yes' : 'No' }}
			</span>
		</div>
		<div class="stream-summary__row">
			<span class="stream-summary__label">Contract version</span>
			<span class="stream-summary__value">{{ stream.madeWithVersion }}</span>
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
	name: 'StreamSummary',
	components: { ExplorerLink },
	props: {
		stream: {
			type: Object,
			required: true,
		},
		// The registry contract's address — needed to link the stream's id to its own
		// per-token page (`/nft/{contract}/{tokenId}`), distinct from `stream.owner`'s
		// address page.
		contractAddress: {
			type: String,
			required: true,
		},
		chain: {
			type: Object,
			required: true,
		},
		// How many of the displayed items already have their payload cached in memory —
		// see Stream.vue's recomputeLoaded(). Polled rather than pushed live from every
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
			const hex = BigInt(this.stream.id).toString(16).padStart(64, '0');
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
.stream-summary {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 10px 24px;
}

.stream-summary__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 8px 0;
	border-bottom: 1px solid rgba(140, 120, 200, 0.1);
}

.stream-summary__label {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.85em;
}

.stream-summary__help {
	color: var(--q-text-muted, #8a94a6);
	opacity: 0.7;
	cursor: help;
}

.stream-summary__help:hover {
	opacity: 1;
}

.stream-summary__value {
	display: flex;
	align-items: center;
	gap: 4px;
	color: var(--q-text-bright, #ffffff);
	font-family: var(--font-mono, monospace);
	font-size: 0.9em;
}

.stream-summary__value--stacked {
	flex-direction: column;
	align-items: flex-end;
	gap: 2px;
}

.stream-summary__value-line--muted {
	display: inline-flex;
	align-items: center;
	gap: 3px;
	color: var(--q-text-muted, #8a94a6);
	font-size: 0.8em;
}

body.body--light .stream-summary__row {
	border-bottom-color: rgba(60, 40, 110, 0.1);
}

body.body--light .stream-summary__value {
	color: #2a2440;
}
</style>
