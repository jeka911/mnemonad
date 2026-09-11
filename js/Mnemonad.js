import { sha256 } from '@noble/hashes/sha2.js';
import MnemonadItem, { Store } from './MnemonadItem.js';
import MnemonadIpfs from './offloading/MnemonadIpfs.js';
import MnemonadCrypto from './MnemonadCrypto.js';
import MnemonadRateLimiter from './MnemonadRateLimiter.js';
import { wrapClientForRecording } from './MnemonadRpcRecorder.js';
import MnemonadChunkCache from './MnemonadChunkCache.js';
import MnemonadUploadGateway from './MnemonadUploadGateway.js';
import { mnemonadAbi } from './abi.js';
import ids from './ids.js';
import { encodeStreamMeta, decodeStreamMeta } from './streamMeta.js';
import { encodeItemMeta } from './itemMeta.js';

/**
 * @typedef {import('viem').PublicClient} PublicClient
 * @typedef {import('viem').WalletClient} WalletClient
 */

/**
 * Should accept a viem contract-write request and return the executed transaction hash.
 * Exists to keep the SDK agnostic about how the caller signs.
 * @callback CustomSendTransactionFunction
 * @param {Object} request
 * @returns {Promise<string>}
 */

/**
 * SDK-expected contract version. A mismatch is refused rather than guessed at.
 *
 * v2 added the optional `uploadGateway` settlement hook to `pushExternal`. This SDK talks
 * to v2 only: a v1 registry is refused outright, so pointing it at a pre-gateway
 * deployment fails loudly instead of silently missing the prepaid-fee path.
 */
export const EXPECTED_CONTRACT_VERSION = 2;

/** Sentinel meaning "don't check the length" — matches `type(uint64).max` on-chain. */
const ANY_LENGTH = (1n << 64n) - 1n;

/**
 * Shared by chain id + rate + retry policy, so every Mnemonad instance (and static call)
 * configured identically for the same chain shares one budget. A fan-out read pattern —
 * several fields per stream, times several streams, all via `Promise.all` — needs the limit
 * enforced across instances, not per instance, or N independently-throttled instances still
 * add up to N × maxRPCRequestsPerSecond against the RPC. Public RPC endpoints commonly 429
 * exactly that burst. Retry policy is part of the key, not just the rate, because two
 * instances asking for different `rpcRetry` clearly want different retry behavior — sharing
 * a limiter between them would silently give one of them the other's policy instead.
 *
 * @param {number} maxPerSecond
 * @param {?number} chainId
 * @param {import('./MnemonadRateLimiter.js').default} [rpcRetry]
 * @returns {MnemonadRateLimiter}
 */
const _sharedRateLimiters = new Map();
function _getSharedRateLimiter(maxPerSecond, chainId, rpcRetry = {}) {
	const key = JSON.stringify({
		chainId: chainId ?? 'unknown',
		maxPerSecond,
		attempts: rpcRetry.attempts,
		baseDelayMs: rpcRetry.baseDelayMs,
		maxDelayMs: rpcRetry.maxDelayMs,
		jitter: rpcRetry.jitter,
	});
	let limiter = _sharedRateLimiters.get(key);
	if (!limiter) {
		limiter = new MnemonadRateLimiter({ maxPerSecond, ...rpcRetry });
		_sharedRateLimiters.set(key, limiter);
	}
	return limiter;
}

/**
 * Wraps `publicClient`/`walletClient` through the shared limiter for the chain.
 *
 * Always wraps, even with no `maxRPCRequestsPerSecond`. Pacing stays opt-in — a limiter
 * built without one admits every call immediately — but the wrapper also retries transient
 * RPC failures, and that is worth having whether or not the caller asked to be throttled: a
 * dropped connection or a 503 is no less transient for an unthrottled client. Reverts and
 * other deterministic errors are still not retried, so a test asserting one sees it at the
 * same speed as before.
 *
 * When `debug` is on, the pacing/retry wrap is itself wrapped one layer further out by
 * `MnemonadRpcRecorder`, so every logical call `Mnemonad` makes — one entry regardless of how
 * many times the limiter underneath retries it — lands in the process-wide RPC call log. Off
 * by default: recording is pure overhead for anything that isn't watching it.
 *
 * @param {?PublicClient} publicClient
 * @param {?WalletClient} walletClient
 * @param {?number} maxRPCRequestsPerSecond
 * @param {boolean} [debug=false]
 * @param {?{attempts?: number, baseDelayMs?: number, maxDelayMs?: number, jitter?: boolean}} [rpcRetry]
 *   - overrides `MnemonadRateLimiter`'s own retry defaults (4 attempts, ~1.75s total backoff).
 *   Still bounded, never infinite — see `Mnemonad`'s constructor doc for why.
 * @returns {{publicClient: ?PublicClient, walletClient: ?WalletClient}}
 */
function _rateLimitClients(publicClient, walletClient, maxRPCRequestsPerSecond, debug = false, rpcRetry = {}) {
	const chainId = publicClient?.chain?.id ?? walletClient?.chain?.id ?? null;
	const limiter = _getSharedRateLimiter(maxRPCRequestsPerSecond ?? null, chainId, rpcRetry);
	let wrappedPublic = publicClient ? limiter.wrapClient(publicClient) : publicClient;
	let wrappedWallet = walletClient ? limiter.wrapClient(walletClient) : walletClient;
	if (debug) {
		if (wrappedPublic) wrappedPublic = wrapClientForRecording(wrappedPublic, { chainId });
		if (wrappedWallet) wrappedWallet = wrapClientForRecording(wrappedWallet, { chainId });
	}
	return { publicClient: wrappedPublic, walletClient: wrappedWallet };
}

/**
 * Shared by its (canonicalized) options, same reasoning as `_getSharedRateLimiter`:
 * IndexedDB durability is the whole point of this cache, and a cache scoped to one
 * `Mnemonad` instance would defeat it by dying with that instance. Two instances configured
 * with the same `cacheOptions` share one cache; different options (or an explicit
 * `namespace`) get their own, deliberately — the namespace exists for exactly this, letting
 * an app isolate caches on purpose rather than only by accident of differing options.
 *
 * @param {import('./MnemonadChunkCache.js').ChunkCacheOptions} options
 * @returns {MnemonadChunkCache}
 */
/**
 * Shared by chain id + contract address: `CONTRACT_VERSION` and `maxChunkBytes` are immutable
 * contract constants, so once one `Mnemonad` instance has read them for a given deployment,
 * no other instance pointed at the same one ever needs to ask again. Without this, every
 * fresh instance an app constructs — a new page load, a new write action, `Mnemonad.create()`
 * — repeats both reads for no reason, since neither value can ever change for an already
 * deployed, immutable contract. Same reasoning as `_getSharedRateLimiter`/`_getSharedChunkCache`.
 *
 * @type {Map<string, {madeWithVersion: number, maxChunkBytes: number}>}
 */
const _sharedContractConstants = new Map();
function _contractConstantsKey(chainId, contractAddress) {
	return `${chainId ?? 'unknown'}:${contractAddress}`;
}

const _sharedChunkCaches = new Map();
function _getSharedChunkCache(options) {
	const key = JSON.stringify({
		maxEntries: options.maxEntries,
		maxTotalBytes: options.maxTotalBytes,
		maxEntryBytes: options.maxEntryBytes,
		namespace: options.namespace,
	});
	let cache = _sharedChunkCaches.get(key);
	if (!cache) {
		cache = new MnemonadChunkCache(options);
		_sharedChunkCaches.set(key, cache);
	}
	return cache;
}

/**
 * Represents a Mnemonad stream: a scalable append-only on-chain `bytes[]`.
 *
 * Items too large for a single transaction are staged across several; items too large for
 * on-chain storage altogether can be offloaded to IPFS. See PLAN.md for the storage-tier
 * cost model this is built around, and §3.5 for why deletion is logical-only
 * (`truncateFrom()`) rather than a way to reclaim gas.
 */
export default class Mnemonad {
	/**
	 * @param {Object} params
	 * @param {PublicClient} [params.publicClient] - viem public client, for reads
	 * @param {bigint|string} [params.id] - stream id (ERC-721 token id)
	 * @param {?string} [params.contractAddress] - registry address, or 'monadTestnet'/'monadMainnet'
	 * @param {?WalletClient} [params.walletClient] - adds write capability
	 * @param {?CustomSendTransactionFunction} [params.sendTransaction] - adds write capability
	 * @param {?string} [params.senderAddress] - sender address; inferred from walletClient if absent
	 * @param {?string} [params.gatewayUrl] - IPFS gateway for reads
	 * @param {?string} [params.pinningUrl] - IPFS pinning endpoint for writes
	 * @param {?string} [params.pinningJwt] - bearer token for the pinning endpoint
	 * @param {?Object} [params.ipfsClient] - custom IPFS transport `{ put, get }`
	 * @param {?import('./offloading/MnemonadOffloadingProvider.js').default} [params.offloadingProvider] -
	 *   a pre-built off-chain storage provider (`MnemonadPinataProvider`, a custom subclass
	 *   of `MnemonadOffloadingProvider`, or a future Filecoin/Walrus one) — takes over from
	 *   `gatewayUrl`/`pinningUrl`/`pinningJwt`/`ipfsClient` entirely when given
	 * @param {?Object} [params.signer] - signer used to wrap/unwrap the encryption key
	 * @param {?Uint8Array} [params.aesKey] - pre-known data key, skips unwrapping
	 * @param {?string} [params.password] - plaintext password; an alternative to `signer`
	 *   for wrapping/unwrapping the encryption key. See `MnemonadCrypto`'s constructor doc
	 *   for the full behavior, including `passwordSalt`/`passwordIterations`.
	 * @param {?(string|Uint8Array)} [params.passwordSalt] - salt for the password KDF;
	 *   required to unwrap, generated fresh if omitted when wrapping (see `MnemonadCrypto`).
	 * @param {?number} [params.passwordIterations] - PBKDF2 iteration count; see
	 *   `MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS`.
	 * @param {?number} [params.maxRPCRequestsPerSecond] - caps outbound RPC calls, queuing
	 *   the rest rather than firing them all at once. Shared across every instance
	 *   configured with the same rate on the same chain (see `_getSharedRateLimiter`) — a
	 *   fan-out read over many streams needs one budget, not one per stream. Omit for
	 *   unlimited (the default); public RPC endpoints commonly 429 an unthrottled fan-out.
	 * @param {boolean|Object} [params.cache] - `false`/`null` disables item-payload caching
	 *   entirely; an object with `get`/`set` is used as a custom cache verbatim; omit for the
	 *   shared default (see `MnemonadChunkCache`).
	 * @param {import('./MnemonadChunkCache.js').ChunkCacheOptions} [params.cacheOptions] -
	 *   tunes the shared default cache (`maxEntries`, `maxTotalBytes`, `maxEntryBytes`,
	 *   `namespace`); ignored if `params.cache` is set.
	 * @param {boolean} [params.debug=false] - when true, every RPC call this instance makes
	 *   (`readContract`, `writeContract`, `getBlockNumber`, ...) is recorded into
	 *   `MnemonadRpcRecorder`'s process-wide log — see `getRpcCallCount`/`subscribeRpcCalls`.
	 *   Off by default; purely observational, no effect on caching or pacing.
	 * @param {?{attempts?: number, baseDelayMs?: number, maxDelayMs?: number, jitter?: boolean}}
	 *   [params.rpcRetry] - overrides how hard a read retries a transient RPC failure (writes
	 *   are never retried, regardless — see `MnemonadRateLimiter`'s own doc). Omit for the
	 *   class defaults (4 attempts, backing off 250ms→500ms→1000ms, ~1.75s total). Raising
	 *   `attempts`/`maxDelayMs` tolerates a longer rate-limit window on a busy public RPC —
	 *   still bounded, never infinite: an app that wants a failure to eventually surface
	 *   rather than retry forever with no way to cancel needs *some* ceiling. Shared across
	 *   every instance configured identically for the same chain + rate, same as
	 *   `maxRPCRequestsPerSecond` (see `_getSharedRateLimiter`).
	 */
	constructor(params = {}) {
		const { publicClient, walletClient } = _rateLimitClients(
			params.publicClient,
			params.walletClient,
			params.maxRPCRequestsPerSecond,
			!!params.debug,
			params.rpcRetry || {}
		);

		/** @type {PublicClient} */
		this.publicClient = publicClient;
		/** @type {?bigint} */
		this.id = params.id === undefined || params.id === null ? null : BigInt(params.id);

		/** @type {number} Total item count. Append-only: never decreases. */
		this.length = 0;
		/** @type {number} Total payload bytes across all items. */
		this.binaryLength = 0;
		/** @type {number} First readable index. Advances on `truncateFrom`. */
		this.firstAvailableIndex = 0;
		/** @type {?Uint8Array} Stream-level metadata. */
		this.meta = null;
		/** @type {?Uint8Array} Wrapped encryption key, or null if unencrypted. */
		this.encKeyWrapped = null;
		/** @type {?number} Contract version the stream was created with. */
		this.madeWithVersion = null;

		/**
		 * @type {number} Max payload the registry will accept into a single on-chain chunk.
		 * From chain — bounded by `MAX_CHUNK_BYTES_CEILING` (64 KiB as of this writing; see
		 * that constant's own comment for why the contract deliberately holds this well
		 * under Monad's 128 KB code-size cap).
		 *
		 * This is a ceiling, not a routing target: the contract has no opinion on whether
		 * something *under* this size should go on-chain at all. `push()` only reaches for
		 * IPFS when a payload doesn't fit here — it never chooses to offload something
		 * smaller just because that might be cheaper. Whether it's worth doing so is a real
		 * question this class doesn't answer today (it needs gas price and off-chain pinning
		 * cost together, which only a caller has both sides of) — a future `push()` or an
		 * explicit `{ preferOffload: true }`-style option would be the place to add it.
		 */
		this.maxChunkBytes = 0;
		/**
		 * @type {number} Largest slice fetched per read call. Items above this are read in
		 * pages. Default 512 KB — comfortably inside Monad's 8 MB per-transaction memory
		 * cap, which is what bounds a one-shot `at()` rather than gas.
		 */
		this.readPageBytes = params.readPageBytes || 512 * 1024;
		/**
		 * @type {boolean} Allow ranged fetches of PLAINTEXT off-chain items, whose bytes
		 * cannot be checked against the pointer's whole-blob hash. Off by default: an
		 * unverified read from an untrusted gateway should be a deliberate choice.
		 * Encrypted items ignore this — their frames are individually authenticated.
		 */
		this.allowUnverifiedRanges = params.allowUnverifiedRanges ?? false;
		/** @type {?number} */
		this.chainId = null;
		/** @type {Object<number, MnemonadItem>} */
		this._items = {};

		/** @type {boolean} */
		this._isInitialized = false;
		/** @type {boolean} */
		this._constantsLoaded = false;

		/** @type {?string} */
		this._contractAddress = params.contractAddress || null;
		const known = ids[this._contractAddress];
		if (known) this._contractAddress = known.contractAddress;

		/** @type {?WalletClient} */
		this._walletClient = walletClient || null;
		/** @type {?CustomSendTransactionFunction} */
		this._sendTransaction = params.sendTransaction || null;
		/** @type {?string} */
		this._senderAddress =
			params.senderAddress || walletClient?.account?.address || null;

		/**
		 * Off-chain storage companion. Always present; only active when a transport was
		 * supplied. Defaults to `MnemonadIpfs` built from loose params (`gatewayUrl`,
		 * `pinningUrl`, `pinningJwt`, `ipfsClient`) exactly as before; pass a pre-built
		 * `MnemonadOffloadingProvider` instance instead — `new MnemonadPinataProvider(...)`,
		 * a future Filecoin/Walrus provider, or your own subclass — to use anything else.
		 * @type {import('./offloading/MnemonadOffloadingProvider.js').default}
		 */
		this.offloadingProvider = params.offloadingProvider || new MnemonadIpfs({ ...params });
		this.offloadingProvider.attach(this);

		/**
		 * Encryption companion. Always present; only active when a signer or key was
		 * supplied.
		 * @type {MnemonadCrypto}
		 */
		this.crypto = new MnemonadCrypto({ ...params, mnemonad: this });

		/**
		 * Caches item payload bytes — pre-decryption, exactly as fetched from chain or IPFS;
		 * see `MnemonadChunkCache`'s own file comment for why that matters. Consulted by
		 * `_readItemBytes` (on-chain) and `MnemonadIpfs.readPointerBytes` (off-chain, via
		 * `this._mnemonad`). `params.cache`:
		 *   - omitted → the shared default for `params.cacheOptions` (IndexedDB in a browser,
		 *     an in-memory Map elsewhere — see `_getSharedChunkCache`).
		 *   - `false`/`null` → disabled outright, no caching at all.
		 *   - anything else (an object with `get`/`set`) → used exactly as given, not shared.
		 * @type {?{get: Function, set: Function}}
		 */
		if (params.cache === false || params.cache === null) {
			this._chunkCache = null;
		} else if (params.cache && typeof params.cache === 'object') {
			this._chunkCache = params.cache;
		} else {
			this._chunkCache = _getSharedChunkCache(params.cacheOptions || {});
		}
	}

