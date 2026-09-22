<template>
	<div>

		<GradientPanel always-expanded dense variant="corner" title="File browser">
			<template #actions>
				<GradientButton
					v-if="browserReady"
					label="Stream on-chain details"
					icon="bug_report"
					size="sm"
					@click="$router.push(`/stream/${$route.params.id}`)"
				/>
				<GradientButton
					v-if="browserReady"
					label="Sync to chain"
					loading-label="Syncing..."
					icon="cloud_upload"
					size="sm"
					:loading="isSyncing"
					:disable="!pendingChangesCount"
					@click="syncNow"
				/>
			</template>
			<template #body>
				<div v-if="!mnemonadStore.isDeployed" class="state">
					<p>Mnemonad isn't deployed on {{ activeNetwork.label }}.</p>
				</div>
				<div v-else-if="!validId" class="state">
					<p>Not a valid stream id.</p>
				</div>
				<div v-else-if="loading" class="state">
					<q-spinner color="primary" size="28px" />
				</div>
				<div v-else-if="error" class="state">
					<p>{{ error }}</p>
					<GradientButton label="Retry" size="sm" @click="load" />
				</div>
				<FileManagerBrowserSync
					v-else-if="_stream"
					ref="sync"
					:stream="_stream"
					:unlocked="unlocked"
					height="70vh"
					@unlock-requested="openUnlock"
					@streamInfo="onStreamInfo"
					@error="onSyncError"
					@sync-state="onSyncState"
				/>
			</template>
		</GradientPanel>

		<q-dialog v-model="unlockDialog">
			<JPanel accent="header" icon="lock" iconColor="var(--q-primary)" title="Unlock stream" style="min-width: 360px;">
				<div class="unlock-content q-pa-md">
					<template v-if="kekMethod === 'password'">
						<p class="unlock-hint">
							Enter the password this stream was encrypted with to browse its files.
						</p>
						<q-input
							v-model="unlockPassword"
							label="Password"
							type="password"
							dense
							outlined
							autofocus
							:disable="unlocking"
							:error="!!unlockError"
							:error-message="unlockError"
							@keyup.enter="submitUnlock"
						/>
					</template>
					<template v-else>
						<p class="unlock-hint">
							This stream is encrypted to its owner's wallet. Sign the prompt to
							derive its key — the signature never leaves your browser, and costs
							nothing.
						</p>
						<p v-if="unlockError" class="unlock-error">{{ unlockError }}</p>
					</template>
					<GradientButton
						:label="kekMethod === 'password' ? 'Unlock' : 'Unlock with wallet'"
						loading-label="Unlocking..."
						:loading="unlocking"
						@click="submitUnlock"
					/>
				</div>

				<template #header-action>
					<q-btn flat round icon="close" size="sm" v-close-popup />
				</template>
			</JPanel>
		</q-dialog>
	</div>
</template>

<script>
import { mapStores } from 'pinia';
import { getActiveNetwork } from '../settings.js';
import { useWalletStore } from '../stores/wallet.js';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { methodOf } from '../mnemonad/kek.js';
import { JPanel } from 'themed_varmory';
import GradientPanel from '../components/GradientPanel.vue';
import GradientButton from '../components/GradientButton.vue';
import FileManagerBrowserSync from '../components/filemanager/FileManagerBrowserSync.vue';

