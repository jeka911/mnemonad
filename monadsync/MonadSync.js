import {
	DoubleSync,
	CDCStore,
	DoubleSyncSnapshot,
	DoubleSyncPatch,
	DoubleSyncDiffPatch,
	DoubleSyncCompressed,
	DoubleSyncFormat,
	DoubleSyncMemoryFolder,
} from '@fizzyflow/doublesync';

const SEGMENT_MAGIC = 0x4d4e5347; // MNSG
const SEGMENT_VERSION = 1;
const SEGMENT_HEADER_SIZE = 24;
const DEFAULT_MAX_PATCH_ITEM_BYTES = 8 * 1024 * 1024;

/**
 * Substrings that mark a chain-read failure as "this index just isn't readable right now"
 * rather than a real bug — replay/restore skip past these instead of throwing.
 *
 * `IndexOutOfBounds`/`IndexTruncated` are Mnemonad's own Solidity custom errors (surfaced by
 * viem inside the thrown error's `message`) for, respectively, an index past `length` and one
 * before `firstAvailableIndex` (i.e. dropped by `truncateFrom`). `invalid tag` is
 * `@noble/ciphers`' AES-GCM auth-tag-mismatch message — a decryption failure, which for this
 * class's purposes (an item this session can't currently read) is the same shape of problem as
 * an out-of-bounds index. `decrypt` is kept as a broader net for any other decryption error
 * text this SDK or a future offloading provider might throw.
 */
const SKIPPABLE_READ_ERROR_SUBSTRINGS = ['IndexOutOfBounds', 'IndexTruncated', 'invalid tag', 'decrypt'];

function isSkippableReadError(err) {
	const message = err?.message || '';
	return SKIPPABLE_READ_ERROR_SUBSTRINGS.some((s) => message.includes(s));
}

/**
 * Combines Mnemonad (on-chain append-only storage on Monad) with DoubleSync (CDC-based
 * folder-tree delta sync) to store snapshots and patches on-chain and reconstruct folder
 * state from the chain.
 *
 * Each Mnemonad item holds one patch document — either a full `DoubleSyncPatch` (item 0) or
 * an incremental `DoubleSyncDiffPatch` (items 1..N). The document type is auto-detected via
 * the magic header (`DoubleSyncFormat.detect`).
 *
 * If the underlying `Mnemonad` instance is itself encrypted (password- or signer-wrapped
 * key), every patch document pushed through it is transparently AES-encrypted by Mnemonad's
 * own `push()`/`at()` — this class never has to know or care; it only ever sees plaintext
 * patch bytes on either side.
 *
 * Sender workflow:
 *   const m = new MonadSync({ mnemonad, sync });
 *   await m.initialize();
 *   await m.push(senderRoot);          // first  → full patch
 *   await m.push(senderRoot);          // next   → diff patch
 *
 * Receiver workflow:
 *   const m = new MonadSync({ mnemonad });
 *   const folder = await m.restore();  // latest version
 *   const older  = await m.restore(2); // specific version
 *
 * @example
 * import Mnemonad from 'mnemonad';
 * import { DoubleSync } from '@fizzyflow/doublesync';
 * import MonadSync from 'monadsync';
 *
 * const mnemonad = new Mnemonad({ publicClient, walletClient, contractAddress, id });
 * const sync = new DoubleSync({ avgSize: 8192 });
 * const m = new MonadSync({ mnemonad, sync });
 * await m.initialize();
 * await m.push(senderRoot);
 */