	/** @returns {?string} The registry contract address. */
	get contractAddress() {
		return this._contractAddress;
	}

	/**
	 * @param {string} network - 'monadTestnet' or 'monadMainnet'
	 * @returns {?string}
	 */
	static getContractAddress(network) {
		const entry = ids[network];
		return entry ? entry.contractAddress : null;
	}

	/**
	 * True iff this instance can write: reads need only a client and an id; writes
	 * additionally need an address and a way to send.
	 * @returns {boolean}
	 */
	get isWritable() {
		return !!(this._contractAddress && (this._sendTransaction || this._walletClient));
	}

	/**
	 * The stream's own metadata (`{name, kek}`), decoded from raw `this.meta` on every
	 * access — see `streamMeta.js`'s own doc for the wire format. A getter rather than a
	 * cached field: `meta` is set once during `initialize()` and never changes afterward
	 * for a given instance, so there's no staleness to worry about, and decoding a payload
	 * this small costs nothing worth caching for. Requires `initialize()` to have already
	 * run (same as `encKeyWrapped`/`length`/every other field `initialize()` populates) —
	 * unlike those, reading this before then doesn't throw, it just decodes an empty
	 * `this.meta` into `{ name: null, kek: null }`.
	 * @returns {{name: ?string, kek: ?{method: string, salt: string, iterations: number}}}
	 */
	get streamMeta() {
		return decodeStreamMeta(this.meta);
	}

	/**
	 * @returns {Promise<boolean>} Whether the stream carries an encryption key on-chain.
	 */
	async isEncrypted() {
		await this.initialize();
		return !!(this.encKeyWrapped && this.encKeyWrapped.length > 0);
	}

	/**
	 * Unlocks a password-encrypted stream in place: derives the key-encryption key from
	 * `password` plus `passwordSalt`/`passwordIterations`, unwraps `encKeyWrapped`, and
	 * adopts the resulting data key on `this.crypto` — every read through this instance
	 * decrypts from this point on, with no separate `setAesKey` call needed.
	 *
	 * The salt/iterations default to this stream's own `streamMeta.kek` (see that getter's
	 * own doc) — the metadata `create()` already publishes them into for exactly this
	 * reason — so the common case is just the password, nothing else:
	 *
	 * ```js
	 * await ev.unlockWithPassword(userTypedPassword);
	 * ```
	 *
	 * `params.passwordSalt`/`params.passwordIterations` are still there as an override, for
	 * a caller keeping those two values somewhere other than this stream's own metadata
	 * (a database, a URL fragment — the SDK stays agnostic about where, same as before);
	 * an explicit value always wins over whatever `streamMeta.kek` reports.
	 *
	 * A wrong password is caught here, not left to surface confusingly later:
	 * `unwrapAesKey`'s AES-GCM tag check is itself the validity check (see its own doc), so
	 * a bad password throws immediately rather than silently adopting garbage.
	 *
	 * Not a client concern: this exists so a caller (a UI's "enter password" dialog, most
	 * commonly) never has to read back `streamMeta.kek` itself, construct its own throwaway
	 * `MnemonadCrypto`, or reach into `this.crypto` directly just to unlock — same
	 * reasoning `push()` owns encryption rather than leaving it to the caller (see that
	 * method's own doc).
	 *
	 * @param {string} password
	 * @param {Object} [params={}]
	 * @param {(string|Uint8Array)} [params.passwordSalt] - overrides `streamMeta.kek.salt`
	 * @param {?number} [params.passwordIterations] - overrides `streamMeta.kek.iterations`
	 * @returns {Promise<Uint8Array>} the unwrapped data key — the same value
	 *   `this.crypto.getAesKey()` returns from now on, handed back so a caller can also
	 *   cache it (e.g. a per-session key store) without a second read.
	 * @throws {Error} If this stream has no wrapped key at all, if neither an explicit
	 *   `passwordSalt` nor a `streamMeta.kek` block is available, or if the password is
	 *   wrong.
	 */
	async unlockWithPassword(password, params = {}) {
		await this.initialize();
		if (!this.encKeyWrapped || !this.encKeyWrapped.length) {
			throw new Error('unlockWithPassword: this stream has no wrapped key to unlock');
		}
		const kek = this.streamMeta.kek;
		const passwordSalt = params.passwordSalt ?? kek?.salt;
		const passwordIterations = params.passwordIterations ?? kek?.iterations;
		if (!passwordSalt) {
			throw new Error(
				'unlockWithPassword: no passwordSalt given, and this stream\'s own metadata ' +
				'has no kek block to read one from — pass passwordSalt explicitly if it\'s ' +
				'kept somewhere else.'
			);
		}
		const crypto = new MnemonadCrypto({ mnemonad: this, password, passwordSalt, passwordIterations });
		const aesKey = await crypto.unwrapAesKey(this.encKeyWrapped);
		this.crypto.setAesKey(aesKey);
		return aesKey;
	}

	// -----------------------------------------------------------------------------
	// Creation
	// -----------------------------------------------------------------------------

	/**
	 * Computes the id a creator/salt pair will produce, without touching the chain.
	 *
	 * This is the mechanism behind single-transaction encrypted creation: because the id is
	 * known in advance, the data key can be wrapped scoped to a stream that doesn't exist
	 * yet, so create, key-wrap, and initial push all happen in one transaction with no
	 * round trip needed first to learn what id a create call would produce.
	 *
	 * @param {string} creator
	 * @param {string} salt - 0x-prefixed 32-byte hex
	 * @param {?number} [maxRPCRequestsPerSecond] - see the constructor's param of the same name
	 * @param {?Object} [rpcRetry] - see the constructor's `params.rpcRetry`
	 * @returns {bigint}
	 */
	static async computeStreamId(publicClient, contractAddress, creator, salt, maxRPCRequestsPerSecond, rpcRetry) {
		({ publicClient } = _rateLimitClients(publicClient, null, maxRPCRequestsPerSecond, false, rpcRetry || {}));
		return await publicClient.readContract({
			address: contractAddress,
			abi: mnemonadAbi,
			functionName: 'streamIdFor',
			args: [creator, salt],
		});
	}

	/**
	 * Lists stream ids currently owned by `owner`, via `ERC721Enumerable`'s per-owner index —
	 * a direct on-chain read, not an off-chain event-log scan. Needed because ids are
	 * deterministic (see `computeStreamId`/`streamIdFor`), so there is no `0..totalSupply`
	 * walk that would find them without this index.
	 *
	 * All reads are pinned to one block number, since `tokenOfOwnerByIndex` reads into an
	 * array that reorders (swap-and-pop) whenever a token leaves an owner — without pinning,
	 * a transfer landing between the `balanceOf` call and a later index read could skip or
	 * duplicate an id. `cacheTime: 0` matters here: viem caches `getBlockNumber` for
	 * `client.cacheTime` (default ~4s), so an unqualified call can silently hand back a
	 * block from seconds ago on a long-lived client — pinning to a stale block is worse than
	 * not pinning at all, since a caller has no way to tell it happened.
	 *
	 * @param {PublicClient} publicClient
	 * @param {string} contractAddress
	 * @param {string} owner
	 * @param {?number} [maxRPCRequestsPerSecond] - see the constructor's param of the same name.
	 *   Worth setting here specifically: this method's own fan-out (one call per owned
	 *   stream) is exactly the burst shape that trips a public RPC's rate limit.
	 * @param {?Object} [rpcRetry] - see the constructor's `params.rpcRetry`. Worth raising
	 *   here for the same reason as `maxRPCRequestsPerSecond` above.
	 * @returns {Promise<bigint[]>}
	 */
	/**
	 * Puts an arbitrary viem client behind the same shared limiter Mnemonad instances use,
	 * so its reads are paced and retried on the same budget.
	 *
	 * For code that talks to the chain directly rather than through a Mnemonad — reading a
	 * registry field, driving `MnemonadUploadGateway` — which would otherwise be the one
	 * unprotected path in an application that is careful everywhere else. Sharing the budget
	 * is the point: a private limiter would pace its own calls perfectly while still pushing
	 * the endpoint over its limit in combination with everything else.
	 *
	 * Wrapping an already-wrapped client returns it unchanged.
	 *
	 * @param {Object} client - a viem Public or Wallet client
	 * @param {?number} [maxRPCRequestsPerSecond] - omit for retry without pacing.
	 * @param {?Object} [rpcRetry] - see the constructor's `params.rpcRetry`.
	 * @returns {Object}
	 */
	static wrapClient(client, maxRPCRequestsPerSecond, rpcRetry) {
		return _rateLimitClients(client, null, maxRPCRequestsPerSecond, false, rpcRetry || {}).publicClient;
	}

