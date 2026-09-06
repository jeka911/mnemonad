import { describe, it, expect } from 'vitest';
import MnemonadRateLimiter, { isTransientRpcError } from '../MnemonadRateLimiter.js';

/**
 * Cover for the retry half of MnemonadRateLimiter.
 *
 * All timing is injected via `sleep`, so these assert on the delays that *would* be waited
 * rather than actually waiting them — the suite stays fast and the backoff schedule becomes
 * something we can assert on exactly.
 */

/** Builds a viem-shaped error: a named wrapper around a cause, like viem nests them. */
function viemError(name, props = {}, cause = undefined) {
	const err = new Error(props.message ?? name);
	err.name = name;
	Object.assign(err, props);
	if (cause) err.cause = cause;
	return err;
}

/** A limiter that records its backoffs instead of sleeping. */
function testLimiter(params = {}) {
	const slept = [];
	const limiter = new MnemonadRateLimiter({
		jitter: false,
		sleep: async (ms) => void slept.push(ms),
		...params,
	});
	return { limiter, slept };
}

/** A client whose `readContract` fails `failures` times before succeeding. */
function flakyClient(error, failures) {
	const calls = { readContract: 0, writeContract: 0 };
	return {
		calls,
		readContract: async () => {
			calls.readContract += 1;
			if (calls.readContract <= failures) throw error;
			return 'ok';
		},
		writeContract: async () => {
			calls.writeContract += 1;
			if (calls.writeContract <= failures) throw error;
			return '0xhash';
		},
	};
}

describe('isTransientRpcError', () => {
	it('retries the failures that mean "the endpoint is busy"', () => {
		expect(isTransientRpcError(viemError('HttpRequestError', { status: 429 }))).toBe(true);
		expect(isTransientRpcError(viemError('HttpRequestError', { status: 503 }))).toBe(true);
		expect(isTransientRpcError(viemError('TimeoutError'))).toBe(true);
		expect(isTransientRpcError(viemError('LimitExceededRpcError', { code: -32005 }))).toBe(true);
		expect(isTransientRpcError(new TypeError('Failed to fetch'))).toBe(true);
		expect(isTransientRpcError(viemError('Error', { code: 'ECONNRESET' }))).toBe(true);
	});

	it('finds a transient cause nested under a viem wrapper', () => {
		// How this actually arrives in practice: viem wraps the transport failure in a
		// call-level error, so only the cause carries the status.
		const wrapped = viemError(
			'ContractFunctionExecutionError',
			{ message: 'readContract failed' },
			viemError('HttpRequestError', { status: 429 })
		);
		expect(isTransientRpcError(wrapped)).toBe(true);
	});

	it('never retries a revert, however deeply it is wrapped', () => {
		// The case that makes a naive "retry any ContractFunctionExecutionError" wrong: a
		// revert is a real answer, and repeating it just returns the same answer slower.
		const reverted = viemError(
			'ContractFunctionExecutionError',
			{},
			viemError('ContractFunctionRevertedError', { message: 'IndexOutOfBounds' })
		);
		expect(isTransientRpcError(reverted)).toBe(false);
	});

	it('does not retry a revert that also carries a transient-looking status', () => {
		// A revert veto has to beat the status check, not merely coexist with it — some
		// nodes answer a reverted eth_call with a 500.
		const reverted = viemError(
			'HttpRequestError',
			{ status: 500 },
			viemError('ContractFunctionRevertedError', {})
		);
		expect(isTransientRpcError(reverted)).toBe(false);
	});

	it('leaves deterministic and unknown errors alone', () => {
		expect(isTransientRpcError(viemError('ChainMismatchError'))).toBe(false);
		expect(isTransientRpcError(viemError('AbiFunctionNotFoundError'))).toBe(false);
		expect(isTransientRpcError(viemError('HttpRequestError', { status: 400 }))).toBe(false);
		expect(isTransientRpcError(new Error('something else entirely'))).toBe(false);
		expect(isTransientRpcError(null)).toBe(false);
		expect(isTransientRpcError('nope')).toBe(false);
	});
});

