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
