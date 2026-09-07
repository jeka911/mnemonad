import { NETWORK_CLIENT_METHODS } from './MnemonadRateLimiter.js';

/**
 * A process-wide log of every RPC call any `Mnemonad` instance makes with `params.debug: true`
 * — purely observational, no effect on caching, pacing, or retrying.
 *
 * Deliberately global rather than per-instance. The question this exists to answer is "how
 * much has this session/tab actually talked to the chain", and an app typically constructs a
 * fresh `Mnemonad` per page load or per write — a per-instance counter would reset constantly
 * and never add up to anything a debug panel could show. Every debug-enabled instance, and
 * every static helper that opts in, writes into the same log.
 *
 * Recording happens *outside* `MnemonadRateLimiter`'s own wrap, not inside it: this wraps the
 * already rate-limited/retrying client one layer further out, so one call from `Mnemonad`'s
 * own business logic is one log entry regardless of how many times the limiter retries it
 * underneath. Counting retries here would make a transient 503 look like several real calls
 * for exactly the RPC-count number this exists to make trustworthy.
 */

/** Hard cap so a long-lived tab can't grow this without bound; oldest entries drop first. */
const MAX_LOG_ENTRIES = 2000;

/**
 * @typedef {Object} RpcCallLogEntry
 * @property {number} position - 1-based, stable for this entry's whole lifetime — the same
 *   number `getRpcCallCount()` reached when this call was made, so a caller can tell "this is
 *   call #6" without recomputing it from array position (which shifts once the log evicts).
 * @property {string} method
 * @property {?string} functionName
 * @property {?number} chainId
 * @property {number} at - when the call was initiated, not when it settled. Deliberate: this
 *   is what shows how tightly a burst of concurrent calls actually clustered; completion time
 *   would just reflect network latency instead.
 * @property {'pending'|'ok'|'error'} status - starts 'pending', settles in place once the
 *   underlying call resolves or rejects — see {@link wrapClientForRecording}.
 * @property {?string} error - set only once `status` becomes 'error'.
 */

/** @type {RpcCallLogEntry[]} */
const _log = [];
let _count = 0;
/** @type {Set<(info: {count: number, entry: RpcCallLogEntry}) => void>} */
const _listeners = new Set();

/** Marks a recording-wrapped client, so wrapping twice cannot double-count. */
const RECORDING_WRAPPED = Symbol.for('mnemonad.rpcrecorder.wrapped');

/**
 * @param {{method: string, functionName: ?string, chainId: ?number}} entry
 * @returns {RpcCallLogEntry} the live entry — mutated in place by
 *   {@link wrapClientForRecording} once the call settles, so callers holding a reference (the
 *   wrapper itself) see it update without a second lookup.
 */
function _record(entry) {
	_count += 1;
	const full = { ...entry, at: Date.now(), status: 'pending', error: null, position: _count };
	_log.push(full);
	if (_log.length > MAX_LOG_ENTRIES) _log.shift();
	_notify(full);
	return full;
}

/** @param {RpcCallLogEntry} entry */
function _notify(entry) {
	for (const fn of _listeners) {
		// A listener throwing must never break the call it's observing.
		try {
			fn({ count: _count, entry });
		} catch {
			// swallow
		}
	}
}

/** @returns {number} Total RPC calls recorded so far this session (pending, ok, or error). */
export function getRpcCallCount() {
	return _count;
}

/**
 * @returns {RpcCallLogEntry[]} A copy of the most recent calls (oldest first), capped at
 *   {@link MAX_LOG_ENTRIES}. Each entry is the same live object `subscribeRpcCalls` hands out,
 *   so a caller that keeps hold of one sees its `status` update once the call settles.
 */
export function getRpcCallLog() {
	return _log.slice();
}

/**
 * @param {(info: {count: number, entry: RpcCallLogEntry}) => void} fn - called once when a
 *   call is recorded ('pending'), and again when it settles ('ok'/'error') — match on
 *   `entry.position` to tell an update from a new call.
 * @returns {() => void} unsubscribe
 */
export function subscribeRpcCalls(fn) {
	_listeners.add(fn);
	return () => _listeners.delete(fn);
}

/** Clears the count and log. Does not affect subscriptions. */
export function resetRpcCalls() {
	_count = 0;
	_log.length = 0;
}

/**
 * Wraps a viem Public/Wallet client so every method that actually hits the network is recorded
 * into the global log before delegating to `client`. Everything not in
 * `NETWORK_CLIENT_METHODS` passes through unchanged via the prototype chain, same as
 * `MnemonadRateLimiter.wrapClient`.
 *
 * A failed call is never swallowed here — the original promise still rejects to its real
 * caller exactly as if this wrapper didn't exist. This only *observes* the settlement, to (a)
 * flip the entry to 'error' for anything watching the log (`console.error` included, so a
 * failure is visible even with the debug panel closed) and (b) leave a readable trail for
 * whichever caller's own error handling already fired (a toast, a thrown error) — this is a
 * second, independent view of the same failure, not a replacement for either.
 *
 * @param {Object} client
 * @param {{chainId: ?number}} [context] - attached to every entry recorded through this wrap.
 * @returns {Object}
 */
export function wrapClientForRecording(client, context = {}) {
	if (!client || client[RECORDING_WRAPPED]) return client;

	const wrapped = Object.create(client);
	for (const name of NETWORK_CLIENT_METHODS) {
		if (typeof client[name] !== 'function') continue;
		wrapped[name] = (...args) => {
			const entry = _record({
				method: name,
				// readContract/writeContract/simulateContract/estimateContractGas all take a
				// { functionName, ... } object as their one argument; everything else
				// (getBlockNumber, getChainId, getGasPrice, ...) doesn't have one.
				functionName: args[0]?.functionName ?? null,
				chainId: context.chainId ?? null,
			});
			const result = client[name](...args);
			// A side observer, not a second consumer: `.then` here creates its own derived
			// promise that nothing awaits, so a rejection handled here can never surface as
			// an unhandled rejection, and `result` itself is returned untouched below for the
			// real caller to await/catch as usual.
			result.then(
				() => {
					entry.status = 'ok';
					_notify(entry);
				},
				(err) => {
					entry.status = 'error';
					entry.error = err?.shortMessage || err?.message || String(err);
					_notify(entry);
					console.error(
						`[Mnemonad] RPC call failed: ${entry.functionName ?? entry.method}`,
						err
					);
				}
			);
			return result;
		};
	}
	Object.defineProperty(wrapped, RECORDING_WRAPPED, { value: true, enumerable: false });
	return wrapped;
}