export default {
	name: 'FileBrowser',
	// Static route metadata read by pages/index.js to self-register this page. Deliberately
	// a separate page from Stream.vue rather than a tab folded into it — see the session's
	// own plan notes for why (keeps Stream.vue untouched for this pass).
	path: '/stream/:id/files',
	title: 'File Browser',
	components: {
		JPanel, GradientPanel, GradientButton, FileManagerBrowserSync,
	},
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			loading: false,
			error: null,

			unlockDialog: false,
			unlockPassword: '',
			unlockError: null,
			unlocking: false,
			// Same reasoning as Stream.vue's own `unlocked`: `_stream` is deliberately
			// non-reactive (see created() below), so FileManagerBrowserSync's `unlocked`
			// prop needs an actual reactive value to depend on.
			unlocked: false,

			// Mirrors FileManagerBrowserSync's own `pendingChangesCount`/`isSaving` — kept
			// as real data() here (updated via its `@sync-state` event, see onSyncState)
			// rather than read live off `this.$refs.sync`: a parent computed reading through
			// a template ref never picks up a later change on the child, since `$refs` isn't
			// part of Vue's reactive-dependency graph the way a `data()` field is (confirmed
			// live — this button stayed stuck at "0 pending" through an actual file add
			// before this fix). An explicit event the child fires on every real change is
			// the reliable way to keep this in sync.
			pendingChangesCount: 0,
			isSyncing: false,
		};
	},
	computed: {
		...mapStores(useWalletStore, useMnemonadStore),
		// Which credential the unlock dialog should ask for — 'password' or 'signature'.
		// Hung off `unlockDialog` (and `unlocked`) rather than `_stream`, which is
		// deliberately non-reactive (see created()): those are the reactive flags that flip
		// exactly when this answer is needed — when the dialog opens, and after it succeeds.
		kekMethod: function() {
			if (!this.unlockDialog && !this.unlocked) return null;
			return methodOf(this._stream);
		},
		validId: function() {
			try {
				BigInt(this.$route.params.id);
				return true;
			} catch {
				return false;
			}
		},
		// Mirrors the #body slot's own `v-else-if="_stream"` branch, but expressed only in
		// terms of reactive data (`loading`/`error`, `mnemonadStore.isDeployed`, `validId`)
		// — never `_stream` itself. `_stream` is deliberately non-reactive (see created()'s
		// own doc), which is fine for the #body slot's `v-if`/`v-else-if` chain (it's forced
		// to re-evaluate anyway whenever `loading`/`error` change, so it happens to read the
		// current `_stream` value each time) but breaks silently for a slot whose *only*
		// condition is `_stream` alone: Vue's compiler sees no reactive dependency in that
		// slot at all and caches its first (pre-load, always-false) render forever — exactly
		// what made the "Sync to chain" button never appear. This computed exists so the
		// #actions slot has a real reactive dependency to key off instead.
		browserReady: function() {
			return this.mnemonadStore.isDeployed && this.validId && !this.loading && !this.error;
		},
	},
	created() {
		// Kept off `data()` deliberately — same reasoning as Stream.vue's own `_stream`: a
		// live SDK instance holding viem clients has no business in reactive state.
		this._stream = null;
	},
	mounted() {
		this.load();
	},
	watch: {
		'$route.params.id': function() {
			this.load();
		},
	},
	methods: {
		async load() {
			if (!this.mnemonadStore.isDeployed || !this.validId) return;
			this.loading = true;
			this.error = null;
			try {
				const id = BigInt(this.$route.params.id);
				// Same store action Stream.vue calls — a stream already open there (or in
				// another FileBrowser tab) costs zero extra RPC here.
				const { stream: v } = await this.mnemonadStore.loadStream(id);
				this._stream = v;
				this.unlocked = !!v.crypto.getAesKey();
				// A route change to a different id destroys/recreates FileManagerBrowserSync
				// (it's gated by v-else-if in the same chain as _stream) — reset rather than
				// wait for its first @sync-state, so a stale count from the previous stream
				// never lingers on the button for that one render.
				this.pendingChangesCount = 0;
				this.isSyncing = false;
			} catch (e) {
				this.error = e?.shortMessage || e?.message || 'Failed to load stream';
				this._stream = null;
			} finally {
				this.loading = false;
			}
		},
		openUnlock() {
			this.unlockDialog = true;
			this.unlockPassword = '';
			this.unlockError = null;
		},
		async submitUnlock() {
			// Never gated on `streamMeta.kek` existing — see Stream.vue's own copy for why
			// (a stream encrypted before the method marker existed publishes no block).
			if (this.unlocking || !this._stream) return;
			if (this.kekMethod === 'password' && !this.unlockPassword) {
				this.unlockError = 'Password is required.';
				return;
			}
			this.unlocking = true;
			this.unlockError = null;
			try {
				if (this.kekMethod === 'password') {
					await this._stream.unlockWithPassword(this.unlockPassword);
				} else {
					await this.mnemonadStore.unlockStreamWithWallet(
						this._stream.id,
						this.walletStore.address
					);
				}
				this.unlocked = true;
				this.unlockDialog = false;
			} catch (error) {
				this.unlockError = this.kekMethod === 'password'
					? 'Incorrect password.'
					: (error?.message || 'Could not unlock with this wallet.');
			} finally {
				this.unlocking = false;
			}
		},
		onStreamInfo(info) {
			this.$q.notify({
				type: 'info',
				message: `${info?.patchCount ?? 0} version(s), ${info?.totalBytes ?? 0} bytes on-chain`,
				position: 'top',
			});
		},
		onSyncState({ pendingChangesCount, isSaving }) {
			this.pendingChangesCount = pendingChangesCount;
			this.isSyncing = isSaving;
		},
		/** The "Sync to chain" button — flushes pending changes via the same path the
		 * file manager's own upload chip uses. A failure surfaces through the existing
		 * @error handler (onSyncError) below, since FileManagerBrowserSync.push() emits
		 * it itself; nothing extra to catch here. */
		async syncNow() {
			await this.$refs.sync?.syncNow();
		},
		onSyncError(err) {
			const message = err?.shortMessage || err?.message || '';
			// MonadSync.restore()/_replayRange() throw this exact substring when an item's
			// bytes don't decode as a DoubleSync patch/diff-patch at all — i.e. this stream
			// was never pushed to through the file browser (a plain AddPanel upload, most
			// likely), not a corrupt-but-genuine file-browser stream (that's the "chain ends
			// in corrupt state" message instead, which stays here — it's this page's own
			// problem to show/fix, not a sign of the wrong page). Redirecting straight to
			// the stream's own debug page is more useful than an error the user would just
			// click "Debug Stream" on anyway.
			if (message.includes('unknown patch type')) {
				this.$q.notify({
					type: 'info',
					message: "There's no Mnemonad filesystem detected in this stream — showing its raw details instead.",
					position: 'top',
				});
				this.$router.replace(`/stream/${this.$route.params.id}`);
				return;
			}
			this.$q.notify({
				type: 'negative',
				message: message || 'File browser error',
				position: 'top',
			});
		},
	},
};
</script>

<style scoped>
/* The wallet branch of the unlock dialog has no q-input to carry an :error-message, so the
   failure renders as its own line instead. */
.unlock-error {
	margin: 0;
	font-size: 12px;
	color: var(--q-negative);
}

.back-link {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 12px;
	color: var(--q-text-muted, #8a94a6);
	text-decoration: none;
	font-size: 0.9em;
	transition: color var(--q-transition-fast, 0.15s);
}

.back-link:hover {
	color: var(--q-text-bright, #ffffff);
}

.state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	padding: 24px 0;
	text-align: center;
	color: var(--q-text-muted, #8a94a6);
}

body.body--light .back-link:hover {
	color: #2a2440;
}
</style>
