<template>
    <FileManagerBrowser
        v-if="rootFolder"
        ref="browser"
        :rootFolder="rootFolder"
        :readOnly="readOnly"
        :height="height"
        :rowHeight="rowHeight"
        :primaryColor="primaryColor"
        :isPolling="isPolling"
        @change="onChanged"
        @close="$emit('close')"
        @streamInfo="$emit('streamInfo')"
        @togglePolling="onTogglePolling"
    />
    <div v-else class="fileManagerBrowserSyncLoading">
        <!-- load failed: surface the error instead of an endless spinner -->
        <div v-if="status === 'error'" class="fileManagerBrowserSyncError">
            <div class="fileManagerBrowserSyncErrorTitle">Couldn't load this stream</div>
            <div v-if="loadError" class="fileManagerBrowserSyncErrorMsg">{{ loadError }}</div>
            <button class="fileManagerBrowserSyncRetry" @click="initialize">Retry</button>
            <button class="fileManagerBrowserSyncDebug" @click="debugStream">Debug Stream</button>
        </div>
        <template v-else>
            <Spinner :size="36" />
            <div v-if="status === 'locked'" class="fileManagerBrowserSyncHintWrapper">
                <span class="fileManagerBrowserSyncHint">This stream is encrypted.</span>
                <button class="fileManagerBrowserSyncRetry" @click="$emit('unlock-requested')">Unlock</button>
            </div>
        </template>
    </div>
</template>

<script>
import { markRaw } from 'vue';
import { mapStores } from 'pinia';
import { getPublicClient, getWalletClient } from '@wagmi/core';
import Mnemonad from '@mnemonad';
import MonadSync from '@monadsync';
import { config } from '../../wagmi';
import { useWalletStore } from '../../stores/wallet.js';
import { useMnemonadStore, MAX_RPC_REQUESTS_PER_SECOND, RPC_RETRY } from '../../stores/mnemonad.js';
import { useDebugStore } from '../../stores/debug.js';
import { createPresignProvider } from '../../mnemonad/presignProvider.js';
import { streamPath } from '../../includes/streamRoute.js';
import FileManagerBrowser from './FileManagerBrowser.vue';
import FileManagerDoubleSyncFolder from './includes/FileManagerDoubleSyncFolder.js';
import Spinner from './helpers/Spinner.vue';

