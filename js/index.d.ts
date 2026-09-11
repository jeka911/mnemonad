/**
 * Type declarations for mnemonad.
 */

export declare const EXPECTED_CONTRACT_VERSION: number;

/** On-chain storage tier, mirroring `Mnemonad.Store` in Solidity. */
export declare const Store: {
	readonly NONE: 0;
	readonly SLOT: 1;
	readonly CODE: 2;
	readonly EXTERNAL: 3;
};

export declare const StoreName: Record<number, string>;

/** Pointer codecs for external items. */
export declare const Codec: {
	readonly IPFS: 0;
	readonly ARWEAVE: 1;
	readonly HTTPS: 2;
};

export declare const mnemonadAbi: readonly unknown[];

export interface NetworkIds {
	chainId: number;
	version: number | null;
	contractAddress: string | null;
}

export declare const ids: Record<string, NetworkIds>;

/** Decoded on-chain Pointer struct. */
export interface Pointer {
	/** sha256 of the payload, 0x-prefixed. */
	hash: string;
	/** Off-chain payload size in bytes. */
	size: bigint;
	codec: number;
	/** IPFS CID or URI. */
	locator: string;
}

/** Physical layout of an item, without its payload. */
export interface ItemRefs {
	store: number;
	/** Data-contract addresses. A successor registry can adopt these directly. */
	chunks: string[];
	offset: number;
	size: number;
	meta: Uint8Array;
}

export interface CostEstimate {
	gas: bigint;
	gasCost: bigint;
	fee: bigint;
	total: bigint;
	/** 1, except for the staged path (an oversized item with `{ onChain: true }`), where
	 *  it's `beginItem` + one `appendChunk` per chunk + `commitItem` — that many wallet
	 *  confirmations, not one. */
	transactionCount: number;
}

export interface AvailabilityReport {
	index: number;
	locator: string;
	available: boolean;
	error: string | null;
}

/** Custom transaction sender. */
export type CustomSendTransactionFunction = (request: unknown) => Promise<string>;