	static async listOwned(publicClient, contractAddress, owner, maxRPCRequestsPerSecond, rpcRetry) {
		({ publicClient } = _rateLimitClients(publicClient, null, maxRPCRequestsPerSecond, false, rpcRetry || {}));
		const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
		const balance = await publicClient.readContract({
			address: contractAddress,
			abi: mnemonadAbi,
			functionName: 'balanceOf',
			args: [owner],
			blockNumber,
		});
		const reads = [];
		for (let i = 0n; i < balance; i += 1n) {
			reads.push(
				publicClient.readContract({
					address: contractAddress,
					abi: mnemonadAbi,
					functionName: 'tokenOfOwnerByIndex',
					args: [owner, i],
					blockNumber,
				})
			);
		}
		return Promise.all(reads);
	}

	/**
	 * Creates a new stream on-chain and returns a wrapped instance.
	 *
	 * @param {Object} params - every constructor param, plus:
	 * @param {?Uint8Array|Uint8Array[]} [params.array] - initial item(s) to push
	 * @param {?string} [params.salt] - 0x-prefixed 32-byte hex; random if omitted
	 * @param {?Uint8Array} [params.meta] - raw stream-level metadata bytes, for a caller
	 *   that wants full control over the on-chain format. Wins outright over `name` below
	 *   when given. Most callers want `name` instead — see `streamMeta.js`'s own doc for
	 *   the format this builds automatically when `meta` is omitted.
	 * @param {?string} [params.name] - optional stream name, encoded (via `encodeStreamMeta`,
	 *   gzipped on-chain when that's smaller) into `meta` automatically alongside this
	 *   stream's own password KEK block, if it has one (see `MnemonadCrypto.getPasswordKek`)
	 *   — a caller using `password` below never has to build or encode that block itself.
	 *   Ignored when `meta` is given directly.
	 * @param {boolean} [params.encrypt=false] - create an encrypted stream. Requires either
	 *   `signer` or `password` (see the constructor's params, and `MnemonadCrypto`'s own doc
	 *   for what each KEK method means for transferability and recovery).
	 * @param {?Object} [params.options] - transaction options
	 * @param {?number} [params.options.timeout] - receipt timeout in ms (default 30000)
	 * @param {?number} [params.options.pollIntervalMs] - receipt poll interval (default 200)
	 * @returns {Promise<Mnemonad>}
	 */
	static async create(params) {
		const { publicClient, array, options = {} } = params;

		let contractAddress = params.contractAddress;
		const known = ids[contractAddress];
		if (known) contractAddress = known.contractAddress;

		if (!publicClient) throw new Error('publicClient is required');
		if (!contractAddress) throw new Error('contractAddress is required');
		if (!params.sendTransaction && !params.walletClient) {
			throw new Error('sendTransaction or walletClient is required');
		}

		const salt = params.salt || randomSalt();
		const ev = new Mnemonad({ ...params, contractAddress, id: null });
		await ev._loadConstants();

		const creator = ev._requireSender();
		const id = await Mnemonad.computeStreamId(
			publicClient,
			contractAddress,
			creator,
			salt
		);
		ev.id = id;

		// Encryption is set up BEFORE the creating transaction, not after: the id is
		// already known, so the wrapped key can go into `create()` itself. Any initial
		// items are encrypted in the same pass.
		let encKeyWrapped = '0x';
		if (params.encrypt) {
			const aesKey = MnemonadCrypto.generateAesKey();
			ev.crypto.setAesKey(aesKey);
			const wrapped = await ev.crypto.wrapAesKey(aesKey, id);
			encKeyWrapped = bytesToHex(wrapped);
		}

		// Built here, not by the caller: `getPasswordKek()` only has a real answer once
		// `wrapAesKey()` above has actually run (that's what derives/generates the salt),
		// which is exactly why this can't happen any earlier. `params.meta` (raw bytes)
		// always wins outright when given — this only ever fills in for a caller that
		// didn't hand over pre-built bytes itself.
		const meta = params.meta !== undefined
			? params.meta
			: encodeStreamMeta({ name: params.name, kek: ev.crypto.getPasswordKek() });

		// Only items that fit a single chunk can ride along with creation; anything larger
		// needs the staged path, so it is pushed separately afterwards.
		const initial = normalizeArray(array);
		const inline = [];
		const deferred = [];
		for (const item of initial) {
			const payload = params.encrypt ? await ev.crypto.encryptItem(item) : item;
			if (payload.length <= ev.maxChunkBytes) inline.push(payload);
			else deferred.push(item);
		}

		const fee = await ev.quotePushFee(
			inline.reduce((sum, b) => sum + b.length, 0),
			Store.CODE
		);

		await ev._write(
			'create',
			[salt, bytesToHex(meta || new Uint8Array()), encKeyWrapped, inline.map(bytesToHex)],
			{ value: fee, ...options }
		);

		ev.reInitialize();
		for (const item of deferred) {
			await ev.push(item, options);
		}

		return ev;
	}

	// -----------------------------------------------------------------------------
	// Reading
	// -----------------------------------------------------------------------------

	/**
	 * Loads metadata from chain. Most read methods call this internally.
	 * @returns {Promise<void>}
	 */
	async initialize() {
		if (this._isInitialized) return;
		if (!this.publicClient) throw new Error('publicClient is required');
		if (this.id === null) throw new Error('id is required');

		// Guard against concurrent initialisation.
		if (this.__initializationPromise) return await this.__initializationPromise;
		let resolver;
		this.__initializationPromise = new Promise((res) => { resolver = res; });

		if (!this._contractAddress) throw new Error('contractAddress is required');

		// One batch for everything this needs — constants (unless another instance already
		// loaded them, on this chain+contract, and left them in the shared cache) alongside
		// the stream's own fields, which now cost one `getStreamInfo` call instead of five
		// separate ones (`length`/`binaryLength`/`firstAvailableIndex`/`streamMeta`/
		// `encKeyWrapped` — removed from the contract; see `getStreamInfo`'s own comment in
		// Mnemonad.sol for why folding them in was worth the one-time API break). None of
		// these reads depend on each other's values, only the version check below depends on
		// having read them, so there's no reason to pay for a second round trip's latency
		// (and, with the transport's JSON-RPC batching enabled, a second HTTP request) just
		// to validate before reading the rest.
		const needsConstants = !this._constantsLoaded && !this._applyCachedConstants();
		const [info, version, maxChunk] = await Promise.all([
			this._read('getStreamInfo', [this.id]),
			needsConstants ? this._read('CONTRACT_VERSION', []) : Promise.resolve(null),
			needsConstants ? this._read('maxChunkBytes', []) : Promise.resolve(null),
		]);
		const [len, binLen, firstIdx, meta, encKey] = info;

		if (needsConstants) {
			await this._applyConstants([version, maxChunk]);
		}

		this.length = Number(len);
		this.binaryLength = Number(binLen);
		this.firstAvailableIndex = Number(firstIdx);
		this.meta = hexToBytes(meta);
		const key = hexToBytes(encKey);
		this.encKeyWrapped = key.length > 0 ? key : null;

		this._isInitialized = true;
		resolver();
		delete this.__initializationPromise;
	}

	/** Marks the instance stale so the next operation re-fetches from chain. */
	reInitialize() {
		this._isInitialized = false;
		this._items = {};
		this._layouts = {};
		this._externalCache = {};
	}

	/**
	 * Reads the item at a zero-based index, decrypting and fetching from IPFS as needed.
	 * The one place in this SDK that actually decrypts (along with `readRange()` and
	 * `stream()`, which this itself uses for anything past a single whole-item fetch) —
	 * `MnemonadItem.bytes()` delegates here rather than duplicating any of this, so an
	 * item's content is the same whichever of the two a caller reaches for.
	 *
	 * On-chain items up to `readPageBytes` go through the durable chunk cache
	 * (`_readItemBytes`) — the cached bytes are always pre-decryption ciphertext (see
	 * `docs/caching.md`'s own rule for why: never cache plaintext), decrypted fresh on
	 * every call via `crypto.decryptItem`. Larger on-chain items fall through to the paged
	 * frame-by-frame path below instead (staying uncached — see that path's own comment),
	 * since `_readItemBytes`'s single unpaged contract call can run out of gas above that
	 * size. A *partial* read (`readRange`/`stream(i, {start, len})`) isn't cached either
	 * way — see those methods' own comments; only a genuinely whole-item read within the
	 * size threshold benefits.
	 *
	 * EXTERNAL items are deliberately NOT routed through this whole-blob cache path: they
	 * already get the equivalent benefit from `MnemonadIpfs.readPointerBytes`'s own
	 * content-addressed cache (via `_prefetchExternal`), and staying on the frame-by-frame
	 * `stream()` path here means one authenticated frame in memory at a time rather than
	 * committing to a second whole-ciphertext buffer alongside the one `stream()` already
	 * builds internally.
	 *
	 * @param {number} i
	 * @param {Object} [params={}]
	 * @param {?Object} [params._refs] - internal-only (same convention as `stream()`'s
	 *   own `params._refs`) — a `getItemRefs(i)` result already in hand, e.g. from
	 *   `MnemonadItem.bytes()`, which already knows its own `store`/`size` from the
	 *   `itemAt()` call that constructed it and would otherwise make this re-derive the
	 *   exact same thing a second time.
	 * @returns {Promise<Uint8Array>}
	 */
	async at(i, params = {}) {
		await this.initialize();

		if (this.encKeyWrapped && this.crypto.isEnabled) {
			// getItemRefs, not a raw itemStore read: refs are already cached (e.g. by a
			// prior itemAt() — which a list view calls for every row up front, before any
			// individual at() is ever requested), so this line costs nothing extra once
			// warm, rather than paying for an uncached store lookup on every single call.
			const refs = params._refs ?? await this.getItemRefs(i);
			// _readItemBytes is a single, unpaged contract call — safe (and cacheable) for
			// anything within readPageBytes, same threshold _atRaw uses to decide the same
			// question for a plaintext item. Above it, a staged item spanning many chunks
			// can run the call out of gas, so large on-chain items fall through to the
			// paged frame-by-frame path below, same as before this cache path existed.
			if (refs.store !== Store.EXTERNAL && refs.size <= this.readPageBytes) {
				const ciphertext = await this._readItemBytes(i);
				return await this.crypto.decryptItem(ciphertext);
			}

			// An off-chain payload is fetched and hash-verified before its layout header is
			// consulted, so a substituted blob is reported as a hash mismatch rather than
			// as a confusing format error from a header that was never trustworthy.
			await this._prefetchExternal(i, refs);

			// Stream the frames rather than pulling the whole ciphertext and decrypting in
			// one go: only one frame is authenticated at a time, and only one buffer of
			// plaintext is held. Also how a large on-chain item (too big to safely fetch in
			// a single call above) gets paged — readRange, not a raw at() call.
			const layout = await this._cipherLayout(i, refs);
			const out = new Uint8Array(layout.plaintextLength);
			let pos = 0;
			// `_refs` is an internal-only field (same convention as `alreadyEncrypted`
			// elsewhere in this file) — hands stream() the lookup already made two lines
			// up instead of it repeating the same getItemRefs call a second time.
			for await (const part of this.stream(i, { _refs: refs })) {
				out.set(part, pos);
				pos += part.length;
			}
			return out;
		}

		return await this._atRaw(i, params._refs);
	}