export default class MonadSync {
	/**
	 * @param {Object} params
	 * @param {import('mnemonad').default} params.mnemonad - Mnemonad instance (read or read+write)
	 * @param {DoubleSync} [params.sync] - DoubleSync instance; defaults to `new DoubleSync()` if omitted
	 * @param {'gzip'|false} [params.compress=false] - wrap patches in a compression envelope before pushing
	 * @param {number} [params.maxPatchItemBytes=8388608] - split larger patch documents across multiple stream items
	 */
	constructor(params = {}) {
		if (!params.mnemonad) throw new Error('MonadSync: mnemonad is required');

		/** @type {import('mnemonad').default} */
		this._mn = params.mnemonad;
		/** @type {DoubleSync} */
		this._sync = params.sync || new DoubleSync();
		/** @type {?'gzip'} */
		this._compress = params.compress || null;
		/** @type {number} */
		this._maxPatchItemBytes = params.maxPatchItemBytes || DEFAULT_MAX_PATCH_ITEM_BYTES;

		/** @type {CDCStore} */
		this._senderStore = new CDCStore({ copyBytes: false });
		/** @type {CDCStore} */
		this._receiverMirror = new CDCStore();

		/** @type {?Uint8Array} - snapshot bytes from the last patch produced or replayed */
		this._lastSnapshot = null;
		/** @type {number} - how many items from chain have been replayed into _senderStore / _lastSnapshot */
		this._replayedCount = 0;

		/** @type {boolean} */
		this._isInitialized = false;
	}

	/**
	 * Number of patch versions stored on chain.
	 * @returns {Promise<number>}
	 */
	async length() {
		await this._mn.initialize();
		return this._mn.length;
	}

	/**
	 * Initialize: load the Mnemonad stream's state and rebuild CDCStore + session state
	 * by replaying every existing item from the chain.
	 *
	 * Safe to call multiple times — skips items already replayed.
	 * Handles a truncated prefix (`Mnemonad.truncateFrom`) by starting from the first
	 * still-readable item.
	 * @returns {Promise<void>}
	 */
	async initialize() {
		await this._mn.initialize();

		const total = this._mn.length;
		const firstAvailableIndex = this._mn.firstAvailableIndex || 0;

		// If the stream's prefix has been truncated, reset replay state to start from the
		// first still-readable item — this ensures we don't try to access dropped indices.
		if (firstAvailableIndex > 0 && this._replayedCount < firstAvailableIndex) {
			this._senderStore = new CDCStore({ copyBytes: false });
			this._receiverMirror = new CDCStore();
			this._lastSnapshot = null;
			this._replayedCount = firstAvailableIndex;
		}

		// Replay items we haven't seen yet
		if (this._replayedCount < total) {
			await this._replayRange(this._replayedCount, total);
		}

		this._isInitialized = true;
	}

	/**
	 * Re-initialize: force reload from chain. Useful after external pushes.
	 */
	reInitialize() {
		this._mn.reInitialize();
		this._senderStore = new CDCStore({ copyBytes: false });
		this._receiverMirror = new CDCStore();
		this._lastSnapshot = null;
		this._replayedCount = 0;
		this._isInitialized = false;
	}

	/**
	 * Build the next patch from `root` and push it to the Mnemonad stream.
	 *
	 * First push produces a full `DoubleSyncPatch`; every subsequent push
	 * produces a `DoubleSyncDiffPatch` against the previous snapshot.
	 *
	 * Same as `preparePush()` followed by `commitPush()` — call those two directly to build a
	 * patch now and send it later (or from another process).
	 *
	 * @param {import('@fizzyflow/doublesync').DoubleSyncFolder} root - sender's current folder tree
	 * @param {Object} [params]
	 * @param {bigint} [params.value] - passed straight through to Mnemonad's `push()`, in case
	 *   the stream needs an explicit fee override
	 * @returns {Promise<{version: number}>}
	 */
	async push(root, params = {}) {
		return await this.commitPush(await this.preparePush(root), params);
	}

