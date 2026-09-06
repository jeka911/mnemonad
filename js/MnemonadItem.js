/**
 * Represents a single item stored in a Mnemonad vector.
 *
 * The contract has three storage tiers. Two of them — SLOT and CODE — are both on-chain
 * payloads and are indistinguishable to a reader, so they collapse into one item type
 * here; the third is an off-chain pointer:
 *
 *   on-chain item (SLOT or CODE) → { type: 'bytes',    bytes: Uint8Array }
 *   off-chain item (EXTERNAL)    → { type: 'external', pointerData: {...} }
 *   truncated / absent           → { type: 'empty' }
 *
 * `store` keeps the exact on-chain tier available for callers who care about cost or
 * migration, without forcing that distinction on everyone reading data.
 */

/** On-chain `Store` enum values, mirroring `Mnemonad.Store` in Solidity. */
export const Store = {
	NONE: 0,
	SLOT: 1,
	CODE: 2,
	EXTERNAL: 3,
};

/** Reverse lookup, for error messages and debugging. */
export const StoreName = {
	0: 'none',
	1: 'slot',
	2: 'code',
	3: 'external',
};

export default class MnemonadItem {
	/**
	 * @param {Object} params
	 * @param {'bytes'|'external'|'empty'} params.type
	 * @param {?Uint8Array} [params.bytes]
	 * @param {?Object} [params.pointerData] - decoded on-chain Pointer struct
	 * @param {Uint8Array} [params.meta]
	 * @param {number} [params.store] - on-chain Store enum value
	 * @param {number} [params.size]
	 * @param {?import('./Mnemonad.js').default} [params.mnemonad]
	 * @param {?number} [params.index] - this item's position, needed to lazily fetch an
	 *   on-chain payload that wasn't included up front (see `bytes()`)
	 */
	constructor(params = {}) {
		/** @type {'bytes'|'external'|'empty'} */
		this.type = params.type || 'empty';
		/** @type {?Uint8Array} */
		this._bytes = params.bytes || null;
		/** @type {?Object} */
		this._pointerData = params.pointerData || null;
		/** @type {Uint8Array} */
		this.meta = params.meta || new Uint8Array();
		/** @type {number} */
		this.store = params.store ?? Store.NONE;
		/** @type {number} */
		this._size = params.size ?? 0;
		/** @type {?import('./Mnemonad.js').default} */
		this._mnemonad = params.mnemonad || null;
		/** @type {?number} */
		this._index = params.index ?? null;
	}

	/** @returns {boolean} */
	get isBytes() { return this.type === 'bytes'; }
	/** @returns {boolean} True for off-chain items. */
	get isExternal() { return this.type === 'external'; }
	/** @returns {boolean} */
	get isEmpty() { return this.type === 'empty'; }

	/**
	 * Whether the payload is already resident in memory — false until something has
	 * actually called `.bytes()` on this item (on-chain or external, both are lazy), and
	 * always false for empty items. Pure cache inspection — never triggers a fetch itself,
	 * so it's safe for a UI to poll (e.g. to show "already loaded, cheap to reveal" without
	 * eagerly fetching everything on screen).
	 * @returns {boolean}
	 */
	get isLoaded() { return this._bytes !== null; }

	/** @returns {string} The on-chain tier: 'slot', 'code', 'external' or 'none'. */
	get storeName() { return StoreName[this.store] || 'none'; }

	/**
	 * Binary size of this item in bytes. For external items this is the off-chain payload
	 * size recorded in the pointer, which may exceed anything stored on-chain.
	 * @returns {number}
	 */
	get size() {
		if (this.type === 'bytes') return this._bytes?.length ?? this._size;
		if (this.type === 'external') return Number(this._pointerData?.size ?? this._size);
		return 0;
	}

	/**
	 * Returns the raw payload — lazily fetching it on first call for both on-chain items
	 * (a single `at()` contract read) and external items (from IPFS, verified against the
	 * on-chain pointer hash), then caching it so repeat calls are free.
	 * @returns {Promise<Uint8Array>}
	 * @throws {Error} If the item is external and no IPFS transport is configured, if it's
	 *   on-chain but has no `mnemonad`/index reference to fetch through, or if it's empty.
	 */
	async bytes() {
		if (this.type === 'bytes') {
			if (this._bytes) return this._bytes; // already fetched once — no repeat round trip
			if (this._mnemonad && this._index != null) {
				this._bytes = await this._mnemonad._readItemBytes(this._index);
				return this._bytes;
			}
			throw new Error('Item has no cached bytes and no mnemonad/index reference to fetch them');
		}
		if (this.type === 'external') {
			if (this._bytes) return this._bytes; // already fetched once — no repeat round trip
			if (this._mnemonad?.offloadingProvider?.isEnabled) {
				this._bytes = await this._mnemonad.offloadingProvider.readPointerBytes(this._pointerData);
				return this._bytes;
			}
			throw new Error(
				'External items require gatewayUrl or ipfsClient to be configured on the Mnemonad'
			);
		}
		throw new Error('Item is empty');
	}

	/**
	 * Raw decoded Pointer struct for external items: `{ hash, size, codec, locator }`.
	 * @returns {?Object}
	 */
	pointerData() {
		return this._pointerData;
	}

	/**
	 * Builds an item from the values `getItemRefs` and friends return.
	 *
	 * @param {Object} raw
	 * @param {number} raw.store - Store enum value
	 * @param {number} raw.size
	 * @param {?Uint8Array} [raw.bytes]
	 * @param {?Object} [raw.pointerData]
	 * @param {Uint8Array} [raw.meta]
	 * @param {Object} [context={}]
	 * @param {?import('./Mnemonad.js').default} [context.mnemonad]
	 * @returns {MnemonadItem}
	 */
	static fromChain(raw, context = {}) {
		if (raw == null) {
			return new MnemonadItem({ type: 'empty', ...context });
		}

		const meta = raw.meta || new Uint8Array();
		const store = raw.store ?? Store.NONE;
		const size = Number(raw.size ?? 0);

		if (store === Store.EXTERNAL) {
			return new MnemonadItem({
				type: 'external',
				pointerData: raw.pointerData || null,
				meta,
				store,
				size,
				...context,
			});
		}

		if (store === Store.SLOT || store === Store.CODE) {
			return new MnemonadItem({
				type: 'bytes',
				bytes: raw.bytes || null,
				meta,
				store,
				size,
				...context,
			});
		}

		return new MnemonadItem({ type: 'empty', meta, store, size, ...context });
	}

	/**
	 * Concatenates two byte arrays. Used to reassemble a multi-chunk item.
	 *
	 * @param {Uint8Array} head
	 * @param {Uint8Array} tail
	 * @returns {Uint8Array}
	 */
	static concatBytes(head, tail) {
		const combined = new Uint8Array(head.length + tail.length);
		combined.set(head);
		combined.set(tail, head.length);
		return combined;
	}
}