	/**
	 * Reads the item at `i` without decrypting, paging automatically when it is too large
	 * for a single call.
	 * @param {number} i
	 * @param {?Object} [refs] - see `at()`'s own doc on `params._refs`.
	 * @returns {Promise<Uint8Array>}
	 */
	async _atRaw(i, refs = null) {
		await this.initialize();
		refs ??= await this.getItemRefs(i);

		if (refs.store === Store.EXTERNAL) {
			const pointer = await this.pointerAt(i);
			return await this.offloadingProvider.readPointerBytes(pointer);
		}

		const size = refs.size;
		if (size <= this.readPageBytes) {
			// _readItemBytes, not a raw _read('at', ...) call — same durable chunk cache
			// the encrypted branch of at() already uses, so a repeat call (or a repeat
			// call via the OTHER route to the same bytes, itemAt().bytes()) is free either
			// way, and both share one cache entry per index regardless of which read this
			// item first.
			return await this._readItemBytes(i);
		}

		// Paged read. A single `at()` allocates the item and the ABI return copies it, so
		// it needs roughly 2× the item size in memory — against Monad's 8 MB
		// per-transaction cap that caps one-shot reads near 3–4 MB. Paging removes the
		// ceiling entirely.
		const out = new Uint8Array(size);
		for (let offset = 0; offset < size; offset += this.readPageBytes) {
			const len = Math.min(this.readPageBytes, size - offset);
			const page = hexToBytes(
				await this._read('readRange', [this.id, BigInt(i), BigInt(offset), BigInt(len)])
			);
			if (page.length !== len) {
				throw new Error(
					`readRange returned ${page.length} bytes, expected ${len} at offset ${offset}`
				);
			}
			out.set(page, offset);
		}
		return out;
	}

	/**
	 * Reads a byte range of item `i`, returning plaintext.
	 *
	 * On an encrypted stream this fetches only the frames covering the requested range and
	 * decrypts those — so reading the first kilobyte of a 4 MB item costs one frame, not
	 * the whole item. Random access works the same whether the stream is encrypted or not,
	 * which is the point of the framed format.
	 *
	 * @param {number} i
	 * @param {number} start
	 * @param {number} len
	 * @returns {Promise<Uint8Array>}
	 */
	async readRange(i, start, len) {
		await this.initialize();

		if (this.encKeyWrapped && this.crypto.isEnabled) {
			const chunks = [];
			for await (const part of this.stream(i, { start, len })) chunks.push(part);
			return concatBytes(chunks, len);
		}

		return await this._readRangeRaw(i, start, len);
	}

	/**
	 * Reads a byte range of the stored bytes, without decrypting.
	 *
	 * Called once per frame by `stream()`'s loop for an encrypted item — which is every
	 * on-chain frame *and* every external one, since framing is what makes partial reads of
	 * a large encrypted item possible in the first place. An item's tier never changes once
	 * committed, so re-deriving it from `getItemRefs` (already cached — see
	 * `docs/caching.md`) instead of a raw, uncached `itemStore` read turns what used to be
	 * one RPC call per frame into effectively zero once the first frame has warmed the
	 * cache — confirmed live: downloading one ~100 KB external+encrypted item previously
	 * burned a couple dozen `itemStore` calls in the RPC log for what should cost none.
	 * @param {number} i
	 * @param {number} start
	 * @param {number} len
	 * @returns {Promise<Uint8Array>}
	 */
	async _readRangeRaw(i, start, len, refs = null) {
		await this.initialize();
		// `refs`, when passed, is a lookup already made by the caller (stream()'s loop
		// fetches it once for the whole generator, not once per frame/page it then calls
		// this with) — self-fetching only when called standalone. Deliberately not relying
		// on getItemRefs' own cache alone to collapse the redundant lookups: its write is
		// fire-and-forget (see MnemonadChunkCache.set's own doc) and IndexedDB commits
		// asynchronously, so a tight sequential loop of calls can outrun it in a real
		// browser even though a Node/in-memory-backed test never observes the race —
		// confirmed live, not theoretical (the explorer's own RPC panel still showed one
		// `getItemRefs` call per frame after switching from the raw `itemStore` read to a
		// cached one; passing the value through directly removes the dependency on cache
		// timing entirely, rather than hoping the write always lands in time).
		const store = (refs ?? await this.getItemRefs(i)).store;

		if (store === Store.EXTERNAL) {
			const cached = this._externalCache?.[i];
			if (cached) return cached.subarray(start, start + len);

			const pointer = await this.pointerAt(i);

			// A ranged fetch cannot be checked against the pointer's whole-blob sha256.
			// That is fine for an encrypted item — each frame carries its own GCM tag with
			// its index and finality authenticated — but for a plaintext item it would mean
			// returning bytes nobody vouched for, so those are fetched whole and verified
			// unless the caller has explicitly opted out.
			const frameAuthenticated = !!(this.encKeyWrapped && this.crypto.isEnabled);
			if (frameAuthenticated || this.allowUnverifiedRanges) {
				return await this.offloadingProvider.readPointerRange(pointer, start, len);
			}

			const whole = await this.offloadingProvider.readPointerBytes(pointer);
			this._externalCache ??= {};
			this._externalCache[i] = whole;
			return whole.subarray(start, start + len);
		}
		if (len === 0) return new Uint8Array();

		return hexToBytes(
			await this._read('readRange', [this.id, BigInt(i), BigInt(start), BigInt(len)])
		);
	}

	/**
	 * Streams an item, or a byte range of one, as decrypted pieces.
	 *
	 * Never holds more than one frame (encrypted) or one page (plaintext) in memory beyond
	 * what the caller keeps, so an item far larger than available memory can be consumed
	 * end to end. On an encrypted stream only the frames overlapping the requested range
	 * are fetched and authenticated.
	 *
	 * @param {number} i
	 * @param {Object} [params={}]
	 * @param {number} [params.start=0]
	 * @param {?number} [params.len] - defaults to the rest of the item
	 * @returns {AsyncGenerator<Uint8Array>}
	 *
	 * @example
	 * for await (const piece of ev.stream(0, { start: 0, len: 1024 })) {
	 *     process.stdout.write(piece);
	 * }
	 */
	async *stream(i, params = {}) {
		await this.initialize();
		const encrypted = !!(this.encKeyWrapped && this.crypto.isEnabled);
		// Looked up once for this whole call, not once per page/frame below — see
		// `_readRangeRaw`'s own doc for why passing it through explicitly matters even
		// though `getItemRefs` is itself cached. `params._refs` is an internal-only escape
		// hatch (same convention as `alreadyEncrypted` elsewhere in this file, not part of
		// the documented public params) letting `at()` hand over the lookup it already
		// made for its own routing decision, instead of this repeating it.
		const refs = params._refs ?? await this.getItemRefs(i);

		if (!encrypted) {
			const size = refs.store === Store.EXTERNAL ? Number((await this.pointerAt(i)).size) : refs.size;
			const start = params.start ?? 0;
			const len = params.len ?? size - start;
			for (let off = start; off < start + len; off += this.readPageBytes) {
				const take = Math.min(this.readPageBytes, start + len - off);
				yield await this._readRangeRaw(i, off, take, refs);
			}
			return;
		}

		// A request for the entire item is served as one verified whole fetch when the
		// payload is off-chain: cheaper than a request per frame, and it keeps the pointer's
		// blob hash meaningful. Done BEFORE reading the layout header, so a substituted
		// payload is reported as a hash mismatch rather than as a puzzling format error.
		if ((params.start ?? 0) === 0 && params.len === undefined) {
			await this._prefetchExternal(i, refs);
		}

		const layout = await this._cipherLayout(i, refs);
		const start = params.start ?? 0;
		const len = params.len ?? layout.plaintextLength - start;
		const { first, last } = MnemonadCrypto.framesForRange(layout, start, len);
		if (last < first) return;

		for (let f = first; f <= last; f += 1) {
			const frameCipher = await this._readRangeRaw(
				i,
				layout.frameOffset(f),
				layout.frameCipherLength(f),
				refs
			);
			const plain = await this.crypto.decryptFrame(
				frameCipher,
				f,
				f === layout.frameCount - 1,
				layout
			);

			// Trim the first and last frames down to the requested range.
			const framePlainStart = layout.framePlainOffset(f);
			const from = Math.max(0, start - framePlainStart);
			const to = Math.min(plain.length, start + len - framePlainStart);
			yield from === 0 && to === plain.length ? plain : plain.subarray(from, to);
		}
	}

	/**
	 * Fetches and verifies an off-chain payload whole, caching it. No-op for on-chain items.
	 * @param {number} i
	 * @param {?Object} [refs] - see `_readRangeRaw`'s doc for why this is threaded through
	 *   rather than left to `getItemRefs`'s own cache.
	 */
	async _prefetchExternal(i, refs = null) {
		if (this._externalCache?.[i]) return;
		const store = (refs ?? await this.getItemRefs(i)).store;
		if (store !== Store.EXTERNAL) return;
		const whole = await this.offloadingProvider.readPointerBytes(await this.pointerAt(i));
		this._externalCache ??= {};
		this._externalCache[i] = whole;
	}

	/**
	 * Plaintext length of item `i` — the stored size for a plain item, or the decrypted
	 * size once framing overhead is discounted for an encrypted one.
	 * @param {number} i
	 * @returns {Promise<number>}
	 */
	async plaintextLengthAt(i) {
		await this.initialize();
		if (this.encKeyWrapped && this.crypto.isEnabled) {
			return (await this._cipherLayout(i)).plaintextLength;
		}
		const refs = await this.getItemRefs(i);
		if (refs.store === Store.EXTERNAL) return Number((await this.pointerAt(i)).size);
		return refs.size;
	}

	/**
	 * Reads an item's frame header and derives its layout. Cached per index (in `_layouts`,
	 * separate from the durable chunk cache — this is derived data, cheap to recompute, and
	 * only needs to survive this one instance's lifetime), since it is needed by every
	 * range read of the same item.
	 * @param {number} i
	 * @param {?Object} [refs] - a `getItemRefs(i)` result already in hand, e.g. from
	 *   `stream()`'s own single lookup for the whole call — see `_readRangeRaw`'s doc for
	 *   why this is threaded through explicitly rather than relying on `getItemRefs`'s own
	 *   cache to collapse repeat calls.
	 * @returns {Promise<Object>}
	 */
	async _cipherLayout(i, refs = null) {
		this._layouts ??= {};
		if (this._layouts[i]) return this._layouts[i];

		refs ??= await this.getItemRefs(i);
		let ciphertextLength;
		let header;

		if (refs.store === Store.EXTERNAL) {
			// The ciphertext length is already on-chain in the pointer, so the layout needs
			// only the 10-byte header — no reason to download the payload to learn it.
			const pointer = await this.pointerAt(i);
			ciphertextLength = Number(pointer.size);
			header = this._externalCache?.[i]
				? this._externalCache[i].subarray(0, 10)
				: await this.offloadingProvider.readPointerRange(pointer, 0, Math.min(10, ciphertextLength));
		} else {
			ciphertextLength = refs.size;
			header = await this._readRangeRaw(i, 0, Math.min(10, ciphertextLength), refs);
		}

		this._layouts[i] = MnemonadCrypto.parseHeader(header, ciphertextLength);
		return this._layouts[i];
	}

	/**
	 * Returns an `MnemonadItem` wrapper for index `i`, without fetching the payload.
	 * Useful for inspecting tier and size before deciding to read — the item's `.bytes()`
	 * fetches on-chain payloads lazily too (a single `at()` read on first call), so listing
	 * many items here never pulls their content along with it.
	 *
	 * One `getItemRefs` read covers store/size/meta together — deliberately not three
	 * separate `itemStore`/`itemSize`/`itemMeta` calls, which would triple the RPC round
	 * trips a list view pays for every item on screen.
	 * @param {number} i
	 * @returns {Promise<MnemonadItem>}
	 */
	async itemAt(i) {
		await this.initialize();
		if (this._items[i]) return this._items[i];

		const refs = await this.getItemRefs(i);
		const raw = { store: refs.store, size: refs.size, meta: refs.meta };

		if (refs.store === Store.EXTERNAL) {
			raw.pointerData = await this.pointerAt(i);
		}
		// On-chain payload deliberately left unset — MnemonadItem.bytes() fetches it lazily
		// via `_readItemBytes` on first actual request.

		this._items[i] = MnemonadItem.fromChain(raw, { mnemonad: this, index: i });
		return this._items[i];
	}

	/**
	 * Batched form of {@link itemAt}: refs for every index in `indices` in one RPC call via
	 * {@link getItemRefsBatch}, instead of one call per index. Already-cached indices are
	 * skipped, matching `itemAt`'s own cache check — this only fetches what isn't already
	 * known.
	 *
	 * EXTERNAL items still cost one extra `pointerAt` call each — there is no batched
	 * pointer read on-chain (yet), only a batched refs read. Worth reaching for regardless
	 * on a listing made mostly of SLOT/CODE items, which is the common case; a stream that's
	 * mostly EXTERNAL items gets less benefit here.
	 *
	 * @param {number[]} indices
	 * @returns {Promise<MnemonadItem[]>} in the same order as `indices`
	 */
	async itemsAt(indices) {
		await this.initialize();
		const missing = indices.filter((i) => !this._items[i]);
		if (missing.length) {
			const refs = await this.getItemRefsBatch(missing);
			await Promise.all(
				missing.map(async (i, k) => {
					const r = refs[k];
					const raw = { store: r.store, size: r.size, meta: r.meta };
					if (r.store === Store.EXTERNAL) {
						raw.pointerData = await this.pointerAt(i);
					}
					this._items[i] = MnemonadItem.fromChain(raw, { mnemonad: this, index: i });
				})
			);
		}
		return indices.map((i) => this._items[i]);
	}

