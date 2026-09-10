<template>
	<div class="add-random-bytes">
		<div class="add-random-bytes__slider">
			<div class="add-random-bytes__slider-label">
				<span>Chunks</span>
				<span class="add-random-bytes__slider-value">{{ count }}</span>
			</div>
			<q-slider
				v-model="count"
				:min="1"
				:max="maxChunks"
				:step="1"
				:disable="disable || loading"
				color="primary"
				label
				:label-value="`${count}`"
			/>
		</div>

		<div class="add-random-bytes__slider">
			<div class="add-random-bytes__slider-label">
				<span>Bytes per chunk</span>
				<span class="add-random-bytes__slider-value">{{ formatBytes(chunkSize) }}</span>
			</div>
			<q-slider
				v-model="chunkSize"
				:min="1"
				:max="maxBytesCapped"
				:step="1"
				:disable="disable || loading"
				color="primary"
				label
				:label-value="formatBytes(chunkSize)"
			/>
		</div>

		<div class="add-random-bytes__row">
			<span class="add-random-bytes__hint">
				{{ count }} chunk{{ count === 1 ? '' : 's' }} × {{ formatBytes(chunkSize) }} = {{ formatBytes(totalBytes) }} total
			</span>
			<GradientButton
				label="Add random"
				loading-label="Adding..."
				size="sm"
				:loading="loading"
				:disable="disable || !canSubmit"
				@click="submit"
			/>
		</div>
	</div>
</template>

<script>
import GradientButton from '../../../components/GradientButton.vue';
import { formatBytes } from '../../../includes/formatBytes.js';

/** Purely a UI ceiling on the "chunks" slider — keeps one generated batch (and the
 *  single transaction it becomes) from growing unreasonably large by default. */
const DEFAULT_MAX_CHUNKS = 30;
const DEFAULT_CHUNK_SIZE = 64;

export default {
	name: 'AddRandomBytes',
	components: { GradientButton },
	props: {
		// True when the connected wallet can't push right now (disconnected, wrong
		// network, or not authorized) — see Stream.vue's canWrite/wrongNetwork check.
		disable: {
			type: Boolean,
			default: false,
		},
		loading: {
			type: Boolean,
			default: false,
		},
		// The stream's maxChunkBytes — caps the "bytes per chunk" slider so every
		// generated chunk fits in a single on-chain push() with no staging/IPFS routing
		// needed. This tool is for exercising the plain packed-multi-chunk path, not the
		// oversized-item routes AddTextChunk already covers.
		maxBytes: {
			type: Number,
			default: 1024,
		},
		// Upper bound on the "chunks" slider.
		maxChunks: {
			type: Number,
			default: DEFAULT_MAX_CHUNKS,
		},
	},
	emits: ['submit'],
	data() {
		return {
			count: Math.min(5, this.maxChunks),
			chunkSize: Math.max(1, Math.min(DEFAULT_CHUNK_SIZE, Math.floor(this.maxBytes))),
		};
	},
	computed: {
		maxBytesCapped: function() {
			return Math.max(1, Math.floor(this.maxBytes));
		},
		totalBytes: function() {
			return this.count * this.chunkSize;
		},
		canSubmit: function() {
			return this.count > 0 && this.chunkSize > 0;
		},
	},
	watch: {
		// The stream's real limit is only known once Stream.vue's load() resolves — this
		// prop starts at a placeholder default, so clamp once the real one arrives instead
		// of leaving a slider value that's invalid for this stream.
		maxBytesCapped: function(newMax) {
			if (this.chunkSize > newMax) this.chunkSize = newMax;
		},
		maxChunks: function(newMax) {
			if (this.count > newMax) this.count = newMax;
		},
	},
	methods: {
		formatBytes,
		submit: function() {
			if (!this.canSubmit || this.disable || this.loading) return;
			this.$emit('submit', { count: this.count, chunkSize: this.chunkSize });
		},
	},
};
</script>

<style scoped>
.add-random-bytes {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.add-random-bytes__slider {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.add-random-bytes__slider-label {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 12px;
	color: var(--q-text-muted, #8a94a6);
}

.add-random-bytes__slider-value {
	font-family: var(--font-mono, monospace);
	color: var(--q-text-bright, #ffffff);
}

body.body--light .add-random-bytes__slider-value {
	color: #2a2440;
}

.add-random-bytes__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.add-random-bytes__hint {
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-mono, monospace);
}
</style>
