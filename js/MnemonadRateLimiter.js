/**
 * Caps outbound RPC calls to at most `maxPerSecond`, queuing and delaying the rest instead
 * of firing them all at once. Public RPC endpoints commonly rate-limit (HTTP 429) bursts,
 * and a fan-out read pattern — several fields per vector, times several vectors, all via
 * `Promise.all` — produces exactly that burst even though each individual call is cheap.
 *
 * A no-op instance (the default: no `maxPerSecond`) never delays anything, so existing
 * callers — including local test suites talking to an unthrottled Hardhat node — see no
 * behavior change unless they opt in.
 */
export default class MnemonadRateLimiter {
	/**
	 * @param {Object} [params={}]
	 * @param {?number} [params.maxPerSecond] - omit/null for unlimited (no-op)
	 */
	constructor(params = {}) {
		/** @type {?number} */
		this.maxPerSecond = params.maxPerSecond ?? null;
		/** @type {number[]} Start times of calls admitted within the trailing 1s window. */
		this._timestamps = [];
		/** @type {Array<() => void>} FIFO — a burst is never reordered. */
		this._queue = [];
		/** @type {?ReturnType<typeof setTimeout>} */
		this._timer = null;
	}

	/**
	 * Runs `fn` once a call slot is free under the configured limit.
	 * @template T
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async run(fn) {
		if (this.maxPerSecond == null) return fn();
		await new Promise((resolve) => {
			this._queue.push(resolve);
			this._pump();
		});
		return fn();
	}

	/**
	 * Wraps a viem Public/Wallet client so every method that actually hits the network
	 * (`readContract`, `writeContract`, `getBlockNumber`, `waitForTransactionReceipt`,
	 * `getBalance`, `estimateContractGas`, `getGasPrice`, `getChainId`) is routed through
	 * this limiter — nothing else needs to know the client is throttled, including
	 * Mnemonad's own internals, its static helpers (`computeVectorId`, `listOwned`), and
	 * `estimatePushCost`'s own gas/price probes, which just call whatever client they're given.
	 *
	 * @param {Object} client
	 * @returns {Object} a client-shaped object; everything not listed above (chain, account,
	 *   transport, other actions) passes through unchanged via the prototype chain.
	 */
	wrapClient(client) {
		const limiter = this;
		const wrapped = Object.create(client);
		const methods = [
			'readContract',
			'writeContract',
			'getBlockNumber',
			'waitForTransactionReceipt',
			'getBalance',
			'estimateContractGas',
			'getGasPrice',
			'getChainId',
		];
		for (const name of methods) {
			if (typeof client[name] === 'function') {
				wrapped[name] = (...args) => limiter.run(() => client[name](...args));
			}
		}
		return wrapped;
	}

	/** Admits everything the current window allows; schedules a retry for the rest. */
	_pump() {
		const now = Date.now();
		this._timestamps = this._timestamps.filter((t) => now - t < 1000);

		while (this._queue.length && this._timestamps.length < this.maxPerSecond) {
			this._timestamps.push(now);
			this._queue.shift()();
		}

		if (!this._queue.length || this._timer) return;

		// The next slot frees when the oldest call in the window ages past 1s.
		const waitMs = Math.max(0, 1000 - (now - this._timestamps[0])) + 1;
		this._timer = setTimeout(() => {
			this._timer = null;
			this._pump();
		}, waitMs);
	}
}