	/**
	 * Builds the next patch document from `root` without writing anything to chain.
	 *
	 * The result is self-contained: `commitPush()` can send it from this instance, or from a
	 * fresh `MonadSync` on a fresh `Mnemonad` in another process, with no chain replay —
	 * `patchBytes` is the exact (already compressed) document `push()` would have sent.
	 *
	 * `baseLength` is the stream length the patch was built against. A diff only makes sense on
	 * top of that exact version, so `commitPush()` refuses to send it anywhere else.
	 *
	 * @param {import('@fizzyflow/doublesync').DoubleSyncFolder} root - sender's current folder tree
	 * @returns {Promise<{
	 *   patchBytes: Uint8Array,
	 *   kind: 'patch'|'diff-patch',
	 *   baseLength: number,
	 *   itemCount: number,
	 *   version: number,
	 *   newSnapshot: Uint8Array,
	 *   newChunks: Array<{hash: Uint8Array, bytes: Uint8Array}>,
	 * }>}
	 */
	async preparePush(root) {
		if (!this._isInitialized) await this.initialize();

		let patchBytes;
		let newSnapshot = null;
		const newChunks = [];
		const kind = this._lastSnapshot ? 'diff-patch' : 'patch';

		if (kind === 'patch') {
			patchBytes = await this._sync.buildPatch({
				root,
				senderStore: this._senderStore,
				receiverStore: this._receiverMirror,
			});

			const parsed = new DoubleSyncPatch(patchBytes);
			newSnapshot = parsed.snapshot.slice();

			for (const { hash, bytes } of parsed.chunks()) {
				newChunks.push({ hash, bytes });
			}
		} else {
			const result = await this._sync.buildDiffPatch({
				root,
				senderStore: this._senderStore,
				receiverStore: this._receiverMirror,
				prevSnapshot: this._lastSnapshot,
			});
			patchBytes = result.patch;
			newSnapshot = result.newSnapshot;

			const parsedDiff = new DoubleSyncDiffPatch(patchBytes);
			for (const { hash, bytes } of parsedDiff.chunks()) {
				newChunks.push({ hash, bytes });
			}
		}

		if (this._compress) {
			patchBytes = await DoubleSyncCompressed.encode(patchBytes, this._compress);
		}

		// Building fills _senderStore with this patch's chunks; reset it to what the receiver
		// actually holds, so a prepared-but-never-committed patch leaves this instance exactly
		// as it found it. commitPush() adds the chunks back once they're really on chain.
		this._senderStore = this._cloneReceiverMirror();

		const baseLength = this._mn.length;
		const itemCount = this._patchItemCount(patchBytes.length);
		return {
			patchBytes,
			kind,
			baseLength,
			itemCount,
			version: baseLength + itemCount,
			newSnapshot,
			newChunks,
		};
	}

	/**
	 * Sends a patch built by `preparePush()`.
	 *
	 * Works on an instance that never replayed the chain (a fresh one in another process):
	 * only `patchBytes` and `baseLength` are needed to send. `newSnapshot`/`newChunks` update
	 * this instance's own state afterwards, and are only used when it was initialized.
	 *
	 * Throws without writing anything when the stream no longer has `baseLength` items — the
	 * patch was built against that version, and appended on top of a different one it would
	 * leave the chain unreadable. The contract enforces the same thing on every write (each
	 * push names the index it expects to land at), so a stream that moves between this check
	 * and the transaction reverts instead of landing on the wrong base.
	 *
	 * @param {Awaited<ReturnType<MonadSync['preparePush']>>} prepared
	 * @param {Object} [params] - forwarded to Mnemonad's `push()`
	 * @returns {Promise<{version: number}>}
	 */
	async commitPush(prepared, params = {}) {
		await this._mn.initialize();
		if (this._mn.length !== prepared.baseLength) {
			const err = new Error(
				`MonadSync.commitPush: stream has ${this._mn.length} item(s), but this patch was built ` +
				`against ${prepared.baseLength} — rebuild it on top of the current version`
			);
			err.code = 'STREAM_MOVED';
			throw err;
		}

		const pushedItems = await this._pushPatchDocument(prepared.patchBytes, params);

		if (this._isInitialized) {
			this._lastSnapshot = prepared.newSnapshot;
			for (const { hash, bytes } of prepared.newChunks || []) {
				this._receiverMirror.putWithHash(hash, bytes);
				this._senderStore.putWithHash(hash, bytes);
			}
			this._replayedCount = prepared.baseLength + pushedItems;
		}

		return { version: prepared.baseLength + pushedItems };
	}

