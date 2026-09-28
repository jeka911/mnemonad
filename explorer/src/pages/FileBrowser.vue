<template>
	<div>
		<GradientPanel always-expanded dense variant="corner">
			<!-- The panel's own `title` prop can't hold this, so the header's default slot
			     takes over rendering it: back control, then what this page actually is —
			     one named stream, read as a filesystem. Every `.stop` is because the header
			     row owns a click handler of its own (a no-op while always-expanded, but not
			     something to navigate or open a new tab through). -->
			<template #default>
				<div class="panel-head">
					<router-link
						to="/select"
						class="panel-head__back"
						title="Back to streams"
						aria-label="Back to streams"
						draggable="false"
						@click.stop
					>
						<q-icon name="arrow_back" size="16px" />
					</router-link>
					<span class="panel-head__title">
						<strong>Stream</strong>
						<!-- The id itself is the link out: it's the one token of this header
						     a reader would want to follow or copy. -->
						<ExplorerLink
							v-if="validId"
							type="token"
							:value="String(streamId)"
							:contract-address="mnemonadStore.contractAddress"
							:chain="activeNetwork.chain"
							class="panel-head__id"
							:title="String(streamId)"
							draggable="false"
							@click.stop
						>
							{{ formattedId }}
						</ExplorerLink>
						<!-- Nothing to link to for a param that isn't an id: show it as-is, so
						     the header still says which URL the "not a valid stream id" body
						     below is talking about. -->
						<span v-else class="panel-head__id">{{ formattedId }}</span>
						<span class="panel-head__note">
							as a filesystem<template v-if="versionCount !== null"> • {{ versionCount }} {{ versionLabel }}</template>
						</span>
					</span>
					<!-- Same destination as the raw on-chain view this page links out to
					     everywhere else: the items behind the files. -->
					<GradientButton
						v-if="browserReady"
						class="head-btn"
						label="Details"
						icon="bug_report"
						size="sm"
						@click.stop="$router.push(streamPath(streamId))"
					/>
					<GradientButton
						v-if="browserReady"
						class="head-btn"
						label="Clone"
						icon="terminal"
						size="sm"
						@click.stop="cloneDialog = true"
					/>
					<!-- Renders nothing unless this stream carries a search_index.db. -->
					<StreamSearchBox
						v-if="browserReady"
						:folder="searchFolder"
						@reveal="onSearchReveal"
					/>
				</div>
			</template>

			<template #actions>
				<GradientButton
					v-if="browserReady"
					class="head-btn"
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
				<div v-if="!mnemonadStore.isDeployed && !switchingNetwork" class="state">
					<p>Mnemonad isn't deployed on {{ activeNetwork.label }}.</p>
				</div>
				<div v-else-if="switchingNetwork" class="state">
					<q-spinner color="primary" size="28px" />
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
					@folder="onFolder"
				/>
			</template>
		</GradientPanel>

		<CloneStreamDialog
			v-if="validId"
			v-model="cloneDialog"
			:stream-id="streamId"
			:network-id="activeNetwork.id"
			:encrypted="cloneEncrypted"
			:kek-method="cloneKekMethod"
		/>

		<UnlockStreamDialog
			v-model="unlockDialog"
			:stream="_stream"
			purpose="browse its files"
			@unlocked="onUnlocked"
		/>
	</div>
</template>

<script>
import { shallowRef } from 'vue';
import { mapStores } from 'pinia';
import { getActiveNetwork } from '../settings.js';
import { useMnemonadStore } from '../stores/mnemonad.js';
import { methodOf, isEncrypted } from '../mnemonad/kek.js';
import { formatStreamId } from '../includes/formatStreamId.js';
import { parseStreamRouteId, streamPath, syncStreamRouteNetwork } from '../includes/streamRoute.js';
import GradientPanel from '../components/GradientPanel.vue';
import GradientButton from '../components/GradientButton.vue';
import ExplorerLink from '../mnemonad/ExplorerLink.vue';
import CloneStreamDialog from '../mnemonad/CloneStreamDialog.vue';
import UnlockStreamDialog from '../mnemonad/UnlockStreamDialog.vue';
import StreamSearchBox from '../mnemonad/StreamSearchBox.vue';
import FileManagerBrowserSync from '../components/filemanager/FileManagerBrowserSync.vue';