	/**
	 * Fetches and hex-decodes index `i`'s on-chain payload via a single `at()` contract
	 * read. Called directly by the *stream method* `at()` above, for an on-chain item
	 * within `readPageBytes`; `MnemonadItem.bytes()` reaches it only indirectly, by
	 * delegating to that same `at()` (see its own doc) rather than calling this itself —
	 * so both routes share one cache entry per index, and both decrypt identically. Not
	 * for external/off-chain items. Returns whatever is actually stored on-chain,
	 * verbatim — ciphertext on an encrypted stream — since this method has no opinion on
	 * encryption at all; that indifference is exactly what lets the durable chunk cache
	 * hold one pre-decryption entry per item regardless of which caller populated it,
	 * with decryption applied one layer up, in `at()`, on every read.
	 * @param {number} i
	 * @returns {Promise<Uint8Array>}
	 */
	async _readItemBytes(i) {
		await this.initialize(); // chainId, needed for the cache key, is set here
		const key = this._chunkCache && this._onchainCacheKey(i);
		if (key) {
			const cached = await this._chunkCache.get(key);
			if (cached) return cached;
		}
		const bytes = hexToBytes(await this._read('at', [this.id, BigInt(i)]));
		if (key) this._chunkCache.set(key, bytes).catch(() => {});
		return bytes;
	}

	/**
	 * Cache key for an on-chain item's payload: location-addressed, not content-addressed —
	 * unlike an EXTERNAL item's pointer hash (known before fetching), nothing on-chain gives
	 * this a content hash cheaply ahead of time, so it keys on where the item lives instead.
	 * @param {number} i
	 * @returns {string}
	 */
	_onchainCacheKey(i) {
		return `onchain:${this.chainId}:${this._contractAddress}:${this.id}:${i}`;
	}

	/**
	 * Cache key for an item's *refs* (tier/size/chunk locations) — same location tuple as
	 * `_onchainCacheKey`, different prefix, so the two never collide in one shared cache.
	 * @param {number} i
	 * @returns {string}
	 */
	_refsCacheKey(i) {
		return `refs:${this.chainId}:${this._contractAddress}:${this.id}:${i}`;
	}

	/**
	 * Cache key for an EXTERNAL item's *pointer* (the CID, not the payload it points to) —
	 * distinct from both of the above: it needs its own entry because it's fetched by a
	 * separate contract call (`pointerAt`, not `getItemRefs`), and the payload itself is
	 * already cached under `ipfs:<hash>` once fetched, keyed by content rather than location.
	 * @param {number} i
	 * @returns {string}
	 */
	_pointerCacheKey(i) {
		return `pointer:${this.chainId}:${this._contractAddress}:${this.id}:${i}`;
	}

	/**
	 * Synchronously reports whether index `i`'s payload is already resident in memory —
	 * pure cache inspection, never a fetch. False if `itemAt(i)` hasn't resolved at all
	 * yet, or if it has but nothing has called `.bytes()` on the result — on-chain and
	 * external items are both lazy about the actual payload (see `MnemonadItem.isLoaded`).
	 * Meant for UI that wants to show "already loaded" without itself tracking a parallel
	 * loaded/not-loaded flag.
	 * @param {number} i
	 * @returns {boolean}
	 */
	isItemLoaded(i) {
		return !!this._items[i]?.isLoaded;
	}

	/**
	 * Reads the off-chain pointer at `i`.
	 *
	 * Cached like everything else in this file that's immutable once written — a pointer
	 * never changes after an EXTERNAL push commits it. Cheap to skip a real read for: the
	 * whole point of caching this alongside the payload (under a *different* key — see
	 * `_pointerCacheKey`) is that a fully-cached EXTERNAL item costs zero RPC calls for
	 * `itemAt`, not just for the bytes once you already know where they are.
	 *
	 * @param {number} i
	 * @returns {Promise<{hash: string, size: bigint, codec: number, locator: string}>}
	 */
	async pointerAt(i) {
		await this.initialize();
		const key = this._chunkCache && this._pointerCacheKey(i);
		if (key) {
			const cached = await this._chunkCache.get(key);
			if (cached) return _decodePointerFromCache(cached);
		}
		const p = await this._read('pointerAt', [this.id, BigInt(i)]);
		const pointer = {
			hash: p.hash,
			size: p.size,
			codec: Number(p.codec),
			locator: new TextDecoder().decode(hexToBytes(p.locator)),
		};
		if (key) this._chunkCache.set(key, _encodePointerForCache(pointer)).catch(() => {});
		return pointer;
	}

	/**
	 * Physical layout of an item, without reading its payload.
	 *
	 * The migration primitive: because the contract is immutable, a successor registry
	 * adopts existing CODE chunks by address rather than re-uploading bytes.
	 *
	 * Cached under `_refsCacheKey` — immutable once an item is committed (append-only;
	 * `concat`/`truncateFrom` never mutate an existing item's own record, only what's
	 * reachable around it), so a cache hit skips the RPC call entirely rather than merely
	 * answering it faster. This is what lets `itemAt` cost zero network calls once both this
	 * and the payload are cached, even from a brand new instance after a reload.
	 *
	 * @param {number} i
	 * @returns {Promise<{store: number, chunks: string[], offset: number, size: number, meta: Uint8Array}>}
	 */
	async getItemRefs(i) {
		await this.initialize();
		const key = this._chunkCache && this._refsCacheKey(i);
		if (key) {
			const cached = await this._chunkCache.get(key);
			if (cached) return _decodeRefsFromCache(cached);
		}
		const [store, chunks, offset, size, meta] = await this._read('getItemRefs', [
			this.id,
			BigInt(i),
		]);
		const refs = {
			store: Number(store),
			chunks: [...chunks],
			offset: Number(offset),
			size: Number(size),
			meta: hexToBytes(meta),
		};
		if (key) this._chunkCache.set(key, _encodeRefsForCache(refs)).catch(() => {});
		return refs;
	}

	/**
	 * Batched form of {@link getItemRefs}: every ref in `indices` not already cached, one
	 * RPC call for the rest.
	 *
	 * Worth reaching for over N individual `getItemRefs` calls specifically because it
	 * collapses N calls into exactly one at every layer that counts them — the shared rate
	 * limiter (`MnemonadRateLimiter.wrapClient` wraps `readContract` as a whole method, so
	 * it sees "one call" here regardless of how many indices are inside), the node, and the
	 * wire. viem's own JSON-RPC transport batching only ever helps at the wire: N separate
	 * `readContract` calls still count as N against the rate limiter even when the
	 * transport coalesces them into one HTTP request — confirmed directly against a real
	 * node, not assumed.
	 *
	 * Cache-aware the same way `getItemRefs` is: an index whose refs are already cached
	 * never enters the batch RPC call at all, so a request that's entirely cache hits costs
	 * zero network calls, not merely one small one.
	 *
	 * @param {number[]} indices
	 * @returns {Promise<Array<{store: number, chunks: string[], offset: number, size: number, meta: Uint8Array}>>}
	 *   in the same order as `indices`
	 */
	async getItemRefsBatch(indices) {
		await this.initialize();
		const results = new Array(indices.length);
		const missingPositions = [];
		const missingIndices = [];

		if (this._chunkCache) {
			await Promise.all(
				indices.map(async (index, pos) => {
					const cached = await this._chunkCache.get(this._refsCacheKey(index));
					if (cached) results[pos] = _decodeRefsFromCache(cached);
				})
			);
		}
		indices.forEach((index, pos) => {
			if (!results[pos]) {
				missingPositions.push(pos);
				missingIndices.push(index);
			}
		});

		if (missingIndices.length) {
			const fetched = await this._read('getItemRefsBatch', [
				this.id,
				missingIndices.map((i) => BigInt(i)),
			]);
			fetched.forEach((r, k) => {
				const refs = {
					store: Number(r.store),
					chunks: [...r.chunks],
					offset: Number(r.offset),
					size: Number(r.size),
					meta: hexToBytes(r.meta),
				};
				results[missingPositions[k]] = refs;
				if (this._chunkCache) {
					const index = missingIndices[k];
					this._chunkCache.set(this._refsCacheKey(index), _encodeRefsForCache(refs)).catch(() => {});
				}
			});
		}
		return results;
	}

	/** @returns {Promise<string>} The stream's owner address. */
	async owner() {
		return await this._read('ownerOf', [this.id]);
	}

	/**
	 * Address of the paid-upload gateway this registry settles prepaid EXTERNAL pushes
	 * against, or the zero address when none is wired.
	 *
	 * Registry-level, not per-stream, and read rather than configured client-side: the
	 * registry is the only authority on which gateway it will actually honour, so
	 * discovering it here can never drift from what `pushExternal` does.
	 * See `MnemonadUploadGateway.fromMnemonad`.
	 *
	 * @returns {Promise<string>}
	 */
	async uploadGateway() {
		return await this._read('uploadGateway', []);
	}

	/**
	 * MON required to prepay this stream's wired upload gateway for an off-chain payload of
	 * up to `size` bytes — the same gateway `push()`'s own `_pushExternalAuto` pays
	 * automatically when routing an oversized item off-chain. A thin convenience over
	 * `MnemonadUploadGateway.fromMnemonad` + `.quote()`, so a caller that only wants to
	 * show a pre-commit price (a UI's upload form, say) doesn't need to import
	 * `MnemonadUploadGateway` itself, or know `uploadGateway()` above exists at all, just to
	 * ask this one question.
	 *
	 * @param {number} size
	 * @returns {Promise<?bigint>} wei, or null when no gateway is wired to this registry.
	 * @throws Whatever `MnemonadUploadGateway.quote` itself throws — most commonly a stale
	 *   or too-uncertain Pyth price — when a gateway IS wired but currently refuses to
	 *   quote. Left to propagate rather than folded into the `null` case, so a caller can
	 *   tell "no gateway at all" apart from "a gateway exists but can't price this right now".
	 */
	async quoteOffloadUpload(size) {
		await this.initialize();
		const gw = await MnemonadUploadGateway.fromMnemonad(this);
		if (!gw) return null;
		return await gw.quote(size);
	}

	/**
	 * The sha256 an offloaded push of `data` would record in its `Pointer.hash` — i.e. the
	 * exact value to commit to when prepaying through `MnemonadUploadGateway`.
	 *
	 * On an encrypted stream, `data` must already be the final ciphertext — pass
	 * `{ alreadyEncrypted: true }` and hand this the output of `crypto.encryptItem(plaintext)`
	 * yourself, then pass that *same* ciphertext (with the *same* option) to `pushExternal`
	 * so the bytes committed and the bytes uploaded are identical:
	 *
	 * ```js
	 * const ciphertext = await stream.crypto.encryptItem(plaintext);
	 * const { hash, size } = await stream.offloadCommitment(ciphertext, { alreadyEncrypted: true });
	 * await gateway.payForUpload(hash, size);
	 * await stream.pushExternal(ciphertext, { alreadyEncrypted: true });
	 * ```
	 *
	 * This can't be automated inside `offloadCommitment` itself — encrypting here and again
	 * inside `pushExternal` would draw two different nonces and produce two different
	 * ciphertexts, defeating the entire point of committing in advance.
	 *
	 * @param {Uint8Array} data
	 * @param {Object} [params={}]
	 * @param {boolean} [params.alreadyEncrypted=false] - `data` is already the exact
	 *   ciphertext that will be uploaded; skips the encrypted-stream guard below.
	 * @returns {Promise<{hash: string, size: number}>} `hash` 0x-prefixed.
	 * @throws {Error} On an encrypted stream, unless `alreadyEncrypted` is set. Not a missing
	 *   feature otherwise — a real impossibility: every encryption draws a fresh nonce, so a
	 *   plaintext `push` would produce different ciphertext than any hash computed
	 *   beforehand, and the registry would find no matching escrow. Committing the plaintext
	 *   hash instead would look fine and then silently fail to settle, leaving the payment
	 *   stuck until it expired.
	 */
	async offloadCommitment(data, params = {}) {
		await this.initialize();
		// `isEncrypted` is an async method, not a getter — reading it without calling would
		// be a truthy function reference, i.e. "always encrypted".
		if (!params.alreadyEncrypted && (await this.isEncrypted())) {
			throw new Error(
				'offloadCommitment: cannot pre-commit to an encrypted stream\'s payload — ' +
				'encryption uses a fresh nonce each time, so the ciphertext push() uploads ' +
				'would not match any hash computed in advance. Pre-encrypt yourself and pass ' +
				'{ alreadyEncrypted: true } with that ciphertext if you\'ve already worked ' +
				'around this (see this method\'s own doc comment).'
			);
		}
		return { hash: bytesToHex(sha256(data)), size: data.length };
	}