	/**
	 * Read raw patch bytes at the given chain index.
	 *
	 * @param {number} index
	 * @returns {Promise<Uint8Array>}
	 */
	async getPatch(index) {
		await this._mn.initialize();
		return await this._mn.at(index);
	}

	/**
	 * Reconstruct the folder tree by replaying patches 0..version from the chain.
	 * Returns a `DoubleSyncMemoryFolder` containing the reconstructed tree.
	 *
	 * @param {number} [version] - replay up to this version (exclusive); defaults to latest
	 * @returns {Promise<DoubleSyncMemoryFolder>}
	 */
	async restore(version) {
		await this._mn.initialize();

		const total = this._mn.length;
		const end = (version !== undefined) ? Math.min(version, total) : total;

		if (end === 0) return new DoubleSyncMemoryFolder('root');

		let store = new CDCStore({ copyBytes: false });
		let dest = new DoubleSyncMemoryFolder('root');
		let lastSnapshot = null;
		let invalidState = false;

		// Skip a truncated prefix when restoring
		const firstAvailableIndex = this._mn.firstAvailableIndex || 0;
		const startIndex = Math.max(0, firstAvailableIndex);

		for (let i = startIndex; i < end;) {
			let item;
			try {
				item = await this._readPatchDocument(i, end);
			} catch (err) {
				// Skip indices that are inaccessible: truncated, decryption failures, etc.
				if (isSkippableReadError(err)) {
					i++;
					continue;
				}
				throw err;
			}
			let patchBytes = item.patchBytes;
			i = item.nextIndex;

			if (DoubleSyncFormat.isCompressed(patchBytes)) {
				patchBytes = await DoubleSyncCompressed.decode(patchBytes);
			}

			const kind = DoubleSyncFormat.detect(patchBytes);

			if (kind === 'patch') {
				// Full snapshot — reset all state and use this as the new baseline.
				// This makes full snapshots act as recovery points: corrupt diffs
				// before this index are skipped.
				store = new CDCStore({ copyBytes: false });
				dest = new DoubleSyncMemoryFolder('root');

				// Extract chunks from patch and add to store before applying
				const parsed = new DoubleSyncPatch(patchBytes);
				const chunks = Array.from(parsed.chunks());
				for (const { hash, bytes } of chunks) {
					store.putWithHash(hash, bytes);
				}

				await this._sync.applyPatch({ patch: patchBytes, store, dest });
				lastSnapshot = parsed.snapshot.slice();
				invalidState = false;
			} else if (kind === 'diff-patch') {
				if (invalidState || !lastSnapshot) {
					// In invalid state — skip this diff and wait for the next full snapshot.
					continue;
				}
				try {
					// Extract chunks from patch and add to store before applying
					const parsedDiff = new DoubleSyncDiffPatch(patchBytes);
					for (const { hash, bytes } of parsedDiff.chunks()) {
						store.putWithHash(hash, bytes);
					}

					const newSnapshot = await this._sync.applyDiffPatch({
						patch: patchBytes,
						store,
						dest,
						prevSnapshot: lastSnapshot,
					});
					lastSnapshot = newSnapshot;
				} catch (_err) {
					// Corrupt diff — enter invalid state and wait for next full snapshot.
					invalidState = true;
					lastSnapshot = null;
				}
			} else {
				throw new Error(`MonadSync.restore: unknown patch type at index ${i}`);
			}
		}

		if (invalidState) {
			throw new Error('MonadSync.restore: chain ends in corrupt state with no recovery snapshot; push a full snapshot to repair');
		}

		return dest;
	}