export interface MnemonadParams {
	/** viem PublicClient, for reads. */
	publicClient?: unknown;
	/** Stream id (ERC-721 token id). */
	id?: bigint | string | null;
	/** Registry address, or a key from `ids` such as 'monadTestnet'. */
	contractAddress?: string | null;
	/** viem WalletClient. Adds write capability. */
	walletClient?: unknown;
	/** Adds write capability without a WalletClient. */
	sendTransaction?: CustomSendTransactionFunction | null;
	senderAddress?: string | null;
	/** IPFS gateway for reads, e.g. 'https://ipfs.io/ipfs/'. */
	gatewayUrl?: string | null;
	/** IPFS pinning endpoint for writes. */
	pinningUrl?: string | null;
	pinningJwt?: string | null;
	/** Custom IPFS transport. */
	ipfsClient?: {
		put?: (b: Uint8Array) => Promise<string>;
		get?: (cid: string) => Promise<Uint8Array>;
		/** Optional ranged read. Without it, ranged reads fall back to whole fetches. */
		getRange?: (cid: string, start: number, len: number) => Promise<Uint8Array>;
	} | null;
	/**
	 * A pre-built off-chain storage provider — `MnemonadPinataProvider`, a custom subclass
	 * of `MnemonadOffloadingProvider`, or a future Filecoin/Walrus one. Takes over from
	 * `gatewayUrl`/`pinningUrl`/`pinningJwt`/`ipfsClient` entirely when given.
	 */
	offloadingProvider?: MnemonadOffloadingProvider | null;
	/**
	 * Allow ranged fetches of PLAINTEXT off-chain items, whose bytes cannot be checked
	 * against the pointer's whole-blob hash. Off by default. Encrypted items ignore this —
	 * their frames are individually authenticated.
	 */
	allowUnverifiedRanges?: boolean;
	/** Signer used to wrap/unwrap the encryption key. */
	signer?: unknown;
	/** Pre-known plaintext data key, skips unwrapping. */
	aesKey?: Uint8Array | null;
	/**
	 * Plaintext password; an alternative to `signer` for wrapping/unwrapping the encryption
	 * key via PBKDF2-HMAC-SHA256. Must not be empty. See `MnemonadCrypto`.
	 */
	password?: string | null;
	/**
	 * Salt for the password KDF, as a 0x-prefixed hex string or raw bytes. Required to
	 * unwrap; generated fresh if omitted when wrapping — read it back via
	 * `MnemonadCrypto.getPasswordSalt()` and persist it.
	 */
	passwordSalt?: string | Uint8Array | null;
	/** PBKDF2 iteration count. Defaults to `MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS`. */
	passwordIterations?: number;
	/**
	 * Largest slice fetched per read call. Default 512 KB — inside Monad's 8 MB
	 * per-transaction memory cap, which is what bounds a one-shot read rather than gas.
	 */
	readPageBytes?: number;
	/**
	 * Caps outbound RPC calls to at most this many per second, queuing the rest instead of
	 * firing them all at once — public RPC endpoints commonly 429 an unthrottled fan-out
	 * (several fields per stream, times several streams, all via `Promise.all`). Shared
	 * across every instance configured with the same rate on the same chain, so a fan-out
	 * over many streams is throttled as one budget rather than one per stream. Omit for
	 * unlimited (the default).
	 */
	maxRPCRequestsPerSecond?: number | null;
	/**
	 * Overrides how hard a read retries a transient RPC failure (writes are never retried,
	 * regardless). Omit for the class defaults (4 attempts, backing off 250ms→500ms→1000ms,
	 * ~1.75s total). Still bounded, never infinite, even when raised — see `MnemonadRateLimiter`.
	 * Shared across every instance configured identically for the same chain + rate.
	 */
	rpcRetry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: boolean } | null;
	/**
	 * Item-payload cache. `false`/`null` disables caching entirely; a custom object with
	 * `get`/`set` is used verbatim (not shared); omit for the shared default — IndexedDB in
	 * a browser, an in-memory Map elsewhere. Always stores pre-decryption bytes (ciphertext
	 * for an encrypted stream), never plaintext. See `MnemonadChunkCache`.
	 */
	cache?: boolean | { get(key: string): Promise<Uint8Array | undefined>; set(key: string, bytes: Uint8Array): Promise<void> } | null;
	/** Tunes the shared default cache; ignored if `cache` is set. See `ChunkCacheOptions`. */
	cacheOptions?: ChunkCacheOptions;
	/**
	 * When true, every RPC call this instance makes is recorded into the process-wide log —
	 * see `getRpcCallCount`/`subscribeRpcCalls`. Off by default; purely observational.
	 */
	debug?: boolean;
}

export interface CreateParams extends MnemonadParams {
	/** Initial item(s) to push. */
	array?: Uint8Array | Uint8Array[] | null;
	/** 0x-prefixed 32-byte hex. Random if omitted. */
	salt?: string | null;
	/** Raw stream-level metadata bytes. Wins outright over `name` when given. */
	meta?: Uint8Array | null;
	/**
	 * Stream name, encoded (with this stream's own password KEK block, if any) into `meta`
	 * automatically when `meta` isn't given directly. See `streamMeta.js`'s own doc.
	 */
	name?: string | null;
	/** Create an encrypted stream. Requires `signer` or `password`. */
	encrypt?: boolean;
	options?: TxOptions;
}

export interface TxOptions {
	/** Receipt timeout in ms. Default 30000. */
	timeout?: number;
	/** Receipt poll interval in ms. Default 200. */
	pollIntervalMs?: number;
}