export default {
    name: 'FileManagerBrowserSync',
    components: {
        FileManagerBrowser,
        Spinner,
    },
    props: {
        // Live Mnemonad instance for this stream — from mnemonadStore.loadStream(), same
        // cached instance every other consumer (Stream.vue, AddPanel.vue) gets for this id.
        // This component never constructs one itself.
        stream: {
            type: Object,
            required: true,
        },
        // Mirrors AddPanel.vue's own `unlocked` prop: the page holding this component owns
        // the unlock dialog and the reactive flag; this component only reacts to it.
        unlocked: {
            type: Boolean,
            required: false,
            default: false,
        },
        height: {
            type: String,
            required: false,
            default: '600px',
        },
        rowHeight: {
            type: String,
            required: false,
            default: '200px',
        },
        primaryColor: {
            type: String,
            required: false,
            default: 'var(--q-primary)',
        },
    },
    emits: ['ready', 'pushed', 'error', 'close', 'change', 'unlock-requested', 'streamInfo', 'sync-state', 'folder'],
    data() {
        return {
            rootFolder: null,
            isSaving: false,
            status: 'loading',
            isPolling: false,
            loadError: null,
            // Mirrors `this._rawFolder.pendingChanges.pendingCount` — kept as its own
            // reactive field (updated via that plain event emitter, in _watchPendingChanges
            // below) rather than read live off the folder instance itself, same reasoning
            // FileManagerTopLeftMenu.vue's own `pendingChangesCount` already documents:
            // a page reading this via $refs needs an actual Vue-reactive value to depend
            // on, not a class instance's own getter it can't see mutate.
            pendingChangesCount: 0,
            // Whether the connected wallet is actually allowed to write to this stream —
            // see checkCanWrite()/getWritable() below, same split AddPanel.vue uses (a
            // synchronous "is a walletClient attached at all" check is not the same
            // question as "can *this* stream's owner/writer-list actually accept a push
            // from *this* address").
            canWrite: false,
            // The writable Mnemonad instance push()/getWritable() use — built lazily, once,
            // the first time a write is actually needed. `stream` (the prop) is deliberately
            // read-only: mnemonadStore.loadStream() never attaches a walletClient to it
            // (see that store's own doc), so relying on it here would make every write path
            // permanently "not writable" regardless of who's connected. A live SDK instance
            // holding viem clients has no business in reactive state, hence markRaw() below
            // — same reasoning AddPanel.vue's own `writable` field documents.
            writable: null,
        };
    },
    computed: {
        ...mapStores(useWalletStore, useMnemonadStore, useDebugStore),
        // Passed as every Mnemonad's `cache` param below — see AddPanel.vue's own doc on
        // why `false`/`undefined`, never a plain negation, is what the constructor wants.
        cacheParam() {
            return this.debugStore.cachingDisabled ? false : undefined;
        },
        readOnly() {
            return !this.walletStore.isConnected || !this.canWrite;
        },
    },
    methods: {
        /**
         * Same reasoning and shape as AddPanel.vue's own getWritable(): a separate,
         * lazily-built, walletClient-carrying Mnemonad instance for this exact stream id,
         * cached on `this.writable` rather than rebuilt on every push. Carries the
         * already-unwrapped key too (if unlocked), so a push to an encrypted stream still
         * encrypts without re-prompting for the password.
         * @returns {Promise<Mnemonad>}
         */
        async getWritable() {
            if (this.writable) return this.writable;
            const publicClient = getPublicClient(config);
            const walletClient = await getWalletClient(config);
            const instance = new Mnemonad({
                publicClient,
                walletClient,
                contractAddress: this.mnemonadStore.contractAddress,
                id: this.stream.id,
                maxRPCRequestsPerSecond: MAX_RPC_REQUESTS_PER_SECOND,
                rpcRetry: RPC_RETRY,
                offloadingProvider: createPresignProvider({ account: this.walletStore.address }),
                cache: this.cacheParam,
                debug: true,
                aesKey: this.stream?.crypto?.getAesKey() || undefined,
            });
            this.writable = markRaw(instance);
            return this.writable;
        },
        async checkCanWrite() {
            if (!this.walletStore.isConnected || !this.stream) {
                this.canWrite = false;
                return;
            }
            try {
                this.canWrite = await this.mnemonadStore.checkCanWrite(this.stream.id, this.walletStore.address);
            } catch {
                this.canWrite = false;
            }
        },
        async initialize() {
            this.loadError = null;
            this.status = 'loading';
            try {
                await this.stream.initialize();
                this.checkCanWrite();

                // Construction only (no chain I/O — see MonadSync's own initialize() for
                // what actually reads/replays) — kept as one instance per
                // FileManagerBrowserSync so a later push()/poll reuses the CDC state
                // instead of replaying the whole chain again. Always built around the
                // read-only `stream` prop here, regardless of wallet connection — a real
                // walletClient is fetched lazily, only right before an actual push (see
                // push()'s own doc): doing it this early, during initial mount or right as
                // a wallet connects, raced wagmi's own connection bookkeeping on some page
                // loads ("connection.connector.getChainId is not a function", confirmed
                // live). Every read operation (initialize/restore/at) works identically on
                // a read-only instance; only push() itself needs write capability, and it
                // swaps `_mn` in for itself when that moment actually comes.
                //
                // Built unconditionally, *before* the lock check below can return early —
                // _continueWithSync() (reached either right below, or later via the
                // `unlocked` watcher once a credential shows up) assumes it already exists.
                if (!this._monadSync) {
                    this._monadSync = new MonadSync({ mnemonad: this.stream });
                }

                // `this.stream.encKeyWrapped` is already populated by `stream.initialize()`
                // above — no need to touch MonadSync to know this.
                const isEncrypted = !!(this.stream.encKeyWrapped && this.stream.encKeyWrapped.length);
                if (isEncrypted && !this.unlocked) {
                    // Deliberately returns *before* `this._monadSync.initialize()` — that
                    // call replays every existing item through `_mn.at()`, and pre-unlock
                    // `crypto.isEnabled` is false, so `at()` skips decryption and hands back
                    // raw ciphertext. `DoubleSyncFormat.detect()` then rejects it as an
                    // unrecognized patch — the exact "unknown patch type" this locked branch
                    // exists to head off, previously thrown here before this check ever ran
                    // (confirmed live: reopening an encrypted filesystem stream without
                    // unlocking first redirected to the raw stream page with that error,
                    // even though the data on chain was perfectly good). See
                    // _continueWithSync() for the call that actually replays, once a
                    // credential is in hand.
                    this.status = 'locked';
                    this.$emit('ready', {
                        patchCount: this.stream.length,
                        totalBytes: this.stream.binaryLength,
                        isEncrypted: true,
                    });
                    return;
                }

                await this._continueWithSync();
            } catch (err) {
                console.error('[FileManagerBrowserSync] initialize failed:', err);
                this.loadError = this._errMessage(err);
                this.status = 'error';
                this.$emit('error', err);
            }
        },
        _errMessage(err) {
            if (!err) return 'Unknown error';
            return err.shortMessage || err.message || ('' + err);
        },
        /**
         * "Debug Stream" — an escape hatch for exactly the failure this error state
         * exists for (e.g. "MonadSync._replayRange: unknown patch type at index N"): the
         * stream itself is fine and readable, it just isn't (or isn't yet) valid
         * MonadSync-formatted data. Stream.vue's own debug page reads the raw chain state
         * directly — no DoubleSync parsing involved — so it's the natural place to point
         * someone who hits this.
         */
        debugStream() {
            this.$router.push(streamPath(this.stream.id));
        },
        async _continueWithSync() {
            const mn = this._monadSync._mn;
            // Populates `_monadSync`'s own CDC state (senderStore/lastSnapshot) by replaying
            // every existing item — safe to do here specifically because reaching this
            // method means the stream is either unencrypted or already unlocked (see
            // initialize()'s own doc on why this can't run any earlier). Needed for a later
            // push() to know whether to build a full snapshot or a diff; `restore()` right
            // below doesn't depend on it (it does its own independent read), but running
            // this first means a push right after opening a freshly-unlocked stream doesn't
            // redundantly replay the chain a second time.
            await this._monadSync.initialize();
            const memFolder = await this._monadSync.restore();
            const folder = FileManagerDoubleSyncFolder.fromMemoryFolder(memFolder);
            await folder.load();

            folder.on('save', () => this.push());
            this._watchPendingChanges(folder);

            this._rawFolder = folder;
            this.rootFolder = folder;
            this._knownLength = mn.length;
            this.status = 'ready';
            this.$emit('folder', folder);
            this.$emit('ready', {
                patchCount: mn.length,
                totalBytes: mn.binaryLength,
                isEncrypted: !!(mn.encKeyWrapped && mn.encKeyWrapped.length),
            });
        },
        /**
         * Keeps `this.pendingChangesCount` (a real Vue-reactive field) in sync with the
         * *whole tree's* pending changes, not just this one folder's own —
         * `folder.pendingChangesCount` is local to `folder` (same as
         * FileManagerTopLeftMenu.vue's own per-folder badge deliberately is), but "Sync to
         * chain" needs to know about a change anywhere underneath, since a push from the
         * root commits the whole tree regardless of how deep the edit happened. Subscribes
         * directly to `folder`'s own 'change' event (which `markChanged()` now bubbles up
         * from every descendant) rather than the narrower `pendingChanges` interface.
         */
        _watchPendingChanges(folder) {
            if (this._pendingChangesUnsub) this._pendingChangesUnsub();
            const onChange = () => {
                this.pendingChangesCount = folder.totalPendingChangesCount;
                this._emitSyncState();
            };
            folder.on('change', onChange);
            this._pendingChangesUnsub = () => folder.off('change', onChange);
            onChange();
        },
        /**
         * A page embedding this component (see FileBrowser.vue's "Sync to chain" button)
         * can't reliably read `this.pendingChangesCount`/`this.isSaving` off a template ref
         * reactively — `$refs` isn't part of Vue's fine-grained reactivity graph the way a
         * `data()` field is, so a parent computed reading through one only ever catches the
         * *first* value, never a later change (confirmed live: the exact bug this event
         * exists to avoid). Emitting the values explicitly, for the parent to store in its
         * own genuinely-reactive data, is the actually-reliable alternative.
         */
        _emitSyncState() {
            this.$emit('sync-state', { pendingChangesCount: this.pendingChangesCount, isSaving: this.isSaving });
        },
        /**
         * Public: flush pending changes now — the same call the "pending changes" chip in
         * FileManagerTopLeftMenu.vue makes when clicked. Exposed here too so a page embedding
         * this component (see FileBrowser.vue's "Sync to chain" button) doesn't need its own
         * copy of the folder reference to trigger it.
         * @returns {Promise<void>}
         */
        async syncNow() {
            if (!this._rawFolder || this.isSaving) return;
            await this._rawFolder.implementChanges();
        },
        /**
         * Public: navigate to the file at `path` ('a/b/c.txt', relative to the stream's root)
         * and open it in the text editor, optionally with `selection` ({start, end}, string
         * offsets into its decoded text) highlighted — what a stream-search hit does when
         * clicked (see StreamSearchBox.vue). Walks `_rawFolder`, not `rootFolder`: after a
         * live poll the browser is showing a newer tree than the one first mounted.
         * @returns {Promise<boolean>} false when the path doesn't resolve to a file.
         */
        async revealPath(path, selection = null) {
            if (!this._rawFolder || !this.$refs.browser) return false;
            const parts = path.split('/');
            const fileName = parts.pop();
            let folder = this._rawFolder;
            for (const part of parts) {
                const next = (await folder.list()).find((c) => c.name === part);
                if (!next || !next.isFolder) return false;
                folder = next;
            }
            const file = (await folder.list()).find((c) => c.name === fileName);
            if (!file || file.isFolder) return false;
            await this.$refs.browser.revealItem(folder, file, selection);
            return true;
        },
        async push() {
            if (this.isSaving || this.readOnly) return;
            this.isSaving = true;
            this._emitSyncState();
            this.status = 'syncing';
            try {
                // Swapped in now, not proactively in initialize() (see that method's own
                // doc) — getWritable() itself is cheap on repeat calls (cached on
                // `this.writable`, reset by the connectionId watcher on any account switch),
                // so this costs nothing once warm and always reflects whichever account is
                // currently connected.
                this._monadSync._mn = await this.getWritable();

                // Best-effort race guard, not an atomic one — same reasoning as the CLI's
                // own watch.js runPush(): the chain may have moved since this tab last knew
                // about it (another tab, the CLI, or a Live-poll tick elsewhere), and
                // _monadSync's own diff state (senderStore/lastSnapshot) has to be caught up
                // before building the next diff, or the push silently corrupts the chain —
                // it lands at the right index (Mnemonad.sol's `expectedLength` check
                // guarantees that atomically) but its *content* would still be wrong. See
                // monadsync/README.md's "Repairing a corrupt chain". Also bootstraps the
                // freshly-built writable instance just swapped in above, which starts
                // uninitialized regardless of whether the chain actually moved.
                const mn = this._monadSync._mn;
                mn.reInitialize();
                await mn.initialize();
                if (mn.length !== this._knownLength) {
                    this._monadSync.reInitialize();
                    await this._monadSync.initialize();
                }

                const result = await this._monadSync.push(this._rawFolder);
                // Mnemonad.push()'s own _afterWrite() only optimistically bumps `.length`,
                // not `.binaryLength` — a real initialize() (forced, since _afterWrite
                // already flipped _isInitialized false) is what makes binaryLength correct
                // here, not just paranoia.
                await mn.initialize();
                result.totalBytes = mn.binaryLength;
                result.patchCount = mn.length;
                this._knownLength = mn.length;
                this.status = 'ready';
                this.$emit('pushed', result);
            } catch (err) {
                console.error('[FileManagerBrowserSync] push failed:', err);
                this.status = 'error';
                this.$emit('error', err);
            } finally {
                this.isSaving = false;
                this._emitSyncState();
            }
        },
        onChanged() {
            clearTimeout(this._changeDebounce);
            this._changeDebounce = setTimeout(() => {
                this.$emit('change');
            }, 300);
        },
        onTogglePolling() {
            this.isPolling = !this.isPolling;
            if (this.isPolling) {
                this._startPolling();
            } else {
                this._stopPolling();
            }
        },
        _startPolling() {
            this._pollingBusy = false;
            this._pollingInterval = setInterval(() => this._doPoll(), 1000);
        },
        _stopPolling() {
            if (this._pollingInterval) {
                clearInterval(this._pollingInterval);
                this._pollingInterval = null;
            }
        },
        async _doPoll() {
            if (this._pollingBusy) return;
            this._pollingBusy = true;
            try {
                if (!this._monadSync) return;
                const mn = this._monadSync._mn;

                mn.reInitialize();
                await mn.initialize();
                if (mn.length <= this._knownLength) return;

                // Resync _monadSync itself, not just the raw mn above: restore() right below
                // rebuilds the *view* from its own independent read, but a later push() from
                // this tab needs _monadSync's own diff-building state (senderStore/
                // lastSnapshot) caught up too — otherwise the next save builds a diff against
                // the version this tab last knew about, not the one just detected here. That
                // diff still lands at the right chain index (Mnemonad.sol's own
                // `expectedLength` check guarantees that atomically) but its *content* would
                // be wrong, corrupting the chain — see monadsync/README.md's "Repairing a
                // corrupt chain" for exactly this failure mode. Confirmed live: this is what
                // actually happened before this fix.
                this._monadSync.reInitialize();
                await this._monadSync.initialize();

                const memFolder = await this._monadSync.restore();
                this._knownLength = mn.length;

                const newFolder = FileManagerDoubleSyncFolder.fromMemoryFolder(memFolder);
                newFolder.on('save', () => this.push());
                this._watchPendingChanges(newFolder);
                await newFolder.load();
                this._rawFolder = newFolder;
                this.$emit('folder', newFolder);

                if (this.$refs.browser) {
                    await this.$refs.browser.reinitialize(newFolder);
                }
            } catch (err) {
                console.error('[FileManagerBrowserSync] poll failed:', err);
            } finally {
                this._pollingBusy = false;
            }
        },
    },
    mounted() {
        if (this.stream) {
            this.initialize();
        }
    },
    unmounted() {
        this._stopPolling();
        if (this._pendingChangesUnsub) this._pendingChangesUnsub();
    },
    watch: {
        stream() {
            if (this.stream && !this.rootFolder) {
                this.initialize();
            }
        },
        // The page's own UnlockStreamDialog flips this once it succeeds — same instance,
        // now with a usable key, so just continue rather than re-fetching.
        async unlocked(isUnlocked) {
            if (isUnlocked && this.status === 'locked') {
                try {
                    await this._continueWithSync();
                } catch (err) {
                    console.error('[FileManagerBrowserSync] continue failed:', err);
                    this.loadError = this._errMessage(err);
                    this.status = 'error';
                    this.$emit('error', err);
                }
            }
        },
        // Same reasoning as AddPanel.vue's own watcher: the cached writable embeds this
        // wallet's client and address — never valid across an account switch or
        // disconnect, so it's dropped rather than kept around holding a stale one. push()
        // re-derives a fresh one from whichever account is connected when it actually
        // needs one; no need to eagerly rebuild _monadSync here just because the wallet
        // changed — reads keep working off `this.stream` regardless.
        'walletStore.connectionId'() {
            this.writable = null;
            this.checkCanWrite();
        },
    },
};
</script>