export default {
	name: 'FileBrowser',
	// Static route metadata read by pages/index.js to self-register this page. Deliberately
	// a separate page from Stream.vue rather than a tab folded into it — see the session's
	// own plan notes for why (keeps Stream.vue untouched for this pass).
	path: '/stream/:id/files',
	title: 'File Browser',
	components: {
		GradientPanel, GradientButton, ExplorerLink, FileManagerBrowserSync, CloneStreamDialog,
		UnlockStreamDialog, StreamSearchBox,
	},
	data() {
		return {
			activeNetwork: getActiveNetwork(),
			loading: false,
			error: null,

			unlockDialog: false,
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

			// The header's version count. A reactive mirror of `_stream.length` for the same
			// reason `unlocked` mirrors the key: `_stream` is deliberately non-reactive, so a
			// template reading its `length` directly would render once and never update. Null
			// until the stream is loaded, so the header says nothing rather than "0 versions"
			// about a stream it hasn't read yet. Re-read after every sync (see onSyncState) —
			// a push appends items, and this is the one number on the page that changes.
			versionCount: null,

			cloneDialog: false,

			// The file browser's current root folder, for the header's search box — handed up
			// by FileManagerBrowserSync's `@folder` on load and after every live poll. A shallowRef
			// (same as FileManagerBrowser's own currentFolder1/2): the assignment is what needs to
			// be reactive, not the decrypted tree inside it.
			searchFolder: shallowRef(null),
		};
	},
	computed: {
		...mapStores(useMnemonadStore),
		// Gated on `cloneDialog` rather than reading `_stream` (deliberately non-reactive,
		// see created()) unconditionally — only read at the one moment its answer is needed,
		// off a flag that's guaranteed to flip when it is. Same trick
		// UnlockStreamDialog.vue's own `kekMethod` uses, gated on its `modelValue` instead.
		cloneEncrypted: function() {
			if (!this.cloneDialog) return false;
			return isEncrypted(this._stream);
		},
		cloneKekMethod: function() {
			if (!this.cloneDialog) return null;
			return methodOf(this._stream);
		},
		// `{networkId, id}` for the `<network>-0x…` param this page's URL carries, or null
		// when it isn't a stream id at all. The network half is acted on in load() — see
		// syncStreamRouteNetwork — not here.
		routeStream: function() {
			return parseStreamRouteId(this.$route.params.id);
		},
		validId: function() {
			return !!this.routeStream;
		},
		streamId: function() {
			return this.routeStream?.id ?? null;
		},
		// True while the URL names a specific network other than the one the app booted on —
		// see Stream.vue's own copy of this computed for the full reasoning.
		switchingNetwork: function() {
			return !!(this.routeStream?.networkId && this.routeStream.networkId !== this.activeNetwork.id);
		},
		// Guarded on `validId` because the route param reaches here unvalidated: the invalid-id
		// branch renders the header too, and the raw param is all there is to show for it.
		formattedId: function() {
			return this.validId ? formatStreamId(this.streamId) : String(this.$route.params.id);
		},
		// Every item in a filesystem stream is a patch, so the count is a version history —
		// the same word StreamRow is told to use for both lists on /select.
		versionLabel: function() {
			return this.versionCount === 1 ? 'version' : 'versions';
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
		// Exposed for the template: an Options-API render function can't see module imports.
		streamPath,
		async load() {
			if (!this.validId) return;
			// The URL names a network as well as a stream. If it disagrees with the app's,
			// this rewrites or reloads and the page renders again against the corrected URL —
			// nothing to load in this pass. Checked before isDeployed: the network the app
			// happens to be on might have no contract at all, which must not block switching
			// to the one the URL actually asks for.
			if (syncStreamRouteNetwork(this.$route, this.$router, this.routeStream)) return;
			if (!this.mnemonadStore.isDeployed) return;
			this.loading = true;
			this.error = null;
			try {
				const id = this.streamId;
				// Same store action Stream.vue calls — a stream already open there (or in
				// another FileBrowser tab) costs zero extra RPC here.
				const { stream: v } = await this.mnemonadStore.loadStream(id);
				this._stream = v;
				this.unlocked = !!v.crypto.getAesKey();
				this.versionCount = v.length;
				// A route change to a different id destroys/recreates FileManagerBrowserSync
				// (it's gated by v-else-if in the same chain as _stream) — reset rather than
				// wait for its first @sync-state, so a stale count from the previous stream
				// never lingers on the button for that one render.
				this.pendingChangesCount = 0;
				this.isSyncing = false;
				this.searchFolder = null;
			} catch (e) {
				this.error = e?.shortMessage || e?.message || 'Failed to load stream';
				this._stream = null;
				this.versionCount = null;
			} finally {
				this.loading = false;
			}
		},
		openUnlock() {
			this.unlockDialog = true;
		},
		onUnlocked() {
			this.unlocked = true;
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
			// A sync appends items to the live instance, so the header's count is stale the
			// moment one lands. This event fires on either side of a push (pending → 0,
			// isSaving → false), which is exactly when to re-read it — free, it's a field
			// on an object already in hand.
			if (this._stream) this.versionCount = this._stream.length;
		},
		/** The "Sync to chain" button — flushes pending changes via the same path the
		 * file manager's own upload chip uses. A failure surfaces through the existing
		 * @error handler (onSyncError) below, since FileManagerBrowserSync.push() emits
		 * it itself; nothing extra to catch here. */
		async syncNow() {
			await this.$refs.sync?.syncNow();
		},
		onFolder(folder) {
			this.searchFolder = folder;
		},
		async onSearchReveal({ path, selection }) {
			const shown = await this.$refs.sync?.revealPath(path, selection);
			if (!shown) {
				this.$q.notify({ type: 'warning', message: `${path} isn't in this folder anymore.`, position: 'top' });
			}
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
				this.$router.replace(streamPath(this.streamId));
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
/* Strictly one line: the panel's dense header is a fixed 40px row with `overflow: hidden`,
   so a second line isn't shortened, it's cut off mid-glyph (seen live at 375px before this
   was pinned to nowrap). Everything here either fits, ellipsises, or drops out at a
   breakpoint below. */
.panel-head {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: nowrap;
	min-width: 0;
	/* The row gets whatever width the actions column leaves it and no more, so without this
	   its contents simply draw over that column (seen live at 375px). Clipped here, then
	   ellipsised below, so a squeezed header degrades instead of colliding. */
	overflow: hidden;
	/* Chrome/label, not text: the header is a control strip, and a drag across it that leaves
	   half a sentence highlighted is never what the drag was for. */
	-webkit-user-select: none;
	user-select: none;
}

/* Both links in here (back, and the id) are anchors, which browsers make draggable by
   default — grabbing the id would peel a link ghost off the header. The CSS covers
   Chrome/Safari; the `draggable="false"` attribute in the template is what Firefox reads. */
.panel-head a {
	-webkit-user-drag: none;
}

.panel-head__title {
	display: inline-flex;
	align-items: center;
	flex-wrap: nowrap;
	gap: 6px;
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
}

/* The id keeps the monospace it has everywhere else — it's a hash, and it reads as one. */
.panel-head__id {
	font-family: var(--font-mono, monospace);
	font-size: 1em;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

/* The prose around the id is context, not the label: it recedes so the id stays the thing
   the eye lands on, and it's the one part allowed to shrink. */
.panel-head__note {
	color: var(--q-text-muted, #8a94a6);
	font-weight: 400;
	/* Gives way well before the id does when the row is squeezed (the search box takes
	   room here too) — it's the least important text in the row. */
	flex-shrink: 20;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.panel-head :deep(.gradient-btn) {
	flex: 0 0 auto;
}

/* The actions column sits outside .panel-head but is the same strip to a reader — its labels
   shouldn't highlight either. */
.head-btn {
	-webkit-user-select: none;
	user-select: none;
}

/* Below this the row is competing with the actions column for a 375px-wide line. The prose
   is what goes: the id identifies the stream, the button acts on it, and "as a filesystem"
   is the one part the page itself already demonstrates. */
@media (max-width: 720px) {
	.panel-head__note {
		display: none;
	}

	/* Every header button drops to its icon — both the one in the title row and the actions
	   column opposite it, which is what was leaving the id about 18px to render in. Neither
	   button goes away: this row is the only route to the on-chain view and the only way to
	   push pending changes. Direct child only: the icon is an <i> holding a <span> of its own
	   (the material-icons ligature), and a descendant selector blanks the button entirely. */
	.head-btn :deep(.gradient-btn__content > span) {
		display: none;
	}
}

/* Narrower still, the word "Stream" goes too — the id is unmistakably a stream id. */
@media (max-width: 480px) {
	.panel-head__title strong {
		display: none;
	}
}

/* Sized to the title's own line rather than to a button: this sits inside the header, so
   anything with real padding would push the row taller than every other panel's. */
.panel-head__back {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	flex: 0 0 auto;
	border-radius: 6px;
	color: var(--q-text-muted, #8a94a6);
	text-decoration: none;
	background: rgba(140, 120, 200, 0.1);
	border: 1px solid rgba(140, 120, 200, 0.18);
	transition: color var(--q-transition-fast, 0.15s), background var(--q-transition-fast, 0.15s);
}

.panel-head__back:hover {
	color: var(--q-text-bright, #ffffff);
	background: rgba(140, 120, 200, 0.2);
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

body.body--light .panel-head__back {
	background: rgba(60, 40, 110, 0.06);
	border-color: rgba(60, 40, 110, 0.14);
}

body.body--light .panel-head__back:hover {
	color: #2a2440;
	background: rgba(60, 40, 110, 0.12);
}
</style>