export interface PushParams extends TxOptions {
	/** Force large items on-chain via staged append instead of offloading to IPFS. */
	onChain?: boolean;
	/** Raw per-item metadata bytes (single items only). Wins outright over `name`/`type`. */
	itemMeta?: Uint8Array | null;
	/** Item name, encoded into `itemMeta` automatically when it isn't given directly. */
	name?: string | null;
	/** Item MIME type, encoded the same way as `name`. */
	type?: string | null;
	/**
	 * Set `false` to skip prepaying through a wired upload gateway for an off-chain item —
	 * on by default, since `push()` handles the whole commit/pay/upload sequence itself.
	 */
	payGateway?: boolean;
	/**
	 * Called for a multi-step write. Staged on-chain (`onChain: true` past
	 * `maxChunkBytes`): once after `beginItem`, once after each `appendChunk`
	 * (`chunkIndex` = how many have landed so far, 1-based), and once after `commitItem`.
	 * Gateway-prepaid off-chain: once before `payForUpload` (`phase: 'gateway-pay'`) and
	 * once before the upload itself (`phase: 'gateway-upload'`). Ignored for a
	 * single-transaction push, which has nothing to report progress on. Best-effort
	 * visibility only; there is no resume support if a staged upload fails partway through.
	 */
	onProgress?:
		| ((info: {
				phase: 'begin' | 'chunk' | 'commit' | 'gateway-pay' | 'gateway-upload';
				chunkIndex: number;
				chunkCount: number;
		  }) => void)
		| null;
	/**
	 * The payload is already ciphertext; skip re-encrypting it. Needed for `pushExternal`
	 * when prepaying through `MnemonadUploadGateway` on an encrypted stream — see
	 * `offloadCommitment`'s own doc for the full sequence.
	 */
	alreadyEncrypted?: boolean;
}

export declare class MnemonadItem {
	type: 'bytes' | 'external' | 'empty';
	meta: Uint8Array;
	store: number;
	readonly isBytes: boolean;
	/** True for off-chain items. */
	readonly isExternal: boolean;
	readonly isEmpty: boolean;
	/** 'slot' | 'code' | 'external' | 'none'. */
	readonly storeName: string;
	readonly size: number;
	/**
	 * True once `.bytes()` has actually fetched and cached the payload (on-chain or
	 * external — both are lazy), always false for empty items. Pure cache inspection.
	 */
	readonly isLoaded: boolean;
	/** This item's own metadata (`{name, type}`), decoded from raw `meta` on every access —
	 *  see `itemMeta.js`'s own doc. */
	readonly itemMeta: { name: string | null; type: string | null };
	bytes(): Promise<Uint8Array>;
	pointerData(): Pointer | null;
	static fromChain(raw: unknown, context?: unknown): MnemonadItem;
	static concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array;
}

/**
 * Base class for an off-chain storage backend — IPFS, a future Filecoin/Walrus provider,
 * or your own subclass. `attach(mnemonad)` is called once by `Mnemonad`'s constructor, not
 * passed at construction time, so a provider can be built before a `Mnemonad` exists.
 */
export declare class MnemonadOffloadingProvider {
	/** The on-chain `Pointer.codec` value this provider's pointers use. */
	static readonly codec: number;
	attach(mnemonad: unknown): this;
	readonly isEnabled: boolean;
	readonly canWrite: boolean;
	putBytes(data: Uint8Array): Promise<Pointer>;
	readPointerBytes(pointerData: Pointer): Promise<Uint8Array>;
	readPointerRange(pointerData: Pointer, start: number, len: number): Promise<Uint8Array>;
	verifyAvailability(params?: { verify?: boolean }): Promise<AvailabilityReport[]>;
	repin(index: number): Promise<string>;
}

/**
 * Generic IPFS offloading provider — any pinning-service HTTP API (Pinata, web3.storage,
 * Filebase, a self-hosted kubo node) via `gatewayUrl`/`pinningUrl`/`pinningJwt`, or a fully
 * custom `ipfsClient` transport. `MnemonadPinataProvider` is a thin preset of this.
 */
export declare class MnemonadIpfs extends MnemonadOffloadingProvider {
	constructor(params?: {
		mnemonad?: unknown;
		gatewayUrl?: string | null;
		pinningUrl?: string | null;
		/** Static bearer token. Ignored when `pinningJwtProvider` is also given. */
		pinningJwt?: string | null;
		/** Resolved fresh before every upload instead of a static `pinningJwt` — the
		 *  browser-safe half of a pre-signed/temporary-JWT flow (see
		 *  `MnemonadPinataProvider.mintUploadJwt`, the server-only half). */
		pinningJwtProvider?: (() => Promise<string>) | null;
		ipfsClient?: MnemonadParams['ipfsClient'];
	});
	/** Fetches and verifies a whole payload against the pointer's size and hash. */
	readPointerBytes(pointerData: Pointer): Promise<Uint8Array>;
	/**
	 * Fetches a byte range without pulling the whole payload where the transport supports
	 * it. NOT checked against the pointer's blob hash — safe for encrypted items, whose
	 * frames are individually authenticated; unverified for plaintext ones.
	 */
	readPointerRange(pointerData: Pointer, start: number, len: number): Promise<Uint8Array>;
	/**
	 * Probes retrievability of every external item. Necessarily weak: IPFS has no
	 * on-chain expiry, so this observes rather than guarantees. There is deliberately no
	 * on-chain-managed extension mechanism — nothing on-chain can be extended.
	 */
	verifyAvailability(params?: { verify?: boolean }): Promise<AvailabilityReport[]>;
	repin(index: number): Promise<string>;
}

