<template>
	<q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" position="standard">
		<JPanel accent="header" icon="dns" iconColor="var(--q-primary)" title="RPC calls (session)" style="min-width: 420px; max-width: 640px;">
			<div class="rpc-log q-pa-md">
				<p v-if="!entries.length" class="rpc-log__empty">No RPC calls recorded yet.</p>
				<div v-else class="rpc-log__list">
					<template v-for="entry in entries" :key="entry.position">
						<div
							class="rpc-log__row"
							:class="{ 'rpc-log__row--odd': entry.position % 2 === 1, 'rpc-log__row--error': entry.status === 'error' }"
						>
							<span class="rpc-log__position">#{{ entry.position }}</span>
							<span class="rpc-log__kind" :class="`rpc-log__kind--${entry.kind}`">{{ entry.kind }}</span>
							<span class="rpc-log__name" :class="{ 'rpc-log__name--pending': entry.status === 'pending' }">
								{{ entry.name }}
								<span v-if="entry.status === 'error'" class="rpc-log__failed">failed</span>
							</span>
							<span class="rpc-log__time">{{ entry.time }}</span>
						</div>
						<div v-if="entry.status === 'error'" class="rpc-log__error">{{ entry.error }}</div>
					</template>
				</div>
			</div>

			<template #header-action>
				<q-btn flat round icon="close" size="sm" v-close-popup />
			</template>
		</JPanel>
	</q-dialog>
</template>

<script>
import { JPanel } from 'themed_varmory';
import { getRpcCallLog, subscribeRpcCalls } from '@mnemonad';

/** `HH:MM:SS.mmm`, local time — enough to see how tightly a burst of calls clustered. */
function formatTime(at) {
	const d = new Date(at);
	const pad = (n, len = 2) => String(n).padStart(len, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Maps one `MnemonadRpcRecorder` log entry to what this dialog renders. `position` comes
 * straight from the entry — stable for its whole lifetime, so it survives the entry updating
 * in place from 'pending' to 'ok'/'error' without this row losing its spot in the list.
 */
function toRow(entry) {
	return {
		position: entry.position,
		kind: entry.method === 'writeContract' ? 'write' : 'read',
		name: entry.functionName ?? entry.method,
		time: formatTime(entry.at),
		status: entry.status,
		error: entry.error,
	};
}

/**
 * Session-only RPC call inspector, opened by clicking the count in DebugPanel. Its own
 * component rather than folded into DebugPanel: a dialog has its own lifecycle (subscribe
 * only while open) that would otherwise tangle with the panel's always-on subscription.
 */
export default {
	name: 'RpcCallLogDialog',
	components: { JPanel },
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:modelValue'],
	data() {
		return {
			entries: [], // newest first
			unsubscribe: null,
		};
	},
	watch: {
		modelValue(open) {
			if (open) this.start();
			else this.stop();
		},
	},
	beforeUnmount() {
		this.stop();
	},
	methods: {
		/** Snapshots the log as it stands, then keeps listening so a call made while the
		 * dialog is open — including one already showing here settling from 'pending' to
		 * 'ok'/'error' — updates live without reopening. */
		start() {
			const log = getRpcCallLog();
			this.entries = log.map(toRow).reverse();

			this.unsubscribe = subscribeRpcCalls(({ entry }) => {
				const row = toRow(entry);
				// Every call notifies twice — recorded, then settled — both for the same
				// position, so this is an upsert: new row on the first notification, in-place
				// update (via splice, so Vue's reactivity actually notices) on the second.
				const i = this.entries.findIndex((e) => e.position === row.position);
				if (i === -1) this.entries.unshift(row);
				else this.entries.splice(i, 1, row);
			});
		},
		stop() {
			this.unsubscribe?.();
			this.unsubscribe = null;
		},
	},
};
</script>

<style scoped>
.rpc-log__empty {
	margin: 0;
	font-size: 13px;
	color: var(--q-text-muted, #8a94a6);
}

.rpc-log__list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	max-height: 60vh;
	overflow-y: auto;
}

.rpc-log__row {
	display: grid;
	grid-template-columns: 3.5em 3.5em 1fr auto;
	align-items: center;
	gap: 8px;
	padding: 4px 6px;
	font-size: 12px;
	font-family: var(--font-mono, monospace);
	border-radius: 4px;
}

/* Explicit class, not :nth-child(odd) — the error-detail line below a failed row is a
   sibling in the DOM, which would otherwise throw off the alternating stripe. */
.rpc-log__row--odd {
	background: rgba(255, 255, 255, 0.03);
}

body.body--light .rpc-log__row--odd {
	background: rgba(0, 0, 0, 0.03);
}

.rpc-log__row--error {
	background: rgba(224, 91, 91, 0.14);
}

.rpc-log__position {
	color: var(--q-text-muted, #8a94a6);
}

.rpc-log__kind {
	text-transform: uppercase;
	font-size: 10px;
	letter-spacing: 0.04em;
}

.rpc-log__kind--read { color: var(--q-primary, #8a7cff); }
.rpc-log__kind--write { color: #f2c037; }

.rpc-log__name {
	color: var(--q-text, #c8d6e5);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.rpc-log__name--pending {
	opacity: 0.6;
	font-style: italic;
}

.rpc-log__failed {
	text-transform: uppercase;
	font-size: 10px;
	letter-spacing: 0.04em;
	color: var(--q-negative, #e55b5b);
	margin-left: 6px;
}

.rpc-log__error {
	margin: -2px 6px 2px;
	padding: 2px 6px 4px;
	font-size: 11px;
	font-family: var(--font-mono, monospace);
	color: var(--q-negative, #e55b5b);
	white-space: pre-wrap;
	word-break: break-word;
}

body.body--light .rpc-log__name {
	color: #2a2440;
}

.rpc-log__time {
	color: var(--q-text-muted, #8a94a6);
}
</style>
