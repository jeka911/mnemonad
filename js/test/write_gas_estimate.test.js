import { describe, it, expect, vi } from 'vitest';
import Mnemonad from '../Mnemonad.js';

/**
 * Regression cover for `_write`'s explicit gas limit.
 *
 * Found live against Monad testnet: a ~97 KB CODE-tier `push` simulates at ~21.5M gas —
 * comfortably under the 30M per-tx cap — yet failed with "Exceeds transaction gas limit"
 * when left to a connected wallet's own estimation. Monad also bills the gas *limit*, not
 * gas used, so an unbuffered/wallet-padded estimate is a direct overcharge even when it
 * succeeds. `_write` now always supplies an explicit `gas`, computed from its own
 * simulation, so neither failure mode depends on how any particular wallet estimates.
 *
 * Pure unit tests: fake clients, no node, so they assert on exactly what request
 * `writeContract` receives.
 */

const ADDRESS = '0x000000000000000000000000000000000000dEaD';
const SENDER = '0x00000000000000000000000000000000000000A1';
const MONAD_TESTNET = { id: 10143, name: 'Monad Testnet' };

/** Builds a Mnemonad instance whose clients are fully under the test's control. */
function harness({ estimatedGas, estimateError } = {}) {
	const captured = {};
	const estimateContractGas = vi.fn(async () => {
		if (estimateError) throw estimateError;
		return estimatedGas;
	});
	const publicClient = {
		chain: MONAD_TESTNET,
		estimateContractGas,
		waitForTransactionReceipt: async () => ({ status: 'success', transactionHash: '0xreceipt' }),
	};
	const walletClient = {
		chain: MONAD_TESTNET,
		account: { address: SENDER, type: 'json-rpc' },
		writeContract: async (request) => {
			Object.assign(captured, request);
			return '0xhash';
		},
	};
	const vector = new Mnemonad({ publicClient, walletClient, contractAddress: ADDRESS, id: 1n });
	return { vector, captured, estimateContractGas };
}

describe('Mnemonad._write gas estimate', () => {
	it('passes a buffered gas limit computed from its own simulation', async () => {
		const { vector, captured } = harness({ estimatedGas: 21_471_629n });

		await vector._write('push', [1n, 0n, '0xdata', '0x'], { value: 0n });

		// The buffer matches estimatePushCost's own 10% convention, not an arbitrary figure.
		expect(captured.gas).toBe((21_471_629n * 110n) / 100n);
	});

	it('simulates the exact call being sent, address/functionName/args/account/value', async () => {
		const { vector, estimateContractGas } = harness({ estimatedGas: 100_000n });

		await vector._write('push', [1n, 0n, '0xdata', '0x'], { value: 42n });

		expect(estimateContractGas).toHaveBeenCalledWith(
			expect.objectContaining({
				address: ADDRESS,
				functionName: 'push',
				args: [1n, 0n, '0xdata', '0x'],
				account: { address: SENDER, type: 'json-rpc' },
				value: 42n,
			})
		);
	});

	it('respects an explicit options.gas and skips estimation entirely', async () => {
		const { vector, captured, estimateContractGas } = harness({ estimatedGas: 999_999_999n });

		await vector._write('push', [1n, 0n, '0xdata', '0x'], { value: 0n, gas: 250_000n });

		expect(captured.gas).toBe(250_000n);
		expect(estimateContractGas).not.toHaveBeenCalled();
	});

	it('falls through with no explicit gas when simulation fails', async () => {
		// A stale expectedLength, an unauthorized caller, etc. — the write itself is about
		// to fail anyway; this must not swallow that into a confusing "no gas" state, and
		// must not throw here either. It should just proceed unbuffered, exactly like
		// before this fix existed.
		const { vector, captured } = harness({ estimateError: new Error('IndexOutOfBounds') });

		await vector._write('push', [1n, 0n, '0xdata', '0x'], { value: 0n });

		expect(captured.gas).toBeUndefined();
	});

	it('never retries a transient estimateContractGas failure into a stuck write', async () => {
		// Not a retry test in itself — just confirms the catch is unconditional (any
		// failure, not only deterministic ones), since _write has no business deciding
		// which estimation failures are worth retrying; that judgment belongs to the rate
		// limiter's own wrapClient, one layer below this.
		const { vector, captured } = harness({ estimateError: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) });

		await expect(vector._write('push', [1n, 0n, '0xdata', '0x'], { value: 0n })).resolves.toBeTruthy();
		expect(captured.gas).toBeUndefined();
	});
});