/**
 * Pinata preset of `MnemonadIpfs` — its endpoint URLs baked in as defaults, so only
 * `pinningJwt` (a key with pinning-write scope) needs supplying.
 */
export declare class MnemonadPinataProvider extends MnemonadIpfs {
	constructor(params?: {
		mnemonad?: unknown;
		pinningJwt?: string;
		pinningJwtProvider?: (() => Promise<string>) | null;
		gatewayUrl?: string | null;
		pinningUrl?: string | null;
	});
	/** Unpins a CID this account previously pinned. Pinata-specific — not part of the base
	 *  provider contract, since most backends have no equivalent of "delete". */
	unpin(cid: string): Promise<void>;
	/**
	 * Server-only. Mints a narrow, single-use-by-default Pinata JWT (scoped to
	 * `pinFileToIPFS` only) from the real admin JWT — Pinata's documented signed-upload
	 * pattern. `adminJwt` must never reach a browser bundle; call this from a backend and
	 * hand the result to the frontend, typically via `pinningJwtProvider`.
	 */
	static mintUploadJwt(
		adminJwt: string,
		options?: { maxUses?: number; keyName?: string | null }
	): Promise<string>;
}

/**
 * Caps outbound RPC calls to at most `maxPerSecond`, queuing and delaying the rest.
 * No `maxPerSecond` (the default) is a no-op — behavior is unchanged unless opted in.
 */
export declare class MnemonadRateLimiter {
	constructor(params?: { maxPerSecond?: number | null });
	maxPerSecond: number | null;
	run<T>(fn: () => Promise<T>): Promise<T>;
	/**
	 * Wraps a viem Public/Wallet client so `readContract`/`writeContract`/`getBlockNumber`/
	 * `waitForTransactionReceipt`/`getBalance` route through this limiter. Everything else on
	 * the client (chain, account, transport, other actions) passes through unchanged.
	 */
	wrapClient(client: unknown): unknown;
}

export interface ChunkCacheOptions {
	/** Default 300. */
	maxEntries?: number;
	/** Default 50 MB. */
	maxTotalBytes?: number;
	/** An entry larger than this is never cached at all. Default 8 MB. */
	maxEntryBytes?: number;
	/** Lets an app deliberately share or isolate caches. Default 'default'. */
	namespace?: string;
	/** Mainly for tests: an explicit backend, skipping auto-detection. */
	backend?: unknown;
	/** An explicit `IDBFactory` (e.g. `fake-indexeddb`'s) rather than the ambient global. */
	indexedDB?: unknown;
}

export declare const DEFAULT_CHUNK_CACHE_OPTIONS: Required<
	Omit<ChunkCacheOptions, 'backend' | 'indexedDB'>
>;

/**
 * Caches item payload bytes — on-chain or off-chain — so re-reading the same item skips the
 * network. IndexedDB in a browser, an in-memory Map elsewhere; LRU eviction by `maxEntries`
 * and `maxTotalBytes`, skipping anything over `maxEntryBytes` outright. Always stores
 * pre-decryption bytes; see the class's own file comment for why that's load-bearing.
 */
export declare class MnemonadChunkCache {
	constructor(options?: ChunkCacheOptions);
	maxEntries: number;
	maxTotalBytes: number;
	maxEntryBytes: number;
	namespace: string;
	get(key: string): Promise<Uint8Array | undefined>;
	set(key: string, bytes: Uint8Array): Promise<void>;
	clear(): Promise<void>;
	stats(): Promise<{ entryCount: number; totalBytes: number }>;
}

