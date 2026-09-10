<template>
	<div class="add-file-chunk">
		<q-file
			v-model="file"
			label="Choose a file"
			dense
			outlined
			clearable
			:disable="disable || loading || reading"
			:max-file-size="MAX_UPLOAD_BYTES"
			@rejected="onRejected"
		>
			<template #prepend>
				<q-icon name="attach_file" />
			</template>
		</q-file>

		<p v-if="rejectedHint" class="add-file-chunk__hint add-file-chunk__hint--error">{{ rejectedHint }}</p>

		<template v-if="file">
			<p class="add-file-chunk__route" :class="{ 'add-file-chunk__route--blocked': routing.blocked }">
				{{ routing.label }}
			</p>

			<div v-if="progress" class="add-file-chunk__progress">
				<q-linear-progress :value="progressFraction" color="primary" size="6px" rounded />
				<span class="add-file-chunk__progress-label">{{ progressLabel }}</span>
			</div>

			<div class="add-file-chunk__row">
				<span v-if="!progress && hint" class="add-file-chunk__hint">{{ hint }}</span>
				<GradientButton
					label="Upload"
					loading-label="Uploading..."
					size="sm"
					class="add-file-chunk__submit"
					:loading="loading || reading"
					:disable="disable || routing.blocked || !fileBytes"
					@click="submit"
				/>
			</div>
			<div v-if="costLine" class="add-file-chunk__cost">{{ costLine }}</div>
		</template>

		<!-- Not encrypted even on an encrypted stream — see itemMeta.js's own file comment.
		     Only shown once a file is picked, so it never competes for attention with the
		     routing line above before there's anything to say it about. -->
		<p v-if="file" class="add-file-chunk__meta-note">
			Filename and type travel as item metadata, in the clear — even on an encrypted
			stream. Don't upload a file whose name alone is sensitive.
		</p>
	</div>
</template>

<script>
import { MnemonadCrypto } from '@mnemonad';
import GradientButton from '../../../components/GradientButton.vue';
import { formatBytes } from '../../../includes/formatBytes.js';
import { formatMon } from '../../../includes/formatMon.js';

/** Wait for the picker to settle before spending an RPC round-trip on an estimate. */
const ESTIMATE_DEBOUNCE_MS = 500;

/**
 * Hard cap, enforced before the file is ever read into memory (q-file's own
 * `max-file-size` checks `.size` directly, no `arrayBuffer()` call needed) — hex-encoding
 * calldata in the browser is memory-heavy, and this demo has no business asking for more.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Past this many chunks, staging on-chain means that many `appendChunk` wallet
 * confirmations — DEMO_PLAN.md's own §5.4 already flags 11 prompts (a 1 MB file at 120 KB
 * chunks) as a real UX cliff, so 20 is a deliberately conservative ceiling past which IPFS
 * (if configured) is preferred instead, rather than routing there only once staging becomes
 * outright impossible.
 */
const STAGED_CHUNK_CEILING = 20;