	/**
	 * Whether `address` can append to this stream right now — the owner, an ERC-721
	 * approved operator, or an address granted via `setWriterApproval`. Distinct from
	 * `this.offloadingProvider.canWrite`, which is about IPFS pinning capability, not write access to the
	 * stream itself.
	 *
	 * Never throws for "nothing to check": with no address and no configured sender (no
	 * wallet connected yet), resolves `false` rather than rejecting — checking write access
	 * is a benign read that a UI should be able to call unconditionally.
	 *
	 * @param {?string} [address] - defaults to this instance's configured sender
	 * @returns {Promise<boolean>}
	 */
	async canWrite(address) {
		const who = address || this._senderAddress;
		if (!who) return false;
		return await this._read('canWrite', [this.id, who]);
	}

	// -----------------------------------------------------------------------------
	// Writing
	// -----------------------------------------------------------------------------

	/**
	 * Appends one or more items, routing each to the cheapest viable tier. Handles
	 * encryption, tier routing, and — for an off-chain item — the gateway
	 * commit/pay/upload sequence entirely internally: a caller never encrypts, hashes, or
	 * pays anything itself, regardless of item size or whether the stream is encrypted.
	 *
	 * Routing, all thresholds read from chain:
	 *   - up to `maxChunkBytes`  → on-chain (the contract picks SLOT vs CODE at 31 bytes)
	 *   - larger, `onChain: true` → staged multi-chunk append, several transactions
	 *   - larger, IPFS available  → off-chain pointer, prepaid through the registry's
	 *     wired upload gateway first when one exists — see `_pushExternalAuto`'s own doc
	 *     for why that step isn't optional for some offloading providers, and why it's
	 *     strictly cheaper even for the ones where it is
	 *
	 * @param {Uint8Array|Uint8Array[]} arr
	 * @param {Object} [params={}]
	 * @param {boolean} [params.onChain=false] - force large items on-chain via staging
	 * @param {?Uint8Array} [params.itemMeta] - raw per-item metadata bytes (single items
	 *   only), for a caller that wants full control over the on-chain format. Wins outright
	 *   over `name`/`type` below when given.
	 * @param {?string} [params.name] - optional item name/label, encoded (via
	 *   `encodeItemMeta`, gzipped on-chain when that's smaller) into `itemMeta`
	 *   automatically when it isn't given directly — see `itemMeta.js`'s own doc.
	 * @param {?string} [params.type] - optional MIME type, encoded the same way.
	 * @param {boolean} [params.payGateway=true] - set `false` to skip prepaying through a
	 *   wired gateway even for an off-chain item — see `_pushExternalAuto`'s own doc for
	 *   when a caller would want that.
	 * @param {?Function} [params.onProgress] - called for a multi-step write: the staged
	 *   on-chain path (see `_pushStaged`'s own doc for that callback shape) or the
	 *   gateway-prepaid off-chain path (`{phase: 'gateway-pay'|'gateway-upload', ...}` —
	 *   see `_pushExternalAuto`). Ignored for a single-transaction push, which has nothing
	 *   to report progress on.
	 * @param {?number} [params.timeout]
	 * @param {?number} [params.pollIntervalMs]
	 * @returns {Promise<boolean>}
	 */
	async push(arr, params = {}) {
		if (!this.isWritable) {
			throw new Error(
				'Mnemonad is not writable, contractAddress and sendTransaction (or walletClient) are required'
			);
		}
		await this.initialize();

		// Encrypt first, then route: the 28-byte AES overhead can push an item across the
		// chunk threshold, so routing on plaintext size would occasionally be wrong.
		const items = await this._maybeEncrypt(normalizeArray(arr), params);
		// Mark the payloads as already-ciphertext so the delegates below don't re-encrypt,
		// and resolve name/type sugar into raw itemMeta bytes once here — _pushStaged and
		// _pushExternalAuto below both receive this same already-resolved params object.
		params = this._resolveItemMeta({ ...params, alreadyEncrypted: true });

		if (items.length === 1) {
			const data = items[0];
			if (data.length > this.maxChunkBytes) {
				if (params.onChain) return await this._pushStaged(data, params);
				if (this.offloadingProvider.canWrite) return await this._pushExternalAuto(data, params);
				throw new Error(
					`Item of ${data.length} bytes exceeds maxChunkBytes (${this.maxChunkBytes}). ` +
					'Pass { onChain: true } to store it on-chain across several transactions, ' +
					'or configure pinningUrl/ipfsClient to offload it to IPFS.'
				);
			}

			const fee = await this.quotePushFee(data.length, Store.CODE);
			await this._write(
				'push',
				[this.id, BigInt(this.length), bytesToHex(data), bytesToHex(params.itemMeta || new Uint8Array())],
				{ value: fee, ...params }
			);
			this._afterWrite(1);
			return true;
		}

		return await this.pushMany(items, params);
	}

	/**
	 * Appends a batch, packing it into a single shared chunk where it fits.
	 *
	 * Worth reaching for deliberately: each separate chunk costs ~32,000 gas of `CREATE`
	 * overhead, which dominates for small items. Packing is only possible within one
	 * transaction — chunks are immutable, so an item can never be folded into an existing
	 * chunk afterwards.
	 *
	 * @param {Uint8Array[]} items
	 * @param {Object} [params={}]
	 * @returns {Promise<boolean>}
	 */
	async pushMany(items, params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this.initialize();

		const list = await this._maybeEncrypt(normalizeArray(items), params);
		const oversized = list.find((b) => b.length > this.maxChunkBytes);
		if (oversized) {
			throw new Error(
				`pushMany: item of ${oversized.length} bytes exceeds maxChunkBytes (${this.maxChunkBytes}); ` +
				'push it separately so it can be staged or offloaded'
			);
		}

		const total = list.reduce((sum, b) => sum + b.length, 0);
		const fee = await this.quotePushFee(total, Store.CODE);

		await this._write(
			'pushMany',
			[this.id, BigInt(this.length), list.map(bytesToHex)],
			{ value: fee, ...params }
		);
		this._afterWrite(list.length);
		return true;
	}

	/**
	 * Uploads a payload to IPFS and appends a pointer to it.
	 * @param {Uint8Array} data
	 * @param {Object} [params={}]
	 * @param {boolean} [params.alreadyEncrypted=false] - `data` is already ciphertext;
	 *   skips re-encrypting it. Needed for the prepaid-upload flow on an encrypted stream —
	 *   see `offloadCommitment`'s own doc for the full sequence — since the exact bytes
	 *   committed to the gateway have to be the exact bytes uploaded here, and encrypting
	 *   twice (once per call) would draw two different nonces and break that.
	 * @param {?Uint8Array} [params.itemMeta] - raw per-item metadata bytes; see `push()`'s
	 *   own doc — `name`/`type` sugar works here too.
	 * @returns {Promise<boolean>}
	 */
	async pushExternal(data, params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this.initialize();
		params = this._resolveItemMeta(params);

		const [payload] = await this._maybeEncrypt([data], params);
		const pointer = await this.offloadingProvider.putBytes(payload);
		const fee = await this.quotePushFee(payload.length, Store.EXTERNAL);

		await this._write(
			'pushExternal',
			[
				this.id,
				BigInt(this.length),
				{
					hash: pointer.hash,
					size: pointer.size,
					codec: pointer.codec,
					locator: bytesToHex(new TextEncoder().encode(pointer.locator)),
				},
				bytesToHex(params.itemMeta || new Uint8Array()),
			],
			{ value: fee, ...params }
		);
		this._afterWrite(1);
		return true;
	}

	/**
	 * Routes an oversized item off-chain via `pushExternal`, prepaying through the
	 * registry's wired upload gateway first when one exists — this is what makes `push()`
	 * itself "just work" for an off-chain item, with no caller-side orchestration of
	 * encryption, commitments, or payment at all.
	 *
	 * Two independent reasons prepaying matters here, not just one:
	 *   - It's the *only* thing that makes `MnemonadPresignProvider` usable at all: the
	 *     sign server it talks to unconditionally requires a matching on-chain escrow
	 *     before it will issue an upload URL (see `presign-server/src/routes/uploadUrl.js`)
	 *     — a bare `pushExternal` against it fails every time with "No open escrow for
	 *     this (payer, contentHash). Call payForUpload first."
	 *   - Even for a provider that does not itself require it (a direct pinning
	 *     credential), a matching escrow makes the registry waive its flat EXTERNAL fee on
	 *     settlement — so paying first is strictly cheaper whenever a gateway exists, not
	 *     merely sometimes required.
	 *
	 * Falls back to a bare `pushExternal` — paying the registry's full EXTERNAL fee, and
	 * only actually working if the offloading provider doesn't itself demand a pre-paid
	 * escrow — when no gateway is wired to this registry, or `params.payGateway` opts out.
	 *
	 * @param {Uint8Array} data - already encrypted, if applicable (`push()` calls this with
	 *   `params.alreadyEncrypted` already set from its own `_maybeEncrypt` step, so this
	 *   never encrypts a second time).
	 * @param {Object} params
	 * @param {boolean} [params.payGateway=true] - set `false` to call `pushExternal`
	 *   directly even when a gateway is wired — e.g. a caller intentionally managing its
	 *   own escrow lifecycle rather than paying fresh on every push.
	 * @returns {Promise<boolean>}
	 */
	async _pushExternalAuto(data, params = {}) {
		// MnemonadUploadGateway can only send transactions through a real viem
		// WalletClient (see its own _write) — a Mnemonad configured with the alternative
		// CustomSendTransactionFunction has no such client to hand it, so this skips
		// straight to pushExternal rather than throwing "not writable" from a gateway the
		// caller never asked for by name.
		if (params.payGateway === false || !this._walletClient) {
			return await this.pushExternal(data, params);
		}

		const gw = await MnemonadUploadGateway.fromMnemonad(this, { walletClient: this._walletClient });
		if (!gw) return await this.pushExternal(data, params);

		this._reportProgress(params, { phase: 'gateway-pay', chunkIndex: 0, chunkCount: 1 });
		// `params` already carries `alreadyEncrypted: true` from push()'s own
		// _maybeEncrypt step by the time this runs, so this commits to and later uploads
		// the exact same bytes — never re-encrypting, never drawing a second nonce.
		const { hash, size } = await this.offloadCommitment(data, params);
		await gw.payForUpload(hash, size);
		this._reportProgress(params, { phase: 'gateway-upload', chunkIndex: 1, chunkCount: 1 });
		return await this.pushExternal(data, params);
	}

	/**
	 * Calls `params.onProgress`, if given, swallowing anything it throws — shared by every
	 * multi-step write path (`_pushStaged`, `_pushExternalAuto`) so progress reporting can
	 * never be the thing that breaks a write that would otherwise have succeeded.
	 * @param {Object} params
	 * @param {Object} info
	 */
	_reportProgress(params, info) {
		try {
			params.onProgress?.(info);
		} catch {
			// Deliberately swallowed — see this method's own doc.
		}
	}

	/**
	 * Stores an item larger than one transaction can carry, across several transactions.
	 *
	 * The item stays invisible to `at()` until committed, so a reader never observes a
	 * partial item — and each chunk's offset is checked on-chain, so a retry after a
	 * timeout is idempotent rather than duplicating data.
	 *
	 * @param {Uint8Array} data
	 * @param {Object} [params={}]
	 * @param {?(info: {phase: 'begin'|'chunk'|'commit', chunkIndex: number, chunkCount: number}) => void}
	 *   [params.onProgress] - called once after `beginItem`, once after each `appendChunk`
	 *   (with `chunkIndex` = how many have landed so far, 1-based), and once after
	 *   `commitItem`. Best-effort visibility only — there is no resume support yet: a
	 *   failure partway through leaves the staging id unrecoverable from the caller's side,
	 *   even though `appendChunk`'s own offset check would make resuming it safe in
	 *   principle. A callback throwing does not stop the upload; errors from it are swallowed
	 *   the same way a caching failure is elsewhere in this file — progress reporting must
	 *   never be able to break a write that would otherwise have succeeded.
	 * @returns {Promise<boolean>}
	 */
	async _pushStaged(data, params = {}) {
		const chunkSize = this.maxChunkBytes;
		const chunkCount = Math.ceil(data.length / chunkSize);
		const report = (info) => this._reportProgress(params, info);

		await this._write(
			'beginItem',
			[this.id, data.length, bytesToHex(params.itemMeta || new Uint8Array())],
			params
		);
		report({ phase: 'begin', chunkIndex: 0, chunkCount });

		// beginItem returns the staging id, but a receipt doesn't carry return values, so
		// recover it from the ItemStaged event.
		const stagingId = await this._lastStagingId();

		let chunkIndex = 0;
		for (let offset = 0; offset < data.length; offset += chunkSize) {
			const slice = data.subarray(offset, Math.min(offset + chunkSize, data.length));
			const fee = await this.quotePushFee(slice.length, Store.CODE);
			await this._write('appendChunk', [stagingId, offset, bytesToHex(slice)], {
				value: fee,
				...params,
			});
			chunkIndex += 1;
			report({ phase: 'chunk', chunkIndex, chunkCount });
		}

		await this._write('commitItem', [stagingId], params);
		report({ phase: 'commit', chunkIndex: chunkCount, chunkCount });
		this._afterWrite(1);
		return true;
	}