/** One entry in the process-wide RPC call log; see `getRpcCallLog`. */
export interface RpcCallLogEntry {
	/** 1-based, stable for this entry's lifetime — matches the count when it was made. */
	position: number;
	method: string;
	functionName: string | null;
	chainId: number | null;
	/** When the call was initiated, not when it settled. */
	at: number;
	/** Starts 'pending', settles in place once the underlying call resolves or rejects. */
	status: 'pending' | 'ok' | 'error';
	/** Set only once `status` becomes 'error'. */
	error: string | null;
}

/** Total RPC calls recorded so far this session, across every `debug: true` instance. */
export declare function getRpcCallCount(): number;
/** A copy of the most recent recorded calls (oldest first), capped at 2000 entries. */
export declare function getRpcCallLog(): RpcCallLogEntry[];
/**
 * Called once when a call is recorded ('pending'), and again when it settles ('ok'/'error') —
 * match on `entry.position` to tell an update from a new call. Returns an unsubscribe function.
 */
export declare function subscribeRpcCalls(
	fn: (info: { count: number; entry: RpcCallLogEntry }) => void
): () => void;
/** Clears the count and log. Does not affect subscriptions. */
export declare function resetRpcCalls(): void;

/** Encryption companion. */
export declare class MnemonadCrypto {
	readonly isEnabled: boolean;
	readonly isEncryptRequested: boolean;
	/** Default PBKDF2 iteration count new password streams get. */
	static readonly DEFAULT_PBKDF2_ITERATIONS: number;
	static generateAesKey(): Uint8Array;
	/** Generates a fresh salt for password-based key derivation. */
	static generatePasswordSalt(): Uint8Array;
	/** 0x-prefixed hex encoding of raw salt bytes. */
	static saltToHex(bytes: Uint8Array): string;
	setAesKey(key: Uint8Array): void;
	getAesKey(): Uint8Array | null;
	/** The salt in use for password-based key derivation, if any. */
	getPasswordSalt(): Uint8Array | null;
	/** The iteration count in use for password-based key derivation, or `null` when this
	 *  instance isn't using the password method at all. */
	getPasswordIterations(): number | null;
	/** This instance's stream-metadata `kek` block, or `null` when there isn't one to
	 *  publish (unencrypted, signer-based, or a password whose salt doesn't exist yet). */
	getPasswordKek(): StreamMetaKek | null;
	wrapAesKey(aesKey: Uint8Array, streamId?: bigint | null): Promise<Uint8Array>;
	unwrapAesKey(wrapped: Uint8Array, streamId?: bigint | null): Promise<Uint8Array>;
	/** Encrypts into independently-decryptable frames (STREAM construction). */
	encryptItem(plaintext: Uint8Array, params?: { log2FrameSize?: number }): Promise<Uint8Array>;
	decryptItem(payload: Uint8Array): Promise<Uint8Array>;
	/** Decrypts one frame in isolation — the primitive behind partial and streaming reads. */
	decryptFrame(
		frameCiphertext: Uint8Array,
		index: number,
		isFinal: boolean,
		layout: FrameLayout
	): Promise<Uint8Array>;
	/** Derives the frame layout from the 10-byte header plus the total ciphertext length. */
	static parseHeader(header: Uint8Array, ciphertextLength: number): FrameLayout;
	static parseLayout(payload: Uint8Array): FrameLayout;
	static framesForRange(
		layout: FrameLayout,
		start: number,
		len: number
	): { first: number; last: number };
	static cipherSpanForFrames(
		layout: FrameLayout,
		first: number,
		last: number
	): { offset: number; length: number };
	/** Ciphertext size an item of `plaintextLength` bytes will occupy. */
	static ciphertextLengthFor(plaintextLength: number, log2FrameSize?: number): number;
}

/** Frame layout of a framed-ciphertext item. */
export interface FrameLayout {
	version: number;
	frameSize: number;
	baseNonce: Uint8Array;
	frameCount: number;
	plaintextLength: number;
	ciphertextLength: number;
	headerBytes: number;
	frameOffset(i: number): number;
	frameCipherLength(i: number): number;
	framePlainOffset(i: number): number;
}

export declare class Mnemonad {
	constructor(params?: MnemonadParams);

