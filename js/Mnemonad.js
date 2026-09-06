import { sha256 } from '@noble/hashes/sha2.js';
import MnemonadItem, { Store } from './MnemonadItem.js';
import MnemonadIpfs from './offloading/MnemonadIpfs.js';
import MnemonadCrypto from './MnemonadCrypto.js';
import MnemonadRateLimiter from './MnemonadRateLimiter.js';
import { mnemonadAbi } from './abi.js';
import ids from './ids.js';

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
 * Shared by chain id + rate, so every Mnemonad instance (and static call) configured with
 * the same `maxRPCRequestsPerSecond` for the same chain shares one budget. A fan-out read
 * pattern — several fields per vector, times several vectors, all via `Promise.all` — needs
 * the limit enforced across instances, not per instance, or N independently-throttled
 * instances still add up to N × maxRPCRequestsPerSecond against the RPC. Public RPC
 * endpoints commonly 429 exactly that burst.
 *
 * @param {number} maxPerSecond
 * @param {?number} chainId
 * @returns {MnemonadRateLimiter}
 */
const _sharedRateLimiters = new Map();
function _getSharedRateLimiter(maxPerSecond, chainId) {
	const key = `${chainId ?? 'unknown'}:${maxPerSecond}`;
	let limiter = _sharedRateLimiters.get(key);
	if (!limiter) {
		limiter = new MnemonadRateLimiter({ maxPerSecond });
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
 * @param {?PublicClient} publicClient
 * @param {?WalletClient} walletClient
 * @param {?number} maxRPCRequestsPerSecond
 * @returns {{publicClient: ?PublicClient, walletClient: ?WalletClient}}
 */
function _rateLimitClients(publicClient, walletClient, maxRPCRequestsPerSecond) {
	const chainId = publicClient?.chain?.id ?? walletClient?.chain?.id ?? null;
	const limiter = _getSharedRateLimiter(maxRPCRequestsPerSecond ?? null, chainId);
	return {
		publicClient: publicClient ? limiter.wrapClient(publicClient) : publicClient,
		walletClient: walletClient ? limiter.wrapClient(walletClient) : walletClient,
	};
}

/**
 * Represents a Mnemonad vector: a scalable append-only on-chain `bytes[]`.
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
	 * @param {bigint|string} [params.id] - vector id (ERC-721 token id)
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
	 * @param {?number} [params.maxRPCRequestsPerSecond] - caps outbound RPC calls, queuing
	 *   the rest rather than firing them all at once. Shared across every instance
	 *   configured with the same rate on the same chain (see `_getSharedRateLimiter`) — a
	 *   fan-out read over many vectors needs one budget, not one per vector. Omit for
	 *   unlimited (the default); public RPC endpoints commonly 429 an unthrottled fan-out.
	 */
	constructor(params = {}) {
		const { publicClient, walletClient } = _rateLimitClients(
			params.publicClient,
			params.walletClient,
			params.maxRPCRequestsPerSecond
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
		/** @type {?Uint8Array} Vector-level metadata. */
		this.meta = null;
		/** @type {?Uint8Array} Wrapped encryption key, or null if unencrypted. */
		this.encKeyWrapped = null;
		/** @type {?number} Contract version the vector was created with. */
		this.madeWithVersion = null;

		/** @type {number} Max payload accepted in a single on-chain chunk. From chain. */
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
	 * @returns {Promise<boolean>} Whether the vector carries an encryption key on-chain.
	 */
	async isEncrypted() {
		await this.initialize();
		return !!(this.encKeyWrapped && this.encKeyWrapped.length > 0);
	}

	// -----------------------------------------------------------------------------
	// Creation
	// -----------------------------------------------------------------------------

	/**
	 * Computes the id a creator/salt pair will produce, without touching the chain.
	 *
	 * This is the mechanism behind single-transaction encrypted creation: because the id is
	 * known in advance, the data key can be wrapped scoped to a vector that doesn't exist
	 * yet, so create, key-wrap, and initial push all happen in one transaction with no
	 * round trip needed first to learn what id a create call would produce.
	 *
	 * @param {string} creator
	 * @param {string} salt - 0x-prefixed 32-byte hex
	 * @param {?number} [maxRPCRequestsPerSecond] - see the constructor's param of the same name
	 * @returns {bigint}
	 */
	static async computeVectorId(publicClient, contractAddress, creator, salt, maxRPCRequestsPerSecond) {
		({ publicClient } = _rateLimitClients(publicClient, null, maxRPCRequestsPerSecond));
		return await publicClient.readContract({
			address: contractAddress,
			abi: mnemonadAbi,
			functionName: 'vectorIdFor',
			args: [creator, salt],
		});
	}

	/**
	 * Lists vector ids currently owned by `owner`, via `ERC721Enumerable`'s per-owner index —
	 * a direct on-chain read, not an off-chain event-log scan. Needed because ids are
	 * deterministic (see `computeVectorId`/`vectorIdFor`), so there is no `0..totalSupply`
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
	 *   vector) is exactly the burst shape that trips a public RPC's rate limit.
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
	 * @returns {Object}
	 */
	static wrapClient(client, maxRPCRequestsPerSecond) {
		return _rateLimitClients(client, null, maxRPCRequestsPerSecond).publicClient;
	}

	static async listOwned(publicClient, contractAddress, owner, maxRPCRequestsPerSecond) {
		({ publicClient } = _rateLimitClients(publicClient, null, maxRPCRequestsPerSecond));
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
	 * Creates a new vector on-chain and returns a wrapped instance.
	 *
	 * @param {Object} params - every constructor param, plus:
	 * @param {?Uint8Array|Uint8Array[]} [params.array] - initial item(s) to push
	 * @param {?string} [params.salt] - 0x-prefixed 32-byte hex; random if omitted
	 * @param {?Uint8Array} [params.meta] - vector-level metadata
	 * @param {boolean} [params.encrypt=false] - create an encrypted vector
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
		const id = await Mnemonad.computeVectorId(
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
			[salt, bytesToHex(params.meta || new Uint8Array()), encKeyWrapped, inline.map(bytesToHex)],
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
		// loaded them) alongside the vector's own fields. None of these reads depend on
		// each other's values, only the version check below depends on having read them,
		// so there's no reason to pay for a second round trip's latency (and, with the
		// transport's JSON-RPC batching enabled, a second HTTP request) just to validate
		// before reading the rest.
		const needsConstants = !this._constantsLoaded;
		const [len, binLen, firstIdx, meta, encKey, version, maxChunk] = await Promise.all([
			this._read('length', [this.id]),
			this._read('binaryLength', [this.id]),
			this._read('firstAvailableIndex', [this.id]),
			this._read('vectorMeta', [this.id]),
			this._read('encKeyWrapped', [this.id]),
			needsConstants ? this._read('CONTRACT_VERSION', []) : Promise.resolve(null),
			needsConstants ? this._read('maxChunkBytes', []) : Promise.resolve(null),
		]);

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
	 * @param {number} i
	 * @returns {Promise<Uint8Array>}
	 */
	async at(i) {
		await this.initialize();

		if (this.encKeyWrapped && this.crypto.isEnabled) {
			// An off-chain payload is fetched and hash-verified before its layout header is
			// consulted, so a substituted blob is reported as a hash mismatch rather than
			// as a confusing format error from a header that was never trustworthy.
			await this._prefetchExternal(i);

			// Stream the frames rather than pulling the whole ciphertext and decrypting in
			// one go: only one frame is authenticated at a time, and only one buffer of
			// plaintext is held.
			const layout = await this._cipherLayout(i);
			const out = new Uint8Array(layout.plaintextLength);
			let pos = 0;
			for await (const part of this.stream(i)) {
				out.set(part, pos);
				pos += part.length;
			}
			return out;
		}

		return await this._atRaw(i);
	}

	/**
	 * Reads the item at `i` without decrypting, paging automatically when it is too large
	 * for a single call.
	 * @param {number} i
	 * @returns {Promise<Uint8Array>}
	 */
	async _atRaw(i) {
		await this.initialize();
		const store = Number(await this._read('itemStore', [this.id, BigInt(i)]));

		if (store === Store.EXTERNAL) {
			const pointer = await this.pointerAt(i);
			return await this.offloadingProvider.readPointerBytes(pointer);
		}

		const size = Number(await this._read('itemSize', [this.id, BigInt(i)]));
		if (size <= this.readPageBytes) {
			return hexToBytes(await this._read('at', [this.id, BigInt(i)]));
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
	 * On an encrypted vector this fetches only the frames covering the requested range and
	 * decrypts those — so reading the first kilobyte of a 4 MB item costs one frame, not
	 * the whole item. Random access works the same whether the vector is encrypted or not,
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
	 * @param {number} i
	 * @param {number} start
	 * @param {number} len
	 * @returns {Promise<Uint8Array>}
	 */
	async _readRangeRaw(i, start, len) {
		await this.initialize();
		const store = Number(await this._read('itemStore', [this.id, BigInt(i)]));

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
	 * end to end. On an encrypted vector only the frames overlapping the requested range
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

		if (!encrypted) {
			const size = await this.plaintextLengthAt(i);
			const start = params.start ?? 0;
			const len = params.len ?? size - start;
			for (let off = start; off < start + len; off += this.readPageBytes) {
				const take = Math.min(this.readPageBytes, start + len - off);
				yield await this._readRangeRaw(i, off, take);
			}
			return;
		}

		// A request for the entire item is served as one verified whole fetch when the
		// payload is off-chain: cheaper than a request per frame, and it keeps the pointer's
		// blob hash meaningful. Done BEFORE reading the layout header, so a substituted
		// payload is reported as a hash mismatch rather than as a puzzling format error.
		if ((params.start ?? 0) === 0 && params.len === undefined) {
			await this._prefetchExternal(i);
		}

		const layout = await this._cipherLayout(i);
		const start = params.start ?? 0;
		const len = params.len ?? layout.plaintextLength - start;
		const { first, last } = MnemonadCrypto.framesForRange(layout, start, len);
		if (last < first) return;

		for (let f = first; f <= last; f += 1) {
			const frameCipher = await this._readRangeRaw(
				i,
				layout.frameOffset(f),
				layout.frameCipherLength(f)
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
	 */
	async _prefetchExternal(i) {
		if (this._externalCache?.[i]) return;
		const store = Number(await this._read('itemStore', [this.id, BigInt(i)]));
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
		const store = Number(await this._read('itemStore', [this.id, BigInt(i)]));
		if (store === Store.EXTERNAL) return Number((await this.pointerAt(i)).size);
		return Number(await this._read('itemSize', [this.id, BigInt(i)]));
	}

	/**
	 * Reads an item's frame header and derives its layout. Cached per index, since it is
	 * needed by every range read of the same item.
	 * @param {number} i
	 * @returns {Promise<Object>}
	 */
	async _cipherLayout(i) {
		this._layouts ??= {};
		if (this._layouts[i]) return this._layouts[i];

		const store = Number(await this._read('itemStore', [this.id, BigInt(i)]));
		let ciphertextLength;
		let header;

		if (store === Store.EXTERNAL) {
			// The ciphertext length is already on-chain in the pointer, so the layout needs
			// only the 10-byte header — no reason to download the payload to learn it.
			const pointer = await this.pointerAt(i);
			ciphertextLength = Number(pointer.size);
			header = this._externalCache?.[i]
				? this._externalCache[i].subarray(0, 10)
				: await this.offloadingProvider.readPointerRange(pointer, 0, Math.min(10, ciphertextLength));
		} else {
			ciphertextLength = Number(await this._read('itemSize', [this.id, BigInt(i)]));
			header = await this._readRangeRaw(i, 0, Math.min(10, ciphertextLength));
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
	 * Fetches and hex-decodes index `i`'s on-chain payload via a single `at()` contract
	 * read. Internal — called by `MnemonadItem.bytes()` to lazily fetch what `itemAt()`
	 * deliberately left unset. Not for external/off-chain items.
	 * @param {number} i
	 * @returns {Promise<Uint8Array>}
	 */
	async _readItemBytes(i) {
		return hexToBytes(await this._read('at', [this.id, BigInt(i)]));
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
	 * @param {number} i
	 * @returns {Promise<{hash: string, size: bigint, codec: number, locator: string}>}
	 */
	async pointerAt(i) {
		await this.initialize();
		const p = await this._read('pointerAt', [this.id, BigInt(i)]);
		return {
			hash: p.hash,
			size: p.size,
			codec: Number(p.codec),
			locator: new TextDecoder().decode(hexToBytes(p.locator)),
		};
	}

	/**
	 * Physical layout of an item, without reading its payload.
	 *
	 * The migration primitive: because the contract is immutable, a successor registry
	 * adopts existing CODE chunks by address rather than re-uploading bytes.
	 *
	 * @param {number} i
	 * @returns {Promise<{store: number, chunks: string[], offset: number, size: number, meta: Uint8Array}>}
	 */
	async getItemRefs(i) {
		await this.initialize();
		const [store, chunks, offset, size, meta] = await this._read('getItemRefs', [
			this.id,
			BigInt(i),
		]);
		return {
			store: Number(store),
			chunks: [...chunks],
			offset: Number(offset),
			size: Number(size),
			meta: hexToBytes(meta),
		};
	}

	/** @returns {Promise<string>} The vector's owner address. */
	async owner() {
		return await this._read('ownerOf', [this.id]);
	}

	/**
	 * Address of the paid-upload gateway this registry settles prepaid EXTERNAL pushes
	 * against, or the zero address when none is wired.
	 *
	 * Registry-level, not per-vector, and read rather than configured client-side: the
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
	 * The sha256 an offloaded push of `data` would record in its `Pointer.hash` — i.e. the
	 * exact value to commit to when prepaying through `MnemonadUploadGateway`.
	 *
	 * @param {Uint8Array} data
	 * @returns {Promise<{hash: string, size: number}>} `hash` 0x-prefixed.
	 * @throws {Error} On an encrypted vector. Not a missing feature — a real impossibility:
	 *   every encryption draws a fresh nonce, so `push` would produce different ciphertext
	 *   than any hash computed beforehand, and the registry would find no matching escrow.
	 *   Committing the plaintext hash instead would look fine and then silently fail to
	 *   settle, leaving the payment stuck until it expired. Prepaying an encrypted item
	 *   requires encrypting once and committing to *that* ciphertext, which this call
	 *   cannot do on the caller's behalf.
	 */
	async offloadCommitment(data) {
		await this.initialize();
		// `isEncrypted` is an async method, not a getter — reading it without calling would
		// be a truthy function reference, i.e. "always encrypted".
		if (await this.isEncrypted()) {
			throw new Error(
				'offloadCommitment: cannot pre-commit to an encrypted vector\'s payload — ' +
				'encryption uses a fresh nonce each time, so the ciphertext push() uploads ' +
				'would not match any hash computed in advance.'
			);
		}
		return { hash: bytesToHex(sha256(data)), size: data.length };
	}

	/**
	 * Whether `address` can append to this vector right now — the owner, an ERC-721
	 * approved operator, or an address granted via `setWriterApproval`. Distinct from
	 * `this.offloadingProvider.canWrite`, which is about IPFS pinning capability, not write access to the
	 * vector itself.
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
	 * Appends one or more items, routing each to the cheapest viable tier.
	 *
	 * Routing, all thresholds read from chain:
	 *   - up to `maxChunkBytes`  → on-chain (the contract picks SLOT vs CODE at 31 bytes)
	 *   - larger, `onChain: true` → staged multi-chunk append, several transactions
	 *   - larger, IPFS available  → off-chain pointer
	 *
	 * @param {Uint8Array|Uint8Array[]} arr
	 * @param {Object} [params={}]
	 * @param {boolean} [params.onChain=false] - force large items on-chain via staging
	 * @param {?Uint8Array} [params.itemMeta] - per-item metadata (single items only)
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
		// Mark the payloads as already-ciphertext so the delegates below don't re-encrypt.
		params = { ...params, _encrypted: true };

		if (items.length === 1) {
			const data = items[0];
			if (data.length > this.maxChunkBytes) {
				if (params.onChain) return await this._pushStaged(data, params);
				if (this.offloadingProvider.canWrite) return await this.pushExternal(data, params);
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
	 * @returns {Promise<boolean>}
	 */
	async pushExternal(data, params = {}) {
		if (!this.isWritable) throw new Error('Mnemonad is not writable');
		await this.initialize();

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
	 * Stores an item larger than one transaction can carry, across several transactions.
	 *
	 * The item stays invisible to `at()` until committed, so a reader never observes a
	 * partial item — and each chunk's offset is checked on-chain, so a retry after a
	 * timeout is idempotent rather than duplicating data.
	 *
	 * @param {Uint8Array} data
	 * @param {Object} [params={}]
	 * @returns {Promise<boolean>}
	 */
	async _pushStaged(data, params = {}) {
		const chunkSize = this.maxChunkBytes;
		await this._write(
			'beginItem',
			[this.id, data.length, bytesToHex(params.itemMeta || new Uint8Array())],
			params
		);

		// beginItem returns the staging id, but a receipt doesn't carry return values, so
		// recover it from the ItemStaged event.
		const stagingId = await this._lastStagingId();

		for (let offset = 0; offset < data.length; offset += chunkSize) {
			const slice = data.subarray(offset, Math.min(offset + chunkSize, data.length));
			const fee = await this.quotePushFee(slice.length, Store.CODE);
			await this._write('appendChunk', [stagingId, offset, bytesToHex(slice)], {
				value: fee,
				...params,
			});
		}

		await this._write('commitItem', [stagingId], params);
		this._afterWrite(1);
		return true;
	}

	/**
	 * Appends every item of another vector into this one, consuming the source.
	 *
	 * Cost tracks the source's ITEM COUNT, not its byte length — payload bytes are
	 * re-linked, never copied. Measured on-chain, merging four 5,000-byte items costs
	 * exactly the same as four 100-byte items.
	 *
	 * Restrictions: neither vector may be encrypted, and the source may not have been
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
	 * Destroys the vector and its ERC-721 token. Deployed chunks survive on-chain.
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
	 * makes handing an encrypted vector to a new owner possible at all — though the
	 * propose/accept transfer flow that would use it is not in v1, so an encrypted vector
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
	 * marketplace that may sell your vector also append to it.
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
	 * Worth calling before large writes, and more important here than on other EVM chains:
	 * Monad charges the gas *limit* rather than gas used, so a loose estimate is a direct
	 * overcharge rather than a harmless margin.
	 *
	 * @param {Uint8Array} data
	 * @param {Object} [params={}]
	 * @param {number} [params.bufferPercent=10]
	 * @param {boolean} [params.onChain] - see `push()`; selects the staged path for an
	 *   oversized item instead of IPFS
	 * @returns {Promise<{gas: bigint, gasCost: bigint, fee: bigint, total: bigint, transactionCount: number}>}
	 */
	async estimatePushCost(data, params = {}) {
		await this.initialize();
		const buffer = params.bufferPercent ?? 10;
		const gasPrice = await this.publicClient.getGasPrice();
		const account = this._requireSender();

		const withBuffer = (gas) => (gas * BigInt(100 + buffer)) / 100n;
		const finish = (gas, fee, transactionCount) => {
			const gasWithBuffer = withBuffer(gas);
			const gasCost = gasWithBuffer * gasPrice;
			return { gas: gasWithBuffer, gasCost, fee, total: gasCost + fee, transactionCount };
		};

		if (data.length <= this.maxChunkBytes) {
			const fee = await this.quotePushFee(data.length, Store.CODE);
			const gas = await this.publicClient.estimateContractGas({
				address: this._contractAddress,
				abi: mnemonadAbi,
				functionName: 'push',
				args: [this.id, BigInt(this.length), bytesToHex(data), '0x'],
				account,
				value: fee,
			});
			return finish(gas, fee, 1);
		}

		if (!params.onChain && !this.offloadingProvider.canWrite) {
			throw new Error(
				`Item of ${data.length} bytes exceeds maxChunkBytes (${this.maxChunkBytes}). ` +
				'Pass { onChain: true } to store it on-chain across several transactions, ' +
				'or configure pinningUrl/ipfsClient to offload it to IPFS.'
			);
		}

		const fee = await this.quotePushFee(data.length, Store.CODE);

		if (!params.onChain) {
			// pushExternal's gas doesn't depend on the payload — it records a fixed-shape
			// Pointer struct, never deploys the bytes themselves — so a placeholder pointer
			// of realistic field sizes estimates it without a real IPFS upload.
			const placeholderPointer = {
				hash: `0x${'00'.repeat(32)}`,
				size: BigInt(data.length),
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
		// simulated without spending it. Modeled instead, using real slices of `data` (not
		// synthetic zero-filled ones) so calldata cost reflects the payload's actual
		// zero/non-zero byte mix:
		//   - beginItem is simulated directly — real args, no prior state needed
		//   - each appendChunk is modeled by simulating an ordinary push() of the same-sized
		//     slice: both deploy a same-sized CODE chunk, so gas is close; appendChunk skips
		//     push()'s final Item-slot write, so this slightly overestimates — the safe
		//     direction on a chain that charges the gas *limit*, not gas used
		//   - commitItem is modeled as another beginItem-sized call: both are small,
		//     fixed-accounting writes with no chunk deploy
		const chunkSize = this.maxChunkBytes;
		const fullChunks = Math.floor(data.length / chunkSize);
		const remainder = data.length - fullChunks * chunkSize;
		const transactionCount = fullChunks + (remainder > 0 ? 1 : 0) + 2; // + beginItem + commitItem

		const itemMetaHex = bytesToHex(params.itemMeta || new Uint8Array());
		const beginGas = await this.publicClient.estimateContractGas({
			address: this._contractAddress,
			abi: mnemonadAbi,
			functionName: 'beginItem',
			args: [this.id, data.length, itemMetaHex],
			account,
		});

		let chunkGasTotal = 0n;
		if (fullChunks > 0) {
			const slice = data.subarray(0, chunkSize);
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
			const slice = data.subarray(data.length - remainder);
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

		await this._applyConstants(await Promise.all([
			this._read('CONTRACT_VERSION', []),
			this._read('maxChunkBytes', []),
		]));
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
	 * Encrypts payloads if the vector is encrypted and they aren't ciphertext already.
	 *
	 * Every write path routes through this, not just `push()`. Keeping encryption in
	 * `push()` alone meant `pushMany()` and `pushExternal()`, called directly, wrote
	 * PLAINTEXT to an encrypted vector — silently, since nothing downstream can tell the
	 * difference between a ciphertext blob and a plaintext one.
	 *
	 * @param {Uint8Array[]} items
	 * @param {Object} [params={}] - `_encrypted: true` marks items as already-ciphertext,
	 *        which is how `push()` avoids double-encrypting when it delegates to a batch.
	 * @returns {Promise<Uint8Array[]>}
	 */
	async _maybeEncrypt(items, params = {}) {
		if (params._encrypted) return items;
		if (!(this.encKeyWrapped && this.crypto.isEnabled)) return items;
		const out = [];
		for (const item of items) out.push(await this.crypto.encryptItem(item));
		return out;
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

/** @returns {string} a random 0x-prefixed 32-byte hex salt */
function randomSalt() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytesToHex(bytes);
}

export { bytesToHex, hexToBytes, normalizeArray, concatBytes };