	/**
	 * Appends every item of another stream into this one, consuming the source.
	 *
	 * Cost tracks the source's ITEM COUNT, not its byte length — payload bytes are
	 * re-linked, never copied. Measured on-chain, merging four 5,000-byte items costs
	 * exactly the same as four 100-byte items.
	 *
	 * Restrictions: neither stream may be encrypted, and the source may not have been
	 * truncated.
	 *
	 * @param {bigint|string|Mnemonad} other
	 * @param {Object} [params={}]
	 * @returns {Promise<boolean>}
	 */
	async concat(other, params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this.initialize();

		const srcId = other instanceof Mnemonad ? other.id : BigInt(other);
		await this._write('concat', [this.id, srcId, BigInt(this.length)], params);

		if (other instanceof Mnemonad) other.reInitialize();
		this.reInitialize();
		return true;
	}

	/**
	 * Logically drops every item below `uptoIndex`.
	 *
	 * Reclaims essentially nothing: EVM refunds cap at 20% of gas used, Monad charges the
	 * gas *limit*, and CODE chunks cannot be deleted at all. Treat it as access revocation and
	 * state hygiene, not as a way to get money back.
	 *
	 * @param {number} uptoIndex
	 * @param {Object} [params={}]
	 * @returns {Promise<boolean>}
	 */
	async truncateFrom(uptoIndex, params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this._write('truncateFrom', [this.id, BigInt(uptoIndex)], params);
		this.reInitialize();
		return true;
	}

	/**
	 * Destroys the stream and its ERC-721 token. Deployed chunks survive on-chain.
	 * @param {Object} [params={}]
	 * @returns {Promise<boolean>}
	 */
	async burn(params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this._write('burn', [this.id], params);
		this.reInitialize();
		return true;
	}

	/**
	 * Sets or replaces the wrapped encryption key.
	 *
	 * The owner may re-wrap rather than set the key once and never again. That is what
	 * makes handing an encrypted stream to a new owner possible at all — though the
	 * propose/accept transfer flow that would use it is not in v1, so an encrypted stream
	 * is currently non-transferable.
	 *
	 * @param {Uint8Array} wrapped
	 * @param {Object} [params={}]
	 * @returns {Promise<boolean>}
	 */
	async setEncKeyWrapped(wrapped, params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this._write('setEncKeyWrapped', [this.id, bytesToHex(wrapped)], params);
		this.reInitialize();
		return true;
	}

	/**
	 * Grants or revokes append rights, independently of ERC-721 transfer approval.
	 *
	 * Deliberately separate from `approve`: reusing transfer approval would mean letting a
	 * marketplace that may sell your stream also append to it.
	 *
	 * @param {string} writer
	 * @param {boolean} approved
	 * @param {Object} [params={}]
	 * @returns {Promise<boolean>}
	 */
	async setWriterApproval(writer, approved, params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this._write('setWriterApproval', [this.id, writer, approved], params);
		return true;
	}

	// -----------------------------------------------------------------------------
	// Fees and cost estimation
	// -----------------------------------------------------------------------------

	/**
	 * Protocol fee for appending `size` bytes into `store`, in wei.
	 * @param {number} size
	 * @param {number} [store=Store.CODE]
	 * @returns {Promise<bigint>}
	 */
	async quotePushFee(size, store = Store.CODE) {
		if (size === 0 && store !== Store.EXTERNAL) return 0n;
		return await this._read('quotePushFee', [BigInt(size), store]);
	}

	/**
	 * Estimates the total cost of a push, in wei: gas plus protocol fee. Mirrors `push()`'s
	 * own routing, so the estimate matches whatever `push()` would actually do with the
	 * same `data`/`params`: a single on-chain write when it fits in one chunk, the staged
	 * multi-transaction path for `{ onChain: true }` on an oversized item, or an IPFS-backed
	 * `pushExternal` when a transport is configured. Throws the same descriptive error
	 * `push()` would if none of those apply.
	 *
	 * Encrypts first, exactly like `push()` does, when this is an encrypted stream with a
	 * usable key — not just for an accurate byte count (AES-GCM framing adds ~28 bytes),
	 * but because that overhead can flip which of the three paths above actually applies
	 * (push()'s own comment on this: routing on plaintext size would occasionally be
	 * wrong). Estimating on `data`'s plaintext length would then estimate the wrong
	 * routing entirely, not just the wrong price for the right one.
	 *
	 * Worth calling before large writes, and more important here than on other EVM chains:
	 * Monad charges the gas *limit* rather than gas used, so a loose estimate is a direct
	 * overcharge rather than a harmless margin.
	 *
	 * @param {Uint8Array} data
	 * @param {Object} [params={}]
	 * @param {number} [params.bufferPercent=10]
	 * @param {boolean} [params.onChain] - see `push()`; selects the staged path for an
	 *   oversized item instead of IPFS
	 * @param {boolean} [params.alreadyEncrypted] - see `_maybeEncrypt`; `data` is already
	 *   ciphertext, so skip encrypting it a second time
	 * @param {?Uint8Array} [params.itemMeta] - see `push()`'s own doc — `name`/`type` sugar
	 *   works here too, and affects the staged path's modeled `beginItem` gas.
	 * @returns {Promise<{gas: bigint, gasCost: bigint, fee: bigint, total: bigint, transactionCount: number}>}
	 */
	async estimatePushCost(data, params = {}) {
		await this.initialize();
		params = this._resolveItemMeta(params);
		const buffer = params.bufferPercent ?? 10;
		const gasPrice = await this.publicClient.getGasPrice();
		const account = this._requireSender();
		const [payload] = await this._maybeEncrypt([data], params);

		const withBuffer = (gas) => (gas * BigInt(100 + buffer)) / 100n;
		const finish = (gas, fee, transactionCount) => {
			const gasWithBuffer = withBuffer(gas);
			const gasCost = gasWithBuffer * gasPrice;
			return { gas: gasWithBuffer, gasCost, fee, total: gasCost + fee, transactionCount };
		};

		if (payload.length <= this.maxChunkBytes) {
			const fee = await this.quotePushFee(payload.length, Store.CODE);
			const gas = await this.publicClient.estimateContractGas({
				address: this._contractAddress,
				abi: mnemonadAbi,
				functionName: 'push',
				// itemMeta, not a hardcoded '0x': omitting it here would silently
				// underestimate gas for any push carrying real itemMeta bytes (a real,
				// latent bug this fixes, not just an oversight introduced by name/type
				// sugar above — `params.itemMeta` was already resolved by then either way).
				args: [this.id, BigInt(this.length), bytesToHex(payload), bytesToHex(params.itemMeta || new Uint8Array())],
				account,
				value: fee,
			});
			return finish(gas, fee, 1);
		}

		if (!params.onChain && !this.offloadingProvider.canWrite) {
			throw new Error(
				`Item of ${payload.length} bytes exceeds maxChunkBytes (${this.maxChunkBytes}). ` +
				'Pass { onChain: true } to store it on-chain across several transactions, ' +
				'or configure pinningUrl/ipfsClient to offload it to IPFS.'
			);
		}

		const fee = await this.quotePushFee(payload.length, Store.CODE);

		if (!params.onChain) {
			// pushExternal's gas doesn't depend on the payload — it records a fixed-shape
			// Pointer struct, never deploys the bytes themselves — so a placeholder pointer
			// of realistic field sizes estimates it without a real IPFS upload.
			const placeholderPointer = {
				hash: `0x${'00'.repeat(32)}`,
				size: BigInt(payload.length),
				codec: 0,
				locator: bytesToHex(new TextEncoder().encode('ipfs://bafkreiaexampleexampleexampleexampleexampleexample')),
			};
			const gas = await this.publicClient.estimateContractGas({
				address: this._contractAddress,
				abi: mnemonadAbi,
				functionName: 'pushExternal',
				args: [this.id, BigInt(this.length), placeholderPointer, '0x'],
				account,
			});
			return finish(gas, fee, 1);
		}

		// Staged: beginItem, then one appendChunk per maxChunkBytes-sized slice, then
		// commitItem — but appendChunk/commitItem each need a stagingId that only exists
		// once a prior transaction has actually landed, so the true sequence can't be
		// simulated without spending it. Modeled instead, using real slices of `payload`
		// (not synthetic zero-filled ones) so calldata cost reflects the payload's actual
		// zero/non-zero byte mix:
		//   - beginItem is simulated directly — real args, no prior state needed
		//   - each appendChunk is modeled by simulating an ordinary push() of the same-sized
		//     slice: both deploy a same-sized CODE chunk, so gas is close; appendChunk skips
		//     push()'s final Item-slot write, so this slightly overestimates — the safe
		//     direction on a chain that charges the gas *limit*, not gas used
		//   - commitItem is modeled as another beginItem-sized call: both are small,
		//     fixed-accounting writes with no chunk deploy
		const chunkSize = this.maxChunkBytes;
		const fullChunks = Math.floor(payload.length / chunkSize);
		const remainder = payload.length - fullChunks * chunkSize;
		const transactionCount = fullChunks + (remainder > 0 ? 1 : 0) + 2; // + beginItem + commitItem

		const itemMetaHex = bytesToHex(params.itemMeta || new Uint8Array());
		const beginGas = await this.publicClient.estimateContractGas({
			address: this._contractAddress,
			abi: mnemonadAbi,
			functionName: 'beginItem',
			args: [this.id, payload.length, itemMetaHex],
			account,
		});

		let chunkGasTotal = 0n;
		if (fullChunks > 0) {
			const slice = payload.subarray(0, chunkSize);
			const sliceFee = await this.quotePushFee(chunkSize, Store.CODE);
			const perChunkGas = await this.publicClient.estimateContractGas({
				address: this._contractAddress,
				abi: mnemonadAbi,
				functionName: 'push',
				args: [this.id, BigInt(this.length), bytesToHex(slice), '0x'],
				account,
				value: sliceFee,
			});
			chunkGasTotal += perChunkGas * BigInt(fullChunks);
		}
		if (remainder > 0) {
			const slice = payload.subarray(payload.length - remainder);
			const sliceFee = await this.quotePushFee(remainder, Store.CODE);
			chunkGasTotal += await this.publicClient.estimateContractGas({
				address: this._contractAddress,
				abi: mnemonadAbi,
				functionName: 'push',
				args: [this.id, BigInt(this.length), bytesToHex(slice), '0x'],
				account,
				value: sliceFee,
			});
		}

		const totalGas = beginGas /* commitItem, modeled */ + beginGas + chunkGasTotal;
		return finish(totalGas, fee, transactionCount);
	}

	// -----------------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------------

	/**
	 * Reads the immutable contract constants once, and refuses to proceed on a version
	 * mismatch.
	 *
	 * Not defensive padding: the contract is immutable and testnet deployments are
	 * disposable, so several versions will coexist. An SDK that silently decoded a struct
	 * whose layout had moved would return plausible nonsense.
	 */
	async _loadConstants() {
		if (this._constantsLoaded) return;
		if (!this._contractAddress) throw new Error('contractAddress is required');
		if (this._applyCachedConstants()) return;

		await this._applyConstants(await Promise.all([
			this._read('CONTRACT_VERSION', []),
			this._read('maxChunkBytes', []),
		]));
	}