	id: bigint | null;
	/** Total item count. Append-only: never decreases. */
	length: number;
	/** Total payload bytes across all items. */
	binaryLength: number;
	/** First readable index; advances on `truncateFrom`. */
	firstAvailableIndex: number;
	meta: Uint8Array | null;
	/** Wrapped encryption key, or null. */
	encKeyWrapped: Uint8Array | null;
	madeWithVersion: number | null;
	maxChunkBytes: number;
	/** Largest slice fetched per read call; items above this are paged. Default 512 KB. */
	readPageBytes: number;
	chainId: number | null;

	readonly contractAddress: string | null;
	readonly isWritable: boolean;
	/** The stream's own metadata (`{name, kek}`), decoded from raw `meta` on every access —
	 *  see `streamMeta.js`'s own doc. Requires `initialize()` to have already run. */
	readonly streamMeta: { name: string | null; kek: StreamMetaKek | null };

	offloadingProvider: MnemonadOffloadingProvider;
	crypto: MnemonadCrypto;

	static create(params: CreateParams): Promise<Mnemonad>;
	static getContractAddress(network: string): string | null;
	/** Computes a stream id without creating it — enables one-transaction encrypted create. */
	static computeStreamId(
		publicClient: unknown,
		contractAddress: string,
		creator: string,
		salt: string,
		maxRPCRequestsPerSecond?: number | null,
		rpcRetry?: MnemonadParams['rpcRetry']
	): Promise<bigint>;
	/**
	 * Lists stream ids currently owned by `owner`, via `ERC721Enumerable`'s per-owner index.
	 * All reads are pinned to one block number for a consistent snapshot.
	 */
	static listOwned(
		publicClient: unknown,
		contractAddress: string,
		owner: string,
		maxRPCRequestsPerSecond?: number | null,
		rpcRetry?: MnemonadParams['rpcRetry']
	): Promise<bigint[]>;

	initialize(): Promise<void>;
	reInitialize(): void;
	isEncrypted(): Promise<boolean>;
	/**
	 * Unlocks a password-encrypted stream in place: derives the KEK from `password` plus
	 * `passwordSalt`/`passwordIterations` (defaulting to this stream's own
	 * `streamMeta.kek` when omitted — the common case is just the password), unwraps
	 * `encKeyWrapped`, and adopts the result on `this.crypto` — every read through this
	 * instance decrypts from this point on. Throws on a wrong password (the wrapped key's
	 * GCM tag fails to verify), a stream with no wrapped key at all, or no salt available
	 * from either `params` or `streamMeta.kek`.
	 */
	unlockWithPassword(
		password: string,
		params?: { passwordSalt?: string | Uint8Array; passwordIterations?: number }
	): Promise<Uint8Array>;
	owner(): Promise<string>;
	/**
	 * Whether `address` (default: this instance's configured sender) can append to this
	 * stream right now. Resolves `false`, never rejects, when there's nothing to check.
	 */
	canWrite(address?: string): Promise<boolean>;

	/** Reads a whole item, paging automatically above `readPageBytes`. */
	at(i: number): Promise<Uint8Array>;
	/**
	 * Reads a byte range as plaintext. On an encrypted stream only the frames overlapping
	 * the range are fetched and decrypted, so random access costs one frame, not the item.
	 */
	readRange(i: number, start: number, len: number): Promise<Uint8Array>;
	/**
	 * Streams an item, or a window of one, as decrypted pieces — one frame (encrypted) or
	 * one page (plaintext) at a time, so an item larger than memory can be consumed.
	 */
	stream(i: number, params?: { start?: number; len?: number }): AsyncGenerator<Uint8Array>;
	/** Decrypted length of item `i`, which differs from the stored size when encrypted. */
	plaintextLengthAt(i: number): Promise<number>;
	itemAt(i: number): Promise<MnemonadItem>;
	/**
	 * Synchronous, fetch-free cache peek — see `MnemonadItem.isLoaded`. False if
	 * `itemAt(i)` hasn't resolved at all yet.
	 */
	isItemLoaded(i: number): boolean;
	pointerAt(i: number): Promise<Pointer>;
	getItemRefs(i: number): Promise<ItemRefs>;

