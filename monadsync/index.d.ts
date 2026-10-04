/**
 * Type declarations for monadsync.
 *
 * A one-to-one mirror of `MonadSync.js`'s public API, plus a re-export of everything
 * `@fizzyflow/doublesync` itself exports (see that package's own `index.d.ts` for those
 * types) — this file only declares what MonadSync adds on top.
 */

import type Mnemonad from 'mnemonad';
import type { DoubleSync, DoubleSyncFolder, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';

export interface MonadSyncParams {
	/** Mnemonad instance (read or read+write) this session stores patches in/reads them from. */
	mnemonad: Mnemonad;
	/** DoubleSync instance with CDC parameters; defaults to `new DoubleSync()` if omitted. */
	sync?: DoubleSync;
	/** Wrap patches in a compression envelope before pushing. */
	compress?: 'gzip' | false;
	/** Split larger patch documents across multiple stream items. Default 8 MiB. */
	maxPatchItemBytes?: number;
}

export interface MonadSyncPushParams {
	/** Passed straight through to `Mnemonad.push()` — e.g. an explicit fee override. */
	value?: bigint;
	[key: string]: unknown;
}

export interface MonadSyncPushResult {
	/** Chain length after this push — the version this push produced. */
	version: number;
}

/** A patch built by `preparePush()`, ready for `commitPush()` — here or in another process. */
export interface MonadSyncPreparedPush {
	/** The exact (already compressed) patch document to send. */
	patchBytes: Uint8Array;
	/** `'patch'` for a full snapshot, `'diff-patch'` for a diff against the previous version. */
	kind: 'patch' | 'diff-patch';
	/** Stream length the patch was built against; `commitPush()` refuses any other. */
	baseLength: number;
	/** Stream items the patch occupies once sent (more than 1 only for a segmented patch). */
	itemCount: number;
	/** The version this patch produces once sent: `baseLength + itemCount`. */
	version: number;
	/** Snapshot after this patch — only used to update an initialized instance's state. */
	newSnapshot: Uint8Array;
	/** Chunks this patch adds — only used to update an initialized instance's state. */
	newChunks: Array<{ hash: Uint8Array; bytes: Uint8Array }>;
}

/**
 * Combines Mnemonad (on-chain append-only storage on Monad) with DoubleSync (CDC-based
 * folder-tree delta sync) to store snapshots and patches on-chain and reconstruct folder
 * state from the chain.
 */
export default class MonadSync {
	constructor(params: MonadSyncParams);

	/** The Mnemonad instance this session is backed by. */
	readonly _mn: Mnemonad;

	/** Number of patch versions stored on chain. */
	length(): Promise<number>;

	/**
	 * Load the Mnemonad stream's state and rebuild CDCStore + session state by replaying
	 * every existing item from the chain. Safe to call multiple times.
	 */
	initialize(): Promise<void>;

	/** Force full state reset. Next `initialize()` replays the chain from scratch. */
	reInitialize(): void;

	/**
	 * Build the next patch from `root` and push it to the Mnemonad stream. First push
	 * produces a full patch; every subsequent push produces a diff patch.
	 */
	push(root: DoubleSyncFolder, params?: MonadSyncPushParams): Promise<MonadSyncPushResult>;

	/** Build the next patch from `root` without writing anything to chain. */
	preparePush(root: DoubleSyncFolder): Promise<MonadSyncPreparedPush>;

	/**
	 * Send a patch built by `preparePush()`. Needs no chain replay, so a fresh instance can
	 * send it. Throws (`err.code === 'STREAM_MOVED'`) without writing when the stream no
	 * longer has `prepared.baseLength` items.
	 */
	commitPush(prepared: MonadSyncPreparedPush, params?: MonadSyncPushParams): Promise<MonadSyncPushResult>;

	/** Raw patch bytes at the given chain index. */
	getPatch(index: number): Promise<Uint8Array>;

	/**
	 * Reconstruct the folder tree by replaying patches 0..version from the chain. Defaults
	 * to latest version.
	 */
	restore(version?: number): Promise<DoubleSyncMemoryFolder>;

	/**
	 * 32-byte Merkle tree hash for the given version (defaults to latest). Reads backwards
	 * to find the nearest full snapshot, then replays only the diff-patches forward.
	 */
	getTreeHash(version?: number): Promise<Uint8Array>;
}

export {
	CDCSync,
	CDCManifest,
	CDCStore,
	FastCDC,
	GEAR,
	DoubleSyncFile,
	DoubleSyncMemoryFile,
	DoubleSyncFolder,
	DoubleSyncMemoryFolder,
	DoubleSyncSnapshot,
	DoubleSync,
	DoubleSyncPatch,
	DoubleSyncDiffPatch,
	DoubleSyncCompressed,
	DoubleSyncFormat,
	MAGICS,
	diffSnapshots,
	DoubleSyncSession,
} from '@fizzyflow/doublesync';
