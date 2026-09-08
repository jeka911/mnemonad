import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MnemonadRateLimiter from '../MnemonadRateLimiter.js';
import Mnemonad from '../Mnemonad.js';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('MnemonadRateLimiter', () => {
	it('is a no-op without maxPerSecond', async () => {
		const limiter = new MnemonadRateLimiter();
		const calls = [];
		await Promise.all([1, 2, 3, 4, 5].map((n) => limiter.run(async () => calls.push(n))));
		expect(calls.sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it('admits up to the limit immediately, delays the rest', async () => {
		const limiter = new MnemonadRateLimiter({ maxPerSecond: 2 });
		const order = [];
		const done = [1, 2, 3].map((n) => limiter.run(async () => { order.push(n); return n; }));

		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual([1, 2]); // the third is queued, not yet admitted

		await vi.advanceTimersByTimeAsync(1001);
		expect(order).toEqual([1, 2, 3]);

		await Promise.all(done);
	});

	it('preserves FIFO order across the delayed boundary', async () => {
		const limiter = new MnemonadRateLimiter({ maxPerSecond: 1 });
		const order = [];
		const done = [1, 2, 3].map((n) => limiter.run(async () => { order.push(n); return n; }));

		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual([1]);

		await vi.advanceTimersByTimeAsync(1001);
		expect(order).toEqual([1, 2]);

		await vi.advanceTimersByTimeAsync(1001);
		expect(order).toEqual([1, 2, 3]);

		await Promise.all(done);
	});

	it('lets a fresh window admit calls again after the burst ages out', async () => {
		const limiter = new MnemonadRateLimiter({ maxPerSecond: 2 });
		const order = [];
		const run = (n) => limiter.run(async () => { order.push(n); });

		await Promise.all([run(1), run(2)]);
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual([1, 2]);

		await vi.advanceTimersByTimeAsync(1001);
		await run(3);
		expect(order).toEqual([1, 2, 3]); // window reset — no queueing needed
	});
});

describe('MnemonadRateLimiter.wrapClient', () => {
	function makeFakeClient() {
		return {
			chain: { id: 10143 },
			async readContract(args) { return `read:${args.functionName}`; },
			async writeContract(args) { return `write:${args.functionName}`; },
			async getBlockNumber() { return 123n; },
			async estimateContractGas(args) { return `gas:${args.functionName}`; },
			async getGasPrice() { return 1_000_000_000n; },
			async getChainId() { return 10143; },
			async somethingElse() { return 'passthrough'; },
		};
	}

	it('routes limited methods through run(), leaves everything else untouched', async () => {
		// A generous rate: this test is about which methods route through run(), not
		// about throttling — a rate of 1 would need timer advancement between every
		// call below to avoid hanging on an unresolved queued promise.
		const limiter = new MnemonadRateLimiter({ maxPerSecond: 10 });
		const spy = vi.spyOn(limiter, 'run');
		const wrapped = limiter.wrapClient(makeFakeClient());

		expect(wrapped.chain).toEqual({ id: 10143 }); // passthrough via prototype chain
		expect(await wrapped.somethingElse()).toBe('passthrough'); // not wrapped
		expect(spy).not.toHaveBeenCalled();

		await expect(wrapped.readContract({ functionName: 'length' })).resolves.toBe('read:length');
		expect(spy).toHaveBeenCalledTimes(1);

		// estimatePushCost's own probes — the exact gap that motivated adding these.
		await expect(wrapped.estimateContractGas({ functionName: 'push' })).resolves.toBe('gas:push');
		await expect(wrapped.getGasPrice()).resolves.toBe(1_000_000_000n);
		await expect(wrapped.getChainId()).resolves.toBe(10143);
		expect(spy).toHaveBeenCalledTimes(4);
	});

	it('actually throttles calls made through the wrapped client', async () => {
		const limiter = new MnemonadRateLimiter({ maxPerSecond: 1 });
		const wrapped = limiter.wrapClient(makeFakeClient());
		const order = [];

		const done = [1, 2].map((n) =>
			wrapped.readContract({ functionName: String(n) }).then(() => order.push(n))
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual([1]);

		await vi.advanceTimersByTimeAsync(1001);
		expect(order).toEqual([1, 2]);

		await Promise.all(done);
	});
});

describe('Mnemonad maxRPCRequestsPerSecond', () => {
	function fakeClient(chainId) {
		return {
			chain: { id: chainId },
			async readContract() { return 'ok'; },
		};
	}

	it('shares one budget across instances with the same rate + chain', async () => {
		// Exactly the real bug: hydrating several streams concurrently, each its own
		// Mnemonad instance — the limit must hold across all of them, not per instance.
		const chainId = 900001;
		const a = new Mnemonad({ publicClient: fakeClient(chainId), maxRPCRequestsPerSecond: 1 });
		const b = new Mnemonad({ publicClient: fakeClient(chainId), maxRPCRequestsPerSecond: 1 });
		const order = [];

		const done = [
			a.publicClient.readContract({ functionName: 'x' }).then(() => order.push('a')),
			b.publicClient.readContract({ functionName: 'y' }).then(() => order.push('b')),
		];

		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(['a']); // only one admitted immediately — shared 1/sec budget

		await vi.advanceTimersByTimeAsync(1001);
		expect(order).toEqual(['a', 'b']);

		await Promise.all(done);
	});

	it('does not throttle across different chains at the same rate', async () => {
		const a = new Mnemonad({ publicClient: fakeClient(900002), maxRPCRequestsPerSecond: 1 });
		const b = new Mnemonad({ publicClient: fakeClient(900003), maxRPCRequestsPerSecond: 1 });
		const order = [];

		await Promise.all([
			a.publicClient.readContract({ functionName: 'x' }).then(() => order.push('a')),
			b.publicClient.readContract({ functionName: 'y' }).then(() => order.push('b')),
		]);

		expect(order.sort()).toEqual(['a', 'b']); // both admitted without waiting
	});

	it('does not pace without maxRPCRequestsPerSecond, but still wraps for retry', async () => {
		// The client is wrapped either way, because the wrapper carries retrying as well as
		// pacing and a transient RPC failure is worth another try whether or not the caller
		// asked to be throttled. What opting out of a rate buys is that nothing is ever
		// delayed: every call is admitted the moment it is made.
		const client = fakeClient(900004);
		const ev = new Mnemonad({ publicClient: client });

		expect(ev.publicClient).not.toBe(client);
		// Everything the wrapper does not override still reads through to the real client.
		expect(ev.publicClient.chain).toBe(client.chain);

		const order = [];
		await Promise.all([
			ev.publicClient.readContract({ functionName: 'x' }).then(() => order.push('x')),
			ev.publicClient.readContract({ functionName: 'y' }).then(() => order.push('y')),
			ev.publicClient.readContract({ functionName: 'z' }).then(() => order.push('z')),
		]);

		// No timer advance needed anywhere above: nothing was queued.
		expect(order.sort()).toEqual(['x', 'y', 'z']);
	});
});

describe('Mnemonad rpcRetry', () => {
	// Real timers, not the file's fake ones: these tests exercise actual retry delays
	// (`baseDelayMs: 1`), and asserting on the resulting backoff timing isn't the point here
	// (rate_limiter_retry.test.js already covers that in detail) — only that `rpcRetry`
	// reaches the limiter at all, which is simplest to prove by just letting 1ms delays run.
	beforeEach(() => {
		vi.useRealTimers();
	});

	/** A client whose first `attempts - 1` reads fail with a transient error. */
	function flakyClient(chainId, failUntilAttempt) {
		let calls = 0;
		return {
			chain: { id: chainId },
			async readContract() {
				calls += 1;
				if (calls < failUntilAttempt) {
					const err = new Error('rate limited');
					err.name = 'HttpRequestError';
					err.status = 429;
					throw err;
				}
				return 'ok';
			},
		};
	}

	it('reaches the shared limiter — a higher attempts budget survives more failures', async () => {
		// MnemonadRateLimiter's own default (attempts: 4) would give up before the 5th try;
		// this only passes if params.rpcRetry actually reached the limiter underneath.
		const ev = new Mnemonad({
			publicClient: flakyClient(900010, 5),
			rpcRetry: { attempts: 6, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
		});
		await expect(ev.publicClient.readContract({ functionName: 'x' })).resolves.toBe('ok');
	});

	it('still gives up per the class default when rpcRetry is omitted', async () => {
		const ev = new Mnemonad({ publicClient: flakyClient(900011, 5) });
		await expect(ev.publicClient.readContract({ functionName: 'x' })).rejects.toThrow('rate limited');
	});

	it('does not share a limiter between differently-configured rpcRetry on the same chain+rate', async () => {
		// Same chain, same maxRPCRequestsPerSecond — only rpcRetry differs. If these shared a
		// limiter, whichever instance's config "won" would silently apply to both.
		const chainId = 900012;
		const generous = new Mnemonad({
			publicClient: flakyClient(chainId, 5),
			maxRPCRequestsPerSecond: 50,
			rpcRetry: { attempts: 6, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
		});
		const strict = new Mnemonad({
			publicClient: flakyClient(chainId, 5),
			maxRPCRequestsPerSecond: 50,
			rpcRetry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
		});

		await expect(generous.publicClient.readContract({ functionName: 'x' })).resolves.toBe('ok');
		await expect(strict.publicClient.readContract({ functionName: 'y' })).rejects.toThrow('rate limited');
	});
});
