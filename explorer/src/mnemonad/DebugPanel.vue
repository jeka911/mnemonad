<template>
	<JPanel icon="bug_report" title="Debug" class="q-mt-md debug-panel ">
		<div class="q-pa-md">
		<div class="debug-panel__row">
			<span class="debug-panel__label">Disable caching</span>
			<q-toggle
				:model-value="debugStore.cachingDisabled"
				color="primary"
				dense
				@update:model-value="debugStore.setCachingDisabled($event)"
			/>
		</div>
		<p class="debug-panel__hint">
			Every <code>Mnemonad</code> instance is built with <code>cache: false</code> while
			this is on — refs, pointers, and payload bytes all skip the cache and hit the
			chain/IPFS directly. Session-only; resets when the browser is closed. See
			<a href="https://github.com/jeka-kiselyov/mnemonad/blob/main/docs/caching.md" target="_blank" rel="noopener noreferrer">docs/caching.md</a>.
		</p>
		<div class="debug-panel__row debug-panel__row--rpc">
			<span class="debug-panel__label">RPC calls this session</span>
			<button
				type="button"
				class="debug-panel__count debug-panel__count--clickable"
				:disabled="rpcCallCount === 0"
				@click="rpcLogOpen = true"
			>{{ rpcCallCount }}</button>
		</div>
		<p class="debug-panel__hint">
			Every logical <code>readContract</code>/<code>writeContract</code>/etc. call any
			<code>Mnemonad</code> instance in this app makes, counted once regardless of
			transport-level batching or rate-limiter retries — so a cache hit or a batched
			<code>getItemRefsBatch</code> read shows up as fewer calls, not more. Click the
			number for the full list.
		</p>
		<RpcCallLogDialog v-model="rpcLogOpen" />
		<div class="debug-panel__row debug-panel__row--rpc">
			<span class="debug-panel__label">Sign server (IPFS)</span>
			<span class="debug-panel__status" :class="`debug-panel__status--${signServerStatus}`">
				<span class="debug-panel__status-dot" />{{ signServerStatusLabel }}
			</span>
		</div>
		<p class="debug-panel__hint">
			Polls the sign server's own <code>GET /health</code> every 10s (chain reachable,
			gateway resolved — see <code>presign-server/src/routes/meta.js</code>), not just
			whether it answers at all.
			<template v-if="signServerError"> Last error: <code>{{ signServerError }}</code>.</template>
		</p>
		</div>
	</JPanel>
</template>

<script>
import { mapStores } from 'pinia';
import { JPanel } from 'themed_varmory';
import { getRpcCallCount, subscribeRpcCalls } from '@mnemonad';
import { useDebugStore } from '../stores/debug.js';
import { presignConfigured, fetchPresignHealth } from './presignProvider.js';
import RpcCallLogDialog from './RpcCallLogDialog.vue';

/** How often to re-poll the sign server's `/health` while this panel is mounted. */
const SIGN_SERVER_POLL_MS = 10_000;

/**
 * Session-only debug controls. Deliberately its own small component rather than folded into
 * VectorSummary — this isn't information about the vector, it's a knob affecting the whole
 * app's SDK behavior, so it gets its own panel rather than blurring into vector info.
 */
export default {
	name: 'DebugPanel',
	components: { JPanel, RpcCallLogDialog },
	data() {
		return {
			// Local component state, not store state: this mirrors a process-wide SDK counter
			// (MnemonadRpcRecorder) that every `Mnemonad` instance in the app writes into
			// regardless of which page/action created it — there's nothing for a Pinia store
			// to own here beyond what this one subscription already gives the panel.
			rpcCallCount: getRpcCallCount(),
			// Not `_unsubscribeRpc` — Vue 3's public-instance proxy deliberately skips
			// underscore/`$`-prefixed data keys (they're reserved for internals), so a
			// leading underscore here would silently fail to expose it on `this`.
			unsubscribeRpc: null,
			rpcLogOpen: false,
			// 'checking' | 'healthy' | 'degraded' | 'unreachable' | 'unconfigured'
			signServerStatus: presignConfigured ? 'checking' : 'unconfigured',
			signServerError: null,
			signServerTimer: null,
		};
	},
	computed: {
		...mapStores(useDebugStore),
		signServerStatusLabel() {
			return {
				checking: 'Checking…',
				healthy: 'Healthy',
				degraded: 'Degraded',
				unreachable: 'Unreachable',
				unconfigured: 'Not configured',
			}[this.signServerStatus];
		},
	},
	mounted() {
		this.unsubscribeRpc = subscribeRpcCalls(({ count }) => {
			this.rpcCallCount = count;
		});

		if (presignConfigured) {
			this.checkSignServerHealth();
			this.signServerTimer = setInterval(() => this.checkSignServerHealth(), SIGN_SERVER_POLL_MS);
		}
	},
	beforeUnmount() {
		this.unsubscribeRpc?.();
		clearInterval(this.signServerTimer);
	},
	methods: {
		async checkSignServerHealth() {
			try {
				const health = await fetchPresignHealth();
				// The server's own verdict, not a re-derivation of it from the HTTP status —
				// see fetchPresignHealth's own comment for why 503 still resolves here rather
				// than throwing.
				this.signServerStatus = health.status === 'ok' ? 'healthy' : 'degraded';
				this.signServerError = health.status === 'ok' ? null : health.error || null;
			} catch (e) {
				this.signServerStatus = 'unreachable';
				this.signServerError = e.message;
			}
		},
	},
};
</script>

<style scoped>
.debug-panel {
	font-size: 13px;
}

.debug-panel__row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.debug-panel__label {
	color: var(--q-text, #c8d6e5);
}

.debug-panel__row--rpc {
	margin-top: 12px;
}

.debug-panel__count {
	font-family: var(--font-mono, monospace);
	font-variant-numeric: tabular-nums;
	color: var(--q-text, #c8d6e5);
}

.debug-panel__count--clickable {
	background: none;
	border: none;
	padding: 0;
	font-size: inherit;
	cursor: pointer;
	text-decoration: underline dotted;
	text-underline-offset: 2px;
}

.debug-panel__count--clickable:disabled {
	cursor: default;
	text-decoration: none;
	opacity: 0.7;
}

.debug-panel__count--clickable:hover:not(:disabled) {
	color: var(--q-primary, #8a7cff);
}

.debug-panel__status {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: var(--q-text, #c8d6e5);
}

.debug-panel__status-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: currentColor;
	flex-shrink: 0;
}

.debug-panel__status--healthy { color: #21ba45; }
.debug-panel__status--degraded { color: #f2c037; }
.debug-panel__status--unreachable { color: #c10015; }
.debug-panel__status--checking,
.debug-panel__status--unconfigured { color: var(--q-text-muted, #8a94a6); }

.debug-panel__hint {
	margin: 8px 0 0;
	font-size: 12px;
	line-height: 1.5;
	color: var(--q-text-muted, #8a94a6);
}

.debug-panel__hint code {
	font-family: var(--font-mono, monospace);
	opacity: 0.9;
}

.debug-panel__hint a {
	color: inherit;
	text-decoration: underline;
}

body.body--light .debug-panel__label,
body.body--light .debug-panel__count {
	color: #2a2440;
}
</style>