describe('MnemonadRateLimiter retry', () => {
	it('retries a transient read and returns the eventual success', async () => {
		const { limiter, slept } = testLimiter();
		const client = flakyClient(viemError('HttpRequestError', { status: 429 }), 2);

		const result = await limiter.wrapClient(client).readContract({});

		expect(result).toBe('ok');
		expect(client.calls.readContract).toBe(3);
		expect(slept).toEqual([250, 500]);
	});

	it('backs off past one second, which viem\'s own retry never does', async () => {
		// The reason this layer exists. Monad's endpoint limits over a one-second window;
		// viem's 150/300/600ms schedule stays inside it, so all its attempts fail together.
		const { limiter, slept } = testLimiter();
		// Fails through the whole schedule and succeeds on the last attempt — the call viem
		// alone would have given up on.
		const client = flakyClient(viemError('HttpRequestError', { status: 429 }), 3);

		await expect(limiter.wrapClient(client).readContract({})).resolves.toBe('ok');

		expect(slept).toEqual([250, 500, 1000]);
		expect(Math.max(...slept)).toBeGreaterThanOrEqual(1000);
	});

	it('gives up after `attempts` and rethrows the original error untouched', async () => {
		const { limiter } = testLimiter({ attempts: 3 });
		const error = viemError('HttpRequestError', { status: 503, shortMessage: 'gone' });
		const client = flakyClient(error, 99);

		// Identity, not just shape: callers switch on viem's class and shortMessage, so a
		// retry layer must not replace the error it gives up on.
		await expect(limiter.wrapClient(client).readContract({})).rejects.toBe(error);
		expect(client.calls.readContract).toBe(3);
	});

	it('does not retry a revert', async () => {
		const { limiter, slept } = testLimiter();
		const reverted = viemError(
			'ContractFunctionExecutionError',
			{},
			viemError('ContractFunctionRevertedError', {})
		);
		const client = flakyClient(reverted, 99);

		await expect(limiter.wrapClient(client).readContract({})).rejects.toBe(reverted);
		expect(client.calls.readContract).toBe(1);
		expect(slept).toEqual([]);
	});

	it('NEVER retries writeContract, even on a transient failure', async () => {
		// The rule that protects money: a send that looks failed may already be in the
		// mempool, so a second attempt can pay twice.
		const { limiter } = testLimiter();
		const error = viemError('HttpRequestError', { status: 429 });
		const client = flakyClient(error, 1);

		await expect(limiter.wrapClient(client).writeContract({})).rejects.toBe(error);
		expect(client.calls.writeContract).toBe(1);
	});

	it('caps a single backoff at maxDelayMs', async () => {
		const { limiter, slept } = testLimiter({ attempts: 6, baseDelayMs: 500, maxDelayMs: 1500 });
		const client = flakyClient(viemError('TimeoutError'), 99);

		await expect(limiter.wrapClient(client).readContract({})).rejects.toThrow();

		expect(slept).toEqual([500, 1000, 1500, 1500, 1500]);
	});

	it('keeps jitter inside (0.5×, 1×] of the full delay', () => {
		const limiter = new MnemonadRateLimiter({ jitter: true, baseDelayMs: 1000 });
		for (let i = 0; i < 200; i += 1) {
			const delay = limiter.delayFor(1);
			// Jitter must only ever shorten: the documented schedule is the ceiling.
			expect(delay).toBeGreaterThanOrEqual(500);
			expect(delay).toBeLessThanOrEqual(1000);
		}
	});

	it('disables retrying with attempts: 1', async () => {
		const { limiter, slept } = testLimiter({ attempts: 1 });
		const error = viemError('HttpRequestError', { status: 429 });
		const client = flakyClient(error, 99);

		await expect(limiter.wrapClient(client).readContract({})).rejects.toBe(error);
		expect(client.calls.readContract).toBe(1);
		expect(slept).toEqual([]);
	});

	it('reports each retry through onRetry', async () => {
		const seen = [];
		const { limiter } = testLimiter({ onRetry: (info) => seen.push(info) });
		const client = flakyClient(viemError('HttpRequestError', { status: 429 }), 2);

		await limiter.wrapClient(client).readContract({});

		expect(seen.map((s) => [s.attempt, s.delayMs, s.method])).toEqual([
			[1, 250, 'readContract'],
			[2, 500, 'readContract'],
		]);
	});

	it('wrapping twice does not square the attempt count', async () => {
		const { limiter } = testLimiter();
		const client = flakyClient(viemError('HttpRequestError', { status: 429 }), 99);
		const once = limiter.wrapClient(client);

		expect(limiter.wrapClient(once)).toBe(once);
		await expect(once.readContract({})).rejects.toThrow();
		expect(client.calls.readContract).toBe(4);
	});

	it('paces every retry instead of letting it jump the queue', async () => {
		// The reason retry belongs in this class: an unpaced retry re-bursts against the
		// very limit that just rejected it.
		const admitted = [];
		const limiter = new MnemonadRateLimiter({
			maxPerSecond: 100, // high enough not to slow the test, still exercising the queue
			jitter: false,
			sleep: async () => {},
		});
		const client = {
			readContract: async () => {
				admitted.push(Date.now());
				if (admitted.length <= 2) throw viemError('HttpRequestError', { status: 429 });
				return 'ok';
			},
		};

		await limiter.wrapClient(client).readContract({});

		// Three admissions through the pacer, not one admission and two smuggled retries.
		expect(admitted).toHaveLength(3);
		expect(limiter._timestamps).toHaveLength(3);
	});
});