	/**
	 * Applies constants from the process-wide shared cache (`_sharedContractConstants`) if
	 * another instance already read them for this chain+contract. The lookup key uses only
	 * whatever chain id is available synchronously (`publicClient`/`walletClient`'s own
	 * `chain.id`, same fallback `_rateLimitClients` already uses) — never a `getChainId()`
	 * RPC call, which would spend a call trying to avoid two others. A client without chain
	 * metadata attached simply won't hit the cache; it still gets a correct answer, just not
	 * this optimization.
	 * @returns {boolean} true if constants were applied (skip fetching)
	 */
	_applyCachedConstants() {
		const chainId = this.publicClient?.chain?.id ?? this._walletClient?.chain?.id ?? null;
		const cached = _sharedContractConstants.get(_contractConstantsKey(chainId, this._contractAddress));
		if (!cached) return false;
		this.madeWithVersion = cached.madeWithVersion;
		this.maxChunkBytes = cached.maxChunkBytes;
		this.chainId = chainId;
		this._constantsLoaded = true;
		return true;
	}

	/**
	 * Validates and assigns an already-fetched `[version, maxChunk]` pair. Split out of
	 * `_loadConstants` so `initialize()` can fold these two reads into its own single
	 * batch instead of fetching them in a separate round trip first.
	 * @param {[bigint, bigint]} param0
	 */
	async _applyConstants([version, maxChunk]) {
		if (Number(version) !== EXPECTED_CONTRACT_VERSION) {
			throw new Error(
				`Contract version mismatch: contract at ${this._contractAddress} reports ` +
				`v${version}, this SDK expects v${EXPECTED_CONTRACT_VERSION}. ` +
				'Upgrade the SDK or point it at a matching deployment.'
			);
		}

		this.madeWithVersion = Number(version);
		this.maxChunkBytes = Number(maxChunk);
		this.chainId = this.publicClient?.chain?.id ?? (await this.publicClient.getChainId());
		this._constantsLoaded = true;

		// Left for every other instance pointed at this same chain+contract — see
		// `_sharedContractConstants`'s own comment for why that's safe: these two values are
		// immutable for a deployed contract.
		_sharedContractConstants.set(_contractConstantsKey(this.chainId, this._contractAddress), {
			madeWithVersion: this.madeWithVersion,
			maxChunkBytes: this.maxChunkBytes,
		});
	}

	/**
	 * @param {string} functionName
	 * @param {Array} args
	 * @returns {Promise<any>}
	 */
	async _read(functionName, args) {
		if (!this.publicClient) throw new Error('publicClient is required');
		if (!this._contractAddress) throw new Error('contractAddress is required');
		return await this.publicClient.readContract({
			address: this._contractAddress,
			abi: mnemonadAbi,
			functionName,
			args,
		});
	}

	/**
	 * Sends a contract write and waits for its receipt.
	 * @param {string} functionName
	 * @param {Array} args
	 * @param {Object} [options={}]
	 * @param {bigint} [options.gas] - explicit gas limit, bypassing the estimate-and-buffer
	 *   below entirely. Escape hatch for a write whose real cost this can't simulate
	 *   accurately (see `withdrawRevenue`-style callers elsewhere in this codebase).
	 * @returns {Promise<Object>} the transaction receipt
	 */
	async _write(functionName, args, options = {}) {
		const request = {
			address: this._contractAddress,
			abi: mnemonadAbi,
			functionName,
			args,
			// Prefer the wallet client's own account *object* over the bare address string.
			// viem dispatches on its type: a local (private-key) account gets signed and
			// sent as `eth_sendRawTransaction`, a json-rpc account goes to
			// `eth_sendTransaction`. Passing only an address forces the latter, which a
			// browser wallet and a local dev node both accept but a public RPC rejects
			// outright ("this request method is not supported") — so scripts holding a key
			// could not write at all. `_requireSender` still runs, to keep the "no sender
			// configured" error identical.
			account: (this._requireSender(), this._walletClient?.account ?? this._senderAddress),
			chain: this.publicClient?.chain ?? null,
		};
		if (options.value) request.value = options.value;

		// An explicit gas limit, from our own simulation rather than left to whatever the
		// connected wallet decides. Two independent reasons this matters more here than on
		// most chains: Monad bills the *limit*, not gas used, so a wallet's own padded
		// estimate is a direct overcharge even when the write succeeds — and some wallets
		// pad generously enough to push a genuinely-fitting write over the 30M per-tx cap,
		// which fails outright rather than merely costing more. Observed for real: a ~97 KB
		// CODE-tier `push` simulates at ~21.5M gas here — comfortably under the cap — yet
		// failed with "Exceeds transaction gas limit" through a wallet padding past it.
		// `estimateContractGas` hits the same node the write will, so it reflects the real
		// cost; the buffer (matching `estimatePushCost`'s own) covers ordinary state drift
		// between simulation and inclusion, not wallet guesswork.
		if (options.gas) {
			request.gas = options.gas;
		} else {
			try {
				const estimated = await this.publicClient.estimateContractGas({
					address: this._contractAddress,
					abi: mnemonadAbi,
					functionName,
					args,
					account: request.account,
					value: request.value,
				});
				request.gas = (estimated * 110n) / 100n;
			} catch {
				// Simulation can fail for reasons that have nothing to do with gas — a stale
				// `expectedLength`, an unauthorized caller — in which case the write itself
				// is about to fail anyway, and surfaces more clearly as that specific revert
				// than as a swallowed estimation error here. Falling through with no
				// explicit `gas` preserves today's behavior (wallet/viem estimates) rather
				// than blocking the write on a simulation issue this method has no business
				// diagnosing.
			}
		}

		const hash = this._sendTransaction
			? await this._sendTransaction(request)
			: await this._walletClient.writeContract(request);

		const receipt = await this.publicClient.waitForTransactionReceipt({
			hash: typeof hash === 'string' ? hash : hash?.hash,
			timeout: options.timeout || 30000,
			pollingInterval: options.pollIntervalMs || 200,
		});
		if (receipt.status !== 'success') {
			throw new Error(`Transaction ${functionName} reverted (${receipt.transactionHash})`);
		}
		this._lastReceipt = receipt;
		return receipt;
	}

	/**
	 * Recovers the staging id from the `ItemStaged` event of the last write, since a
	 * receipt carries no return values.
	 * @returns {Promise<bigint>}
	 */
	async _lastStagingId() {
		const { decodeEventLog } = await import('viem');
		for (const log of this._lastReceipt?.logs || []) {
			try {
				const decoded = decodeEventLog({
					abi: mnemonadAbi,
					data: log.data,
					topics: log.topics,
				});
				if (decoded.eventName === 'ItemStaged') return decoded.args.stagingId;
			} catch {
				// Not one of ours; ignore.
			}
		}
		throw new Error('Could not determine stagingId: no ItemStaged event in receipt');
	}

	/**
	 * Encrypts payloads if the stream is encrypted and they aren't ciphertext already.
	 *
	 * Every write path routes through this, not just `push()`. Keeping encryption in
	 * `push()` alone meant `pushMany()` and `pushExternal()`, called directly, wrote
	 * PLAINTEXT to an encrypted stream — silently, since nothing downstream can tell the
	 * difference between a ciphertext blob and a plaintext one.
	 *
	 * @param {Uint8Array[]} items
	 * @param {Object} [params={}] - `alreadyEncrypted: true` marks items as already-
	 *        ciphertext. Two callers rely on this: `push()`, avoiding double-encryption when
	 *        it delegates to a batch, and a caller pre-encrypting to prepay an off-chain
	 *        upload through the gateway (see `offloadCommitment`'s own doc) — the exact same
	 *        bytes given to `offloadCommitment({ alreadyEncrypted: true })` must reach here
	 *        unchanged, or the committed hash and the uploaded ciphertext would diverge.
	 * @returns {Promise<Uint8Array[]>}
	 */
	async _maybeEncrypt(items, params = {}) {
		if (params.alreadyEncrypted) return items;
		if (!(this.encKeyWrapped && this.crypto.isEnabled)) return items;
		const out = [];
		for (const item of items) out.push(await this.crypto.encryptItem(item));
		return out;
	}

	/**
	 * Resolves the effective `itemMeta` bytes for a write: explicit raw `params.itemMeta`
	 * wins outright (still the low-level escape hatch for a caller that wants full control
	 * over the on-chain format), otherwise builds it from `params.name`/`params.type` via
	 * `encodeItemMeta` — so a caller labeling an item never has to call that itself. Called
	 * once, at each public entry point that reads `itemMeta` (`push`, `pushExternal`,
	 * `estimatePushCost`) rather than at every internal call site that reads it afterward
	 * (`_pushStaged`, `_pushExternalAuto` both receive the already-resolved `params` from
	 * `push()`, same as they already receive `alreadyEncrypted`).
	 *
	 * @param {Object} params
	 * @returns {Object} `params` unchanged (same reference) when there's nothing to resolve
	 *   — no raw bytes and no name/type — so a plain push with nothing to label costs
	 *   nothing extra.
	 */
	_resolveItemMeta(params) {
		if (params.itemMeta !== undefined || (!params.name && !params.type)) return params;
		return { ...params, itemMeta: encodeItemMeta({ name: params.name, type: params.type }) };
	}

	/** @returns {string} */
	_requireSender() {
		const sender = this._senderAddress || this._walletClient?.account?.address;
		if (!sender) {
			throw new Error('senderAddress (or a walletClient with an account) is required');
		}
		return sender;
	}

	/**
	 * Keeps `length` in sync so chained pushes can supply the right `expectedLength`
	 * without a round-trip, then marks the rest stale.
	 * @param {number} itemsAdded
	 */
	_afterWrite(itemsAdded) {
		const nextLength = this.length + itemsAdded;
		this.reInitialize();
		this.length = nextLength;
	}
}

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------

/**
 * @param {?Uint8Array|Uint8Array[]} arr
 * @returns {Uint8Array[]}
 */
function normalizeArray(arr) {
	if (!arr) return [];
	if (arr instanceof Uint8Array) return [arr];
	if (Array.isArray(arr)) {
		if (arr.length === 0) return [];
		if (arr[0] instanceof Uint8Array) return arr;
	}
	throw new Error('.array must be a Uint8Array or an array of Uint8Array');
}

/**
 * @param {Uint8Array[]} parts
 * @param {?number} [total] - expected total length, validated when given
 * @returns {Uint8Array}
 */
function concatBytes(parts, total = null) {
	const size = total ?? parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(size);
	let pos = 0;
	for (const part of parts) {
		out.set(part, pos);
		pos += part.length;
	}
	if (pos !== size) {
		throw new Error(`concatBytes: assembled ${pos} bytes, expected ${size}`);
	}
	return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} 0x-prefixed hex
 */
function bytesToHex(bytes) {
	let out = '0x';
	for (let i = 0; i < bytes.length; i += 1) {
		out += bytes[i].toString(16).padStart(2, '0');
	}
	return out;
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
	if (!hex || hex === '0x') return new Uint8Array();
	const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = parseInt(clean.substr(i * 2, 2), 16);
	}
	return out;
}

/**
 * `MnemonadChunkCache` stores `Uint8Array` values — that's what a payload is already, but
 * item *metadata* (refs, pointers) is a small structured object, not bytes. These two pairs
 * encode/decode it as JSON-over-bytes so it can share the exact same cache and eviction
 * logic as payloads, rather than needing a second cache class for something this small.
 *
 * @param {{store: number, chunks: string[], offset: number, size: number, meta: Uint8Array}} refs
 * @returns {Uint8Array}
 */
function _encodeRefsForCache(refs) {
	return new TextEncoder().encode(
		JSON.stringify({
			store: refs.store,
			chunks: refs.chunks,
			offset: refs.offset,
			size: refs.size,
			meta: bytesToHex(refs.meta),
		})
	);
}

/** @param {Uint8Array} bytes @returns {{store: number, chunks: string[], offset: number, size: number, meta: Uint8Array}} */
function _decodeRefsFromCache(bytes) {
	const obj = JSON.parse(new TextDecoder().decode(bytes));
	return { store: obj.store, chunks: obj.chunks, offset: obj.offset, size: obj.size, meta: hexToBytes(obj.meta) };
}

/**
 * @param {{hash: string, size: bigint, codec: number, locator: string}} pointer
 * @returns {Uint8Array}
 */
function _encodePointerForCache(pointer) {
	return new TextEncoder().encode(
		JSON.stringify({
			hash: pointer.hash,
			size: pointer.size.toString(), // BigInt (uint64) — JSON has no BigInt of its own
			codec: pointer.codec,
			locator: pointer.locator,
		})
	);
}

/** @param {Uint8Array} bytes @returns {{hash: string, size: bigint, codec: number, locator: string}} */
function _decodePointerFromCache(bytes) {
	const obj = JSON.parse(new TextDecoder().decode(bytes));
	return { hash: obj.hash, size: BigInt(obj.size), codec: obj.codec, locator: obj.locator };
}

/** @returns {string} a random 0x-prefixed 32-byte hex salt */
function randomSalt() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}

export { bytesToHex, hexToBytes, normalizeArray, concatBytes };
