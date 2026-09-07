import { describe, it, expect, beforeEach, vi } from 'vitest';
import Mnemonad from '../Mnemonad.js';
import {
	getRpcCallCount,
	getRpcCallLog,
	subscribeRpcCalls,
	resetRpcCalls,
} from '../MnemonadRpcRecorder.js';

function fakeClient(chainId) {
	return {
		chain: { id: chainId },
		async readContract(args) {
			if (args.functionName === 'boom') throw new Error('execution reverted: boom');
			return `read:${args.functionName}`;
		},
		async writeContract(args) { return `write:${args.functionName}`; },
		async getBlockNumber() { return 123n; },
		async getChainId() { return chainId; },
		async somethingElse() { return 'passthrough'; },
	};
}

// The log/counter is process-wide (see MnemonadRpcRecorder's own file comment for why), so
// every test needs a clean slate — otherwise counts leak across tests and assertions become
// order-dependent.
beforeEach(() => {
	resetRpcCalls();
});

describe('MnemonadRpcRecorder', () => {
	it('starts at zero and stays there until something opts in', () => {
		expect(getRpcCallCount()).toBe(0);
		expect(getRpcCallLog()).toEqual([]);
	});

	it('does not record calls made through a plain (non-debug) Mnemonad instance', async () => {
		const chainId = 900101;
		const m = new Mnemonad({ publicClient: fakeClient(chainId) });
		await m.publicClient.readContract({ functionName: 'length' });
		await m.publicClient.getBlockNumber();
		expect(getRpcCallCount()).toBe(0);
	});

	it('records every network-hitting call made through a debug: true instance', async () => {
		const chainId = 900102;
		const m = new Mnemonad({ publicClient: fakeClient(chainId), debug: true });

		await m.publicClient.readContract({ functionName: 'length' });
		await m.publicClient.getBlockNumber();
		await m.publicClient.getChainId();
		expect(getRpcCallCount()).toBe(3);

		// Not in NETWORK_CLIENT_METHODS — passes through unrecorded, same as wrapClient.
		await m.publicClient.somethingElse();
		expect(getRpcCallCount()).toBe(3);

		const log = getRpcCallLog();
		expect(log.map((e) => e.method)).toEqual(['readContract', 'getBlockNumber', 'getChainId']);
		expect(log[0].functionName).toBe('length');
		expect(log[0].chainId).toBe(chainId);
		// getBlockNumber has no functionName argument to read one from.
		expect(log[1].functionName).toBeNull();
		// Awaited above, so every entry has already settled to 'ok'.
		expect(log.map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);
		expect(log.map((e) => e.position)).toEqual([1, 2, 3]);
	});

	it('records a call as pending immediately, before it settles', async () => {
		const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
		const promise = m.publicClient.readContract({ functionName: 'x' });

		// Synchronous check, deliberately before awaiting: the entry exists and is 'pending'
		// the instant the call is initiated, not only once it resolves.
		expect(getRpcCallLog()[0].status).toBe('pending');

		await promise;
		expect(getRpcCallLog()[0].status).toBe('ok');
	});

	it('shares the log across independent debug instances — it is process-wide, not per-instance', async () => {
		const a = new Mnemonad({ publicClient: fakeClient(1), debug: true });
		const b = new Mnemonad({ publicClient: fakeClient(2), debug: true });

		await a.publicClient.readContract({ functionName: 'x' });
		await b.publicClient.readContract({ functionName: 'y' });
		expect(getRpcCallCount()).toBe(2);
	});

	it('notifies subscribers twice per call — once recorded (pending), once settled (ok)', async () => {
		const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
		const seen = [];
		const unsubscribe = subscribeRpcCalls((info) => seen.push([info.count, info.entry.status]));

		await m.publicClient.readContract({ functionName: 'a' });
		await m.publicClient.readContract({ functionName: 'b' });
		expect(seen).toEqual([
			[1, 'pending'], [1, 'ok'],
			[2, 'pending'], [2, 'ok'],
		]);

		unsubscribe();
		await m.publicClient.readContract({ functionName: 'c' });
		expect(seen.length).toBe(4); // stopped receiving after unsubscribe
		expect(getRpcCallCount()).toBe(3); // but recording itself is unaffected
	});

	it('a faulty subscriber cannot break the call it is observing', async () => {
		const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
		subscribeRpcCalls(() => { throw new Error('boom'); });

		await expect(m.publicClient.readContract({ functionName: 'x' })).resolves.toBe('read:x');
		expect(getRpcCallCount()).toBe(1);
	});

	it('caps the log at 2000 entries, dropping the oldest first', async () => {
		const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
		for (let i = 0; i < 2005; i += 1) {
			await m.publicClient.readContract({ functionName: `f${i}` });
		}
		expect(getRpcCallCount()).toBe(2005); // the counter itself is uncapped
		const log = getRpcCallLog();
		expect(log.length).toBe(2000);
		expect(log[0].functionName).toBe('f5'); // the first 5 aged out
		expect(log[log.length - 1].functionName).toBe('f2004');
	});

	describe('failed calls', () => {
		it('still rejects to the real caller — the recorder only observes, never swallows', async () => {
			const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
			await expect(m.publicClient.readContract({ functionName: 'boom' })).rejects.toThrow(
				'execution reverted: boom'
			);
		});

		it('marks the entry \'error\' with the failure message, and still counts it', async () => {
			const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
			await m.publicClient.readContract({ functionName: 'ok1' }).catch(() => {});
			await m.publicClient.readContract({ functionName: 'boom' }).catch(() => {});

			expect(getRpcCallCount()).toBe(2); // a failed call still happened — still counts
			const log = getRpcCallLog();
			expect(log[0].status).toBe('ok');
			expect(log[1].status).toBe('error');
			expect(log[1].error).toBe('execution reverted: boom');
		});

		it('logs failed calls to the console, even with nothing subscribed', async () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
				await m.publicClient.readContract({ functionName: 'boom' }).catch(() => {});

				expect(spy).toHaveBeenCalledTimes(1);
				const [message, err] = spy.mock.calls[0];
				expect(message).toContain('boom');
				expect(err).toBeInstanceOf(Error);
			} finally {
				spy.mockRestore();
			}
		});

		it('notifies subscribers of the failure — pending, then error', async () => {
			const m = new Mnemonad({ publicClient: fakeClient(1), debug: true });
			const seen = [];
			subscribeRpcCalls((info) => seen.push(info.entry.status));

			await m.publicClient.readContract({ functionName: 'boom' }).catch(() => {});
			expect(seen).toEqual(['pending', 'error']);
		});
	});
});