	/** The registry's wired paid-upload gateway address, or the zero address if none. */
	uploadGateway(): Promise<string>;
	/**
	 * MON required to prepay the wired upload gateway for an off-chain payload of up to
	 * `size` bytes — the same gateway `push()` pays automatically for an oversized item.
	 * `null` when no gateway is wired; throws (a stale/uncertain Pyth price, typically)
	 * when one is wired but currently refuses to quote.
	 */
	quoteOffloadUpload(size: number): Promise<bigint | null>;

	/**
	 * The sha256 an offloaded push of `data` would record in its `Pointer.hash` — the value
	 * to commit to when prepaying through `MnemonadUploadGateway`. On an encrypted stream,
	 * `data` must already be the exact ciphertext that will be uploaded (pass
	 * `{ alreadyEncrypted: true }` and hand this `crypto.encryptItem(plaintext)`'s own
	 * output) — see this method's own doc comment in `Mnemonad.js` for the full sequence.
	 */
	offloadCommitment(
		data: Uint8Array,
		params?: { alreadyEncrypted?: boolean }
	): Promise<{ hash: string; size: number }>;

	push(arr: Uint8Array | Uint8Array[], params?: PushParams): Promise<boolean>;
	/** Packs a batch into one shared chunk, saving the per-chunk CREATE overhead. */
	pushMany(items: Uint8Array[], params?: PushParams): Promise<boolean>;
	pushExternal(data: Uint8Array, params?: PushParams): Promise<boolean>;

	/** Appends another stream's items by re-linking, not copying. Consumes the source. */
	concat(other: bigint | string | Mnemonad, params?: TxOptions): Promise<boolean>;
	/** Logical delete. Reclaims almost no gas — see PLAN.md §3.5. */
	truncateFrom(uptoIndex: number, params?: TxOptions): Promise<boolean>;
	burn(params?: TxOptions): Promise<boolean>;

	setEncKeyWrapped(wrapped: Uint8Array, params?: TxOptions): Promise<boolean>;
	/** Append rights, independent of ERC-721 transfer approval. */
	setWriterApproval(writer: string, approved: boolean, params?: TxOptions): Promise<boolean>;

	quotePushFee(size: number, store?: number): Promise<bigint>;
	/**
	 * Gas plus protocol fee. Matters on Monad: gas is charged on the limit, not usage.
	 * Mirrors `push()`'s own routing (single write / staged / IPFS) for the same
	 * `data`/`params`, including `{ onChain: true }` for an oversized item's staged path.
	 */
	estimatePushCost(
		data: Uint8Array,
		params?: {
			bufferPercent?: number;
			onChain?: boolean;
			itemMeta?: Uint8Array | null;
			name?: string | null;
			type?: string | null;
			alreadyEncrypted?: boolean;
		}
	): Promise<CostEstimate>;
}

/** See `streamMeta.js`'s own doc — a stream's decoded `kek` block, present only for a
 *  password-encrypted stream (a signer-encrypted one has no salt/iterations to publish). */
export interface StreamMetaKek {
	method: string;
	salt: string;
	iterations: number;
}

/**
 * Encodes a stream's `{name, kek}` metadata into its opaque on-chain `meta` bytes, gzipped
 * only when that's smaller than plain JSON (see `metaCodec.js`'s own doc for the measured
 * break-even). `undefined` when there's nothing to store at all.
 */
export declare function encodeStreamMeta(fields?: {
	name?: string | null;
	kek?: StreamMetaKek | null;
}): Uint8Array | undefined;

/** Reverses `encodeStreamMeta`, tolerant of legacy plain-text (pre-JSON) and ungzipped
 *  values already on chain from before this format existed. */
export declare function decodeStreamMeta(bytes?: Uint8Array | null): {
	name: string | null;
	kek: StreamMetaKek | null;
};

/**
 * Encodes an item's `{name, type}` metadata into its opaque on-chain `meta` bytes, gzipped
 * only when that's smaller than plain JSON. `undefined` when there's nothing to store.
 */
export declare function encodeItemMeta(fields?: {
	name?: string | null;
	type?: string | null;
}): Uint8Array | undefined;

/** Reverses `encodeItemMeta`. Unlike `decodeStreamMeta`, a non-JSON value is never treated
 *  as a legacy name — `meta` is a free-form per-item field with no such convention. */
export declare function decodeItemMeta(bytes?: Uint8Array | null): {
	name: string | null;
	type: string | null;
};

export default Mnemonad;
