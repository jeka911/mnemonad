/**
 * Keeps RPC traffic inside what an endpoint will actually serve, by pacing calls and by
 * retrying the ones that fail because the endpoint was busy.
 *
 * The two halves answer the same problem from opposite sides. Pacing caps outbound calls at
 * `maxPerSecond`, queuing the rest instead of firing them at once: public endpoints
 * rate-limit bursts (HTTP 429), and a fan-out read — several fields per vector, times
 * several vectors, all via `Promise.all` — produces exactly that burst even though each
 * individual call is cheap. Retrying catches what still slips through, whether because the
 * budget is shared with another tab or because the endpoint had an unrelated hiccup.
 *
 * They live together because a retry has to be *re-admitted through the pacer*. A retry that
 * skipped the queue would re-burst against the very limit that just rejected it, which is
 * how naive retry loops turn a slow endpoint into a failing one.
 *
 * **Retry sits above viem's own, rather than replacing it.** viem's transport already
 * retries three times with `150, 300, 600ms` backoff — but every one of those waits is
 * shorter than a second, so against a limit measured over a *one-second* window (Monad's
 * public RPC rejects past ~15/sec) all four attempts land inside the same rejecting window
 * and fail together. The backoff here deliberately crosses that boundary, so later attempts
 * arrive in a window that has reset.
 *
 * Two rules keep retrying from doing harm:
 *
 *   - **Writes are never retried.** `writeContract` is not idempotent: a send that appears
 *     to have failed may already have reached the mempool, and retrying risks paying twice.
 *     It is still paced, just never repeated.
 *   - **Deterministic failures are not retried.** A revert, a bad argument or a chain
 *     mismatch fails identically every time; retrying turns a fast, clear error into a slow
 *     one and buries the cause. See {isTransientRpcError}.
 *
 * A no-op instance (the default: no `maxPerSecond`) never delays anything, so existing
 * callers — including local test suites talking to an unthrottled Hardhat node — see no
 * pacing behavior change unless they opt in. Retrying is independent of pacing and applies
 * either way, since a transient failure is worth another try at any rate.
 */

/** HTTP statuses that mean "ask again later" rather than "this request is wrong". */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * JSON-RPC error codes worth retrying.
 *
 * Deliberately narrow. `-32000` is omitted even though nodes do return it for transient
 * trouble, because it is also the catch-all many of them use for "execution reverted" and
 * other permanent answers — retrying those only wastes time and muddies the error.
 */
const RETRYABLE_RPC_CODES = new Set([
	-32005, // limit exceeded
	-32603, // internal error
]);

/** viem error class names describing a transport or node failure, not a bad request. */
const RETRYABLE_NAMES = new Set([
	'HttpRequestError',
	'RpcRequestError',
	'TimeoutError',
	'InternalRpcError',
	'LimitExceededRpcError',
	'SocketClosedError',
	'WebSocketRequestError',
]);

/** Transport failures that arrive as plain errors carrying no viem class name. */
const RETRYABLE_MESSAGE =
	/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network ?error|failed to fetch|fetch failed|terminated/i;

/** How far to walk `err.cause`. viem nests a few levels deep. */
const MAX_CAUSE_DEPTH = 8;

/** Client methods that read or simulate, and so may safely be repeated. */
const RETRYABLE_METHODS = new Set([
	'readContract',
	'simulateContract',
	'getBlockNumber',
	'getBalance',
	'estimateContractGas',
	'estimateGas',
	'getGasPrice',
	'getChainId',
	'getTransactionReceipt',
	'waitForTransactionReceipt',
	'call',
]);

/** Marks a wrapped client, so wrapping twice cannot square the attempt count. */
const WRAPPED = Symbol.for('mnemonad.ratelimiter.wrapped');