export default {
	name: 'AddFileChunk',
	components: { GradientButton },
	props: {
		// True when the connected wallet can't push right now — see Stream.vue's
		// canWrite/wrongNetwork/hasUsableKey check.
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
		// The stream's maxChunkBytes — same role as AddTextChunk's identical prop: the
		// single-transaction on-chain ceiling routing is computed against.
		maxBytes: {
			type: Number,
			default: Infinity,
		},
		// The store's discovered gateway, or null — same prop OffloadUpload.vue already
		// takes. Not just "is a sign server configured" (that alone doesn't mean a route
		// external will actually work: the presign server unconditionally requires a paid
		// escrow before it will issue an upload URL at all, and that escrow needs a real,
		// unpaused gateway wired on-chain to exist against).
		gateway: {
			type: Object,
			default: null,
		},
		// Whether the stream is encrypted — routing has to be computed against CIPHERTEXT
		// size, same reasoning AddTextChunk would need if it predicted tiers (it doesn't;
		// push() just routes correctly either way). Framing overhead can bump a file that
		// looks like it fits on-chain into staged, or staged into external.
		encrypted: {
			type: Boolean,
			default: false,
		},
		// (bytes: Uint8Array) => Promise<CostEstimate|null> — same delegation pattern as
		// AddTextChunk's `estimate` prop.
		estimate: {
			type: Function,
			default: null,
		},
		// { phase: 'begin'|'chunk'|'commit', chunkIndex: number, chunkCount: number } | null
		// — Stream.vue owns the actual push() call and its onProgress callback; this is
		// purely passed through for display. Only ever non-null while `loading` is true and
		// the upload happens to be staged (see routing.onChain below).
		progress: {
			type: Object,
			default: null,
		},
	},
	emits: ['submit'],
	data() {
		return {
			file: null,
			fileBytes: null,
			reading: false,
			rejectedHint: '',
			estimating: false,
			costEstimate: null,
			MAX_UPLOAD_BYTES,
		};
	},
	computed: {
		// Ciphertext size if encrypted, else the raw file size — matches push()'s own
		// "encrypt first, then route" order, so the predicted tier is never wrong relative
		// to what push() will actually do.
		effectiveSize() {
			if (!this.fileBytes) return 0;
			return this.encrypted
				? MnemonadCrypto.ciphertextLengthFor(this.fileBytes.length)
				: this.fileBytes.length;
		},
		stagedCeilingBytes() {
			return this.maxBytes * STAGED_CHUNK_CEILING;
		},
		// Real, not just "a sign server URL is configured" — the presign server
		// unconditionally requires an escrow before issuing an upload URL at all, and
		// there's no escrow to have without an actual, unpaused gateway wired on-chain.
		canOffload() {
			return !!(this.gateway && !this.gateway.paused);
		},
		/**
		 * The single source of truth for both what's shown and what's actually pushed —
		 * see submit() below, which just forwards `routing.onChain`/`routing.external`
		 * verbatim rather than recomputing this decision a second time in Stream.vue.
		 * @returns {{label: string, onChain: boolean, external: boolean, blocked: boolean}}
		 */
		routing() {
			if (!this.fileBytes) return { label: '', onChain: false, external: false, blocked: false };
			const size = this.effectiveSize;
			if (size <= this.maxBytes) {
				return { label: `${formatBytes(size)} → stored on-chain, one transaction.`, onChain: false, external: false, blocked: false };
			}
			if (size <= this.stagedCeilingBytes) {
				const chunks = Math.ceil(size / this.maxBytes);
				return {
					label: `${formatBytes(size)} → staged on-chain across ${chunks} chunks (${chunks + 2} transactions, ${chunks} wallet confirmations for the chunks alone).`,
					onChain: true,
					external: false,
					blocked: false,
				};
			}
			if (this.canOffload) {
				return {
					label: `${formatBytes(size)} → too large to stage reasonably on-chain; prepaid via the gateway and stored via IPFS instead.`,
					onChain: false,
					external: true,
					blocked: false,
				};
			}
			return {
				label: `${formatBytes(size)} exceeds what this stream can stage on-chain (~${formatBytes(this.stagedCeilingBytes)}), and no IPFS upload gateway is wired for this stream.`,
				onChain: false,
				external: false,
				blocked: true,
			};
		},
		canEstimate() {
			return !this.disable && !this.routing.blocked && !!this.fileBytes && !!this.estimate;
		},
		costLine() {
			if (this.estimating) return 'Estimating cost…';
			if (!this.costEstimate) return '';
			const { total, transactionCount } = this.costEstimate;
			const txNote = transactionCount > 1 ? ` across ${transactionCount} transactions` : '';
			return `~${formatMon(total)} MON (gas + fee)${txNote}`;
		},
		progressFraction() {
			if (!this.progress || !this.progress.chunkCount) return 0;
			return this.progress.chunkIndex / this.progress.chunkCount;
		},
		progressLabel() {
			if (!this.progress) return '';
			if (this.progress.phase === 'begin') return 'Starting staged upload…';
			if (this.progress.phase === 'commit') return 'Finishing…';
			return `Uploading chunk ${this.progress.chunkIndex} of ${this.progress.chunkCount}…`;
		},
	},
	watch: {
		file(newFile) {
			this.rejectedHint = '';
			this.fileBytes = null;
			this.costEstimate = null;
			if (!newFile) return;
			this.readFile(newFile);
		},
		fileBytes() {
			this.scheduleEstimate();
		},
		disable() {
			this.scheduleEstimate();
		},
	},
	created() {
		// Plain timer handle, kept off reactive state — same reasoning as AddTextChunk.
		this._debounceTimer = null;
	},
	beforeUnmount() {
		clearTimeout(this._debounceTimer);
	},
	methods: {
		formatBytes,
		// q-file's own @rejected fires for a file over max-file-size before it ever reaches
		// `file` — this is the ONLY path an oversized selection takes; readFile() below
		// never sees it.
		onRejected(entries) {
			const reason = entries?.[0]?.failedPropValidation === 'max-file-size'
				? `File is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} cap.`
				: 'File was rejected.';
			this.rejectedHint = reason;
		},
		async readFile(file) {
			this.reading = true;
			try {
				const buffer = await file.arrayBuffer();
				this.fileBytes = new Uint8Array(buffer);
			} catch (e) {
				this.rejectedHint = e?.message || 'Failed to read file.';
				this.file = null;
			} finally {
				this.reading = false;
			}
		},
		scheduleEstimate() {
			clearTimeout(this._debounceTimer);
			this.costEstimate = null;
			if (!this.canEstimate) return;
			this._debounceTimer = setTimeout(() => this.runEstimate(), ESTIMATE_DEBOUNCE_MS);
		},
		async runEstimate() {
			if (!this.canEstimate) return;
			this.estimating = true;
			try {
				this.costEstimate = await this.estimate(this.fileBytes);
			} catch {
				this.costEstimate = null; // best-effort — a failed estimate just shows nothing
			} finally {
				this.estimating = false;
			}
		},
		submit() {
			if (!this.fileBytes || this.disable || this.loading || this.routing.blocked) return;
			// Only `onChain` is forwarded — Stream.vue's push() decides the off-chain route
			// (and pays for it) entirely on its own when this is false and the item doesn't
			// fit on-chain; `routing.external` here is purely for this component's own
			// display label, not something the caller needs to act on.
			this.$emit('submit', {
				bytes: this.fileBytes,
				name: this.file.name,
				mimeType: this.file.type,
				onChain: this.routing.onChain,
			});
			this.file = null;
			this.fileBytes = null;
			this.costEstimate = null;
		},
	},
};
</script>

<style scoped>
.add-file-chunk {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.add-file-chunk__route {
	margin: 0;
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
}

.add-file-chunk__route--blocked {
	opacity: 1;
	color: var(--q-negative, #e57373);
}

.add-file-chunk__progress {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.add-file-chunk__progress-label {
	font-size: 12px;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-mono, monospace);
}

.add-file-chunk__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.add-file-chunk__hint {
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
}

.add-file-chunk__hint--error {
	margin: 0;
	opacity: 1;
	color: var(--q-negative, #e57373);
}

/* The hint span is conditional — when it's absent, this is the row's only flex child, and
   `justify-content: space-between` alone would leave a lone child at flex-start instead of
   the right. Same fix AddTextChunk's own submit button already uses. */
.add-file-chunk__submit {
	margin-left: auto;
}

.add-file-chunk__cost {
	font-size: 12px;
	opacity: 0.75;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-mono, monospace);
}

.add-file-chunk__meta-note {
	margin: 0;
	font-size: 11px;
	opacity: 0.6;
	color: var(--q-text-muted, #8a94a6);
}
</style>
