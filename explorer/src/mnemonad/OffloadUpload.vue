<template>
	<div class="offload">
		<p v-if="!gateway" class="offload__note">
			No paid-upload gateway is wired to this registry, so off-chain items pay the
			registry's flat EXTERNAL fee instead.
		</p>
		<p v-else-if="gateway.paused" class="offload__note offload__note--warn">
			The gateway is paused — new quota can't be bought right now.
		</p>
		<template v-else>
			<div class="offload__slider">
				<div class="offload__slider-label">
					<span>Payload size</span>
					<span class="offload__value">{{ formatBytes(size) }}</span>
				</div>
				<q-slider
					v-model="size"
					:min="minSize"
					:max="maxSize"
					:step="STEP"
					:disable="disable || loading"
					color="primary"
					label
					:label-value="formatBytes(size)"
				/>
			</div>

			<div class="offload__facts">
				<div class="offload__fact">
					<span>Routing</span>
					<span class="offload__value">
						IPFS — {{ formatBytes(size) }} exceeds the {{ formatBytes(maxChunkBytes) }} on-chain limit
					</span>
				</div>
				<div class="offload__fact">
					<span>Gateway price</span>
					<span class="offload__value">
						{{ gateway.usdCentsPerMiB }}¢ / MiB
						<template v-if="gateway.weiPerMiB"> · {{ formatMon(gateway.weiPerMiB) }} MON / MiB</template>
					</span>
				</div>
				<div class="offload__fact">
					<span>Prepay</span>
					<span class="offload__value offload__value--bright">
						<template v-if="quoteWei !== null">~{{ formatMon(quoteWei) }} MON</template>
						<template v-else-if="quoting">quoting…</template>
						<template v-else>unavailable — oracle can't be quoted against</template>
					</span>
				</div>
			</div>

			<p class="offload__note">
				Prepaying escrows the quote against this payload's exact sha256, then the pointer
				commit settles it — so the registry's EXTERNAL fee is waived. If the upload never
				lands, the escrow is reclaimable after {{ Math.round(gateway.requestTtl / 60) }} min.
			</p>

			<div class="offload__row">
				<span v-if="hint" class="offload__hint">{{ hint }}</span>
				<GradientButton
					label="Prepay & upload"
					loading-label="Uploading..."
					size="sm"
					class="offload__submit"
					:loading="loading"
					:disable="disable || quoteWei === null"
					@click="submit"
				/>
			</div>
		</template>
	</div>
</template>

<script>
import GradientButton from '../components/GradientButton.vue';
import { formatBytes } from '../includes/formatBytes.js';
import { formatMon } from '../includes/formatMon.js';

/** Slider granularity. Byte-exact sizing here would be false precision. */
const STEP = 4096;

/** Wait for the slider to settle before spending an RPC round-trip on a quote. */
const QUOTE_DEBOUNCE_MS = 350;

export default {
	name: 'OffloadUpload',
	components: { GradientButton },
	props: {
		// True when the connected wallet can't push right now — see Vector.vue's canWrite.
		disable: {
			type: Boolean,
			default: false,
		},
		hint: {
			type: String,
			default: '',
		},
		loading: {
			type: Boolean,
			default: false,
		},
		// This vector's on-chain ceiling. Anything above it routes off-chain, which is the
		// only case the gateway applies to at all.
		maxChunkBytes: {
			type: Number,
			required: true,
		},
		// The store's discovered gateway, or null. See stores/mnemonad.js `fetchGateway`.
		gateway: {
			type: Object,
			default: null,
		},
		// (size: number) => Promise<bigint|null> — Vector.vue owns the SDK clients, so
		// quoting is delegated up, same as AddTextChunk's `estimate`.
		quoteFor: {
			type: Function,
			default: null,
		},
		// True only while the "Offload" tab is the one showing. This component stays
		// mounted the whole time via `v-show` (see Vector.vue's own comment on why), so
		// without this a quote would fire the moment the page loads — an `uploadGateway()` +
		// `quote()` round trip the user never asked for, for a tab they may never open.
		active: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['submit'],
	data() {
		return {
			STEP,
			// Start one step above the on-chain limit: below it there is nothing to offload
			// and the gateway would not apply.
			size: this.maxChunkBytes + STEP,
			quoteWei: null,
			quoting: false,
		};
	},
	computed: {
		minSize() {
			return this.maxChunkBytes + STEP;
		},
		/**
		 * A deliberate ceiling rather than "unbounded": this generates the payload in the
		 * browser and uploads it over the dev credential, so multi-megabyte sizes would be
		 * slow and would spend real testnet MON for no extra signal.
		 */
		maxSize() {
			return this.maxChunkBytes * 8;
		},
	},
	watch: {
		size() {
			if (this.active) this.scheduleQuote();
		},
		gateway() {
			if (this.active) this.scheduleQuote();
		},
		// `immediate: true` so switching to this tab (active goes false → true) and the
		// tab already being active at creation (were that ever the default) both fetch —
		// while never firing for the common case, active starting false and staying that
		// way until the user clicks over.
		active: {
			handler(isActive) {
				if (isActive) this.scheduleQuote();
			},
			immediate: true,
		},
	},
	created() {
		// Plain timer handle, kept off reactive state — same reasoning as AddTextChunk.
		this._timer = null;
	},
	beforeUnmount() {
		clearTimeout(this._timer);
	},
	methods: {
		formatBytes,
		formatMon,
		scheduleQuote() {
			clearTimeout(this._timer);
			this.quoteWei = null;
			if (!this.quoteFor || !this.gateway || this.gateway.paused) return;
			this._timer = setTimeout(() => this.runQuote(), QUOTE_DEBOUNCE_MS);
		},
		async runQuote() {
			this.quoting = true;
			try {
				this.quoteWei = await this.quoteFor(this.size);
			} catch {
				this.quoteWei = null; // the gateway itself refused to quote — show that
			} finally {
				this.quoting = false;
			}
		},
		submit() {
			if (this.disable || this.loading || this.quoteWei === null) return;
			this.$emit('submit', { size: this.size, quoteWei: this.quoteWei });
		},
	},
};
</script>

<style scoped>
.offload {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.offload__slider {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.offload__slider-label,
.offload__fact {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	font-size: 12px;
	color: var(--q-text-muted, #8a94a6);
}

.offload__facts {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 10px 12px;
	border-radius: 8px;
	background: rgba(140, 120, 200, 0.05);
	border: 1px solid rgba(140, 120, 200, 0.12);
}

.offload__value {
	font-family: var(--font-mono, monospace);
	text-align: right;
}

.offload__value--bright {
	color: var(--q-text-bright, #ffffff);
}

.offload__note {
	margin: 0;
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
}

.offload__note--warn {
	opacity: 1;
	color: var(--q-negative, #e57373);
}

.offload__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.offload__hint {
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
}

/* The hint is conditional, so `space-between` alone would leave a lone button at
   flex-start — same fix as AddTextChunk's submit. */
.offload__submit {
	margin-left: auto;
}

body.body--light .offload__facts {
	background: rgba(60, 40, 110, 0.035);
	border-color: rgba(60, 40, 110, 0.1);
}

body.body--light .offload__value--bright {
	color: #2a2440;
}
</style>