	/**
	 * Get the Merkle tree hash for a specific version.
	 * Reads backwards from the target to find the nearest full snapshot,
	 * then replays only the diff-patches forward.
	 * Best case (latest is a full snapshot): single read, no replay.
	 *
	 * @param {number} [version] - version to query; defaults to latest
	 * @returns {Promise<Uint8Array>} 32-byte tree hash
	 */
	async getTreeHash(version) {
		await this._mn.initialize();

		const total = this._mn.length;
		const end = (version !== undefined) ? Math.min(version, total) : total;
		if (end === 0) return new Uint8Array(32);

		const diffPatches = [];

		for (let i = end - 1; i >= 0; i--) {
			let item;
			try {
				item = await this._readPatchDocument(i, total);
			} catch (err) {
				// Skip indices that are inaccessible: truncated, decryption failures, etc.
				if (isSkippableReadError(err)) {
					continue;
				}
				throw err;
			}
			let patchBytes = item.patchBytes;

			if (DoubleSyncFormat.isCompressed(patchBytes)) {
				patchBytes = await DoubleSyncCompressed.decode(patchBytes);
			}

			const kind = DoubleSyncFormat.detect(patchBytes);

			if (kind === 'patch') {
				const parsed = new DoubleSyncPatch(patchBytes);
				if (diffPatches.length === 0) {
					return new DoubleSyncSnapshot(parsed.snapshot).treeHash;
				}
				let currentSnapshot = parsed.snapshot;
				const store = new CDCStore({ copyBytes: false });
				for (const { hash, bytes } of parsed.chunks()) {
					store.putWithHash(hash, bytes);
				}
				const dest = new DoubleSyncMemoryFolder('_hash');
				for (const diffBytes of diffPatches) {
					currentSnapshot = await this._sync.applyDiffPatch({
						patch: diffBytes, store, dest, prevSnapshot: currentSnapshot,
					});
				}
				return new DoubleSyncSnapshot(currentSnapshot).treeHash;
			}

			diffPatches.unshift(patchBytes);
		}

		return new Uint8Array(32);
	}

	/**
	 * Replay items from the chain into _senderStore and _lastSnapshot so the sender
	 * session state is up to date for the next push().
	 *
	 * @param {number} from - inclusive start index
	 * @param {number} to - exclusive end index
	 */
	async _replayRange(from, to) {
		const dest = new DoubleSyncMemoryFolder('_replay');
		let invalidState = false;

		for (let i = from; i < to;) {
			let item;
			try {
				item = await this._readPatchDocument(i, to);
			} catch (err) {
				// Skip indices that are inaccessible: truncated, decryption failures, etc.
				if (isSkippableReadError(err)) {
					i++;
					continue;
				}
				throw err;
			}
			let patchBytes = item.patchBytes;
			i = item.nextIndex;

			if (DoubleSyncFormat.isCompressed(patchBytes)) {
				patchBytes = await DoubleSyncCompressed.decode(patchBytes);
			}

			const kind = DoubleSyncFormat.detect(patchBytes);

			if (kind === 'patch') {
				// Full snapshot — reset sender state so subsequent diffs build on top of this.
				this._senderStore = new CDCStore({ copyBytes: false });
				this._receiverMirror = new CDCStore();
				await this._sync.applyPatch({ patch: patchBytes, store: this._senderStore, dest });
				const parsed = new DoubleSyncPatch(patchBytes);
				this._lastSnapshot = parsed.snapshot.slice();
				for (const { hash, bytes } of parsed.chunks()) {
					this._receiverMirror.putWithHash(hash, bytes);
				}
				invalidState = false;
			} else if (kind === 'diff-patch') {
				if (invalidState || !this._lastSnapshot) {
					continue;
				}
				try {
					const newSnapshot = await this._sync.applyDiffPatch({
						patch: patchBytes,
						store: this._senderStore,
						dest,
						prevSnapshot: this._lastSnapshot,
					});
					this._lastSnapshot = newSnapshot;
					const parsedDiff = new DoubleSyncDiffPatch(patchBytes);
					for (const { hash, bytes } of parsedDiff.chunks()) {
						this._receiverMirror.putWithHash(hash, bytes);
					}
				} catch (_err) {
					invalidState = true;
					this._lastSnapshot = null;
				}
			} else {
				throw new Error(`MonadSync._replayRange: unknown patch type at index ${i}`);
			}
		}

		if (invalidState) {
			throw new Error('MonadSync._replayRange: chain ends in corrupt state with no recovery snapshot');
		}

		this._replayedCount = to;
	}