<style scoped>
.fileManagerBrowserSyncLoading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-height: 200px;
}
.fileManagerBrowserSyncHintWrapper {
    display: flex;
    align-items: center;
    gap: 12px;
}

.fileManagerBrowserSyncHint {
    font-size: 13px;
    color: var(--q-text-muted, #9a93b8);
}

.fileManagerBrowserSyncError {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 420px;
    padding: 0 20px;
    text-align: center;
}

.fileManagerBrowserSyncErrorTitle {
    font-size: 15px;
    font-weight: 600;
    color: var(--q-negative, #f87171);
}

.fileManagerBrowserSyncErrorMsg {
    font-size: 13px;
    line-height: 1.5;
    color: var(--q-negative, #f87171);
    word-break: break-word;
}

.fileManagerBrowserSyncRetry {
    margin-top: 4px;
    padding: 6px 18px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    background: var(--q-primary, #836ef9);
    border: none;
    border-radius: 8px;
    cursor: pointer;
}
.fileManagerBrowserSyncRetry:hover {
    filter: brightness(1.08);
}

/* Secondary to Retry — same shape, muted surface fill instead of the primary color, so
   it doesn't compete with Retry (the actual fix) for attention. */
.fileManagerBrowserSyncDebug {
    margin-top: 4px;
    padding: 6px 18px;
    font-size: 13px;
    font-weight: 600;
    color: var(--q-text, #d8d3ea);
    background: var(--q-surface-3, #2a1a5c);
    border: 1px solid var(--q-surface-border, #33246b);
    border-radius: 8px;
    cursor: pointer;
}
.fileManagerBrowserSyncDebug:hover {
    background: var(--q-surface-2, #1e1147);
}
</style>