/**
 * True when `err` looks like a failure a later identical call might survive.
 *
 * A revert anywhere in the cause chain vetoes the decision regardless of what wraps it:
 * viem surfaces a reverted `readContract` as a `ContractFunctionExecutionError`, which would
 * otherwise be indistinguishable from the node dropping the connection mid-call.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientRpcError(err) {
	if (!err || typeof err !== 'object') return false;

	const chain = [];
	for (let e = err, depth = 0; e && depth < MAX_CAUSE_DEPTH; e = e.cause, depth += 1) {
		chain.push(e);
	}

	// A revert is a real answer from the chain, not a failure to reach it.
	if (chain.some((e) => e.name === 'ContractFunctionRevertedError')) return false;

	// The most specific evidence decides, and an explicit HTTP status is the most specific
	// there is. Matching the class name first would be wrong: a 400 and a 404 arrive as
	// `HttpRequestError` exactly like a 429 and a 503 do, so trusting the name over the
	// status retries a malformed request until the attempts run out.
	const withStatus = chain.find((e) => typeof e.status === 'number');
	if (withStatus) return RETRYABLE_STATUS.has(withStatus.status);

	// Same reasoning one layer down: a numeric JSON-RPC code means the node answered and
	// said what was wrong, which beats any guess made from the wrapper's name.
	const withCode = chain.find((e) => typeof e.code === 'number');
	if (withCode) return RETRYABLE_RPC_CODES.has(withCode.code);

	// Nothing said what happened, so fall back to what the failure calls itself. These are
	// the cases where no response arrived at all.
	return chain.some((e) => {
		if (RETRYABLE_NAMES.has(e.name)) return true;
		if (typeof e.code === 'string' && RETRYABLE_MESSAGE.test(e.code)) return true;
		if (typeof e.message === 'string' && RETRYABLE_MESSAGE.test(e.message)) return true;
		return false;
	});
}

export default class MnemonadRateLimiter {
	/**
	 * @param {Object} [params={}]
	 * @param {?number} [params.maxPerSecond] - omit/null for unlimited (no pacing)
	 * @param {number} [params.attempts=4] - total tries per read, including the first. 1
	 *   disables retrying.
	 * @param {number} [params.baseDelayMs=250] - first backoff; doubles from there.
	 * @param {number} [params.maxDelayMs=4000] - ceiling on any single backoff.
	 * @param {boolean} [params.jitter=true] - spreads the retries of a simultaneous burst so
	 *   they do not come back in lockstep and collide again.
	 * @param {?(info: {error: Error, attempt: number, delayMs: number, method: ?string}) => void}
	 *   [params.onRetry] - observation hook; the SDK carries no logger of its own.
	 * @param {?(ms: number) => Promise<void>} [params.sleep] - injectable for tests.
	 */
	constructor(params = {}) {
		/** @type {?number} */
		this.maxPerSecond = params.maxPerSecond ?? null;
		this.attempts = params.attempts ?? 4;
		this.baseDelayMs = params.baseDelayMs ?? 250;
		this.maxDelayMs = params.maxDelayMs ?? 4000;
		this.jitter = params.jitter ?? true;
		this.onRetry = params.onRetry ?? null;
		this._sleep = params.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		/** @type {number[]} Start times of calls admitted within the trailing 1s window. */
		this._timestamps = [];
		/** @type {Array<() => void>} FIFO — a burst is never reordered. */
		this._queue = [];
		/** @type {?ReturnType<typeof setTimeout>} */
		this._timer = null;
	}

	/**
	 * Backoff before the retry that follows `failures` failed attempts (1-based).
	 *
	 * Doubles from `baseDelayMs`, so the defaults give `250, 500, 1000` — the third wait
	 * clears the one-second window the first two sit inside. That crossing is the whole
	 * point; shortening the base defeats it.
	 *
	 * @param {number} failures
	 * @returns {number} milliseconds
	 */
	delayFor(failures) {
		const full = Math.min(this.baseDelayMs * 2 ** (failures - 1), this.maxDelayMs);
		// The full delay stays the ceiling: jitter only ever shortens.
		return this.jitter ? Math.round(full * (0.5 + Math.random() * 0.5)) : full;
	}

	/**
	 * Runs `fn` through the pacer, retrying transient failures — each attempt re-queued so a
	 * retry never jumps the rate limit.
	 *
	 * @template T
	 * @param {() => Promise<T>} fn
	 * @param {?string} [method] - name passed to the `onRetry` hook.
	 * @returns {Promise<T>}
	 */
	async runWithRetry(fn, method = null) {
		for (let failures = 0; ; failures += 1) {
			try {
				return await this.run(fn);
			} catch (err) {
				// Rethrow the original rather than a wrapper: viem's error class and its
				// shortMessage are what callers switch on, and a retry layer should be
				// invisible in the failure case rather than a new error type to handle.
				if (failures + 1 >= this.attempts || !isTransientRpcError(err)) throw err;

				const delayMs = this.delayFor(failures + 1);
				this.onRetry?.({ error: err, attempt: failures + 1, delayMs, method });
				await this._sleep(delayMs);
			}
		}
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
	 * Reads additionally retry; `writeContract` is paced but never repeated, because it is
	 * the one method here that changes state and a duplicate send costs real money.
	 *
	 * Wrapping an already-wrapped client returns it unchanged, so applying this at two
	 * layers cannot multiply the attempt count.
	 *
	 * @param {Object} client
	 * @returns {Object} a client-shaped object; everything not listed above (chain, account,
	 *   transport, other actions) passes through unchanged via the prototype chain.
	 */
	wrapClient(client) {
		if (!client || client[WRAPPED]) return client;

		const limiter = this;
		const wrapped = Object.create(client);
		const methods = [
			'readContract',
			'simulateContract',
			'writeContract',
			'getBlockNumber',
			'waitForTransactionReceipt',
			'getTransactionReceipt',
			'getBalance',
			'estimateContractGas',
			'estimateGas',
			'getGasPrice',
			'getChainId',
			'call',
		];
		for (const name of methods) {
			if (typeof client[name] !== 'function') continue;
			wrapped[name] = RETRYABLE_METHODS.has(name)
				? (...args) => limiter.runWithRetry(() => client[name](...args), name)
				: (...args) => limiter.run(() => client[name](...args));
		}
		Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false });
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