	/** How many stream items `_pushPatchDocument` turns a patch of `byteLength` bytes into. */
	_patchItemCount(byteLength) {
		if (!this._maxPatchItemBytes || byteLength <= this._maxPatchItemBytes) return 1;
		const segmentPayloadBytes = Math.max(1, this._maxPatchItemBytes - SEGMENT_HEADER_SIZE);
		return Math.ceil(byteLength / segmentPayloadBytes);
	}

	async _pushPatchDocument(patchBytes, params) {
		if (!(patchBytes instanceof Uint8Array)) throw new Error('MonadSync._pushPatchDocument: patchBytes must be Uint8Array');

		if (!this._maxPatchItemBytes || patchBytes.length <= this._maxPatchItemBytes) {
			await this._mn.push(patchBytes, params);
			return 1;
		}

		const segmentPayloadBytes = Math.max(1, this._maxPatchItemBytes - SEGMENT_HEADER_SIZE);
		const total = Math.ceil(patchBytes.length / segmentPayloadBytes);
		for (let index = 0; index < total; index++) {
			const start = index * segmentPayloadBytes;
			const payload = patchBytes.subarray(start, Math.min(start + segmentPayloadBytes, patchBytes.length));
			await this._mn.push(encodeSegment(payload, { index, total, originalLength: patchBytes.length }), params);
		}
		return total;
	}

	async _readPatchDocument(index, end) {
		const first = await this._mn.at(index);
		const segment = parseSegment(first);
		if (!segment) return { patchBytes: first, nextIndex: index + 1 };

		if (segment.index !== 0) {
			throw new Error(`MonadSync: segmented patch at index ${index} starts with segment ${segment.index}`);
		}

		const parts = new Array(segment.total);
		parts[0] = segment.payload;
		let nextIndex = index + 1;
		for (let expected = 1; expected < segment.total; expected++, nextIndex++) {
			if (nextIndex >= end) {
				throw new Error(`MonadSync: incomplete segmented patch at index ${index}`);
			}
			const nextSegment = parseSegment(await this._mn.at(nextIndex));
			if (!nextSegment || nextSegment.index !== expected || nextSegment.total !== segment.total || nextSegment.originalLength !== segment.originalLength) {
				throw new Error(`MonadSync: invalid segmented patch segment at index ${nextIndex}`);
			}
			parts[expected] = nextSegment.payload;
		}

		const out = new Uint8Array(segment.originalLength);
		let cur = 0;
		for (const part of parts) {
			out.set(part, cur);
			cur += part.length;
		}
		if (cur !== out.length) throw new Error(`MonadSync: segmented patch size mismatch (${cur} != ${out.length})`);
		return { patchBytes: out, nextIndex };
	}

	_cloneReceiverMirror() {
		const store = new CDCStore({ copyBytes: false });
		for (const hash of this._receiverMirror.hashes()) {
			const bytes = this._receiverMirror.get(hash);
			if (bytes) store.putWithHash(hash, bytes);
		}
		return store;
	}
}

function encodeSegment(payload, { index, total, originalLength }) {
	const out = new Uint8Array(SEGMENT_HEADER_SIZE + payload.length);
	const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
	dv.setUint32(0, SEGMENT_MAGIC, true);
	out[4] = SEGMENT_VERSION;
	dv.setUint32(8, index, true);
	dv.setUint32(12, total, true);
	dv.setBigUint64(16, BigInt(originalLength), true);
	out.set(payload, SEGMENT_HEADER_SIZE);
	return out;
}

function parseSegment(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < SEGMENT_HEADER_SIZE) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0, true) !== SEGMENT_MAGIC || bytes[4] !== SEGMENT_VERSION) return null;
	const index = dv.getUint32(8, true);
	const total = dv.getUint32(12, true);
	const originalLength = Number(dv.getBigUint64(16, true));
	if (!total || index >= total || !Number.isSafeInteger(originalLength)) {
		throw new Error('MonadSync: invalid segmented patch header');
	}
	return {
		index,
		total,
		originalLength,
		payload: bytes.subarray(SEGMENT_HEADER_SIZE),
	};
}
