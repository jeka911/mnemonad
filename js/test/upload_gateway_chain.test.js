import { describe, it, expect } from 'vitest';
import MnemonadUploadGateway from '../MnemonadUploadGateway.js';

/**
 * Regression cover for how `chain` reaches viem on a gateway write.
 *
 * viem reads three distinct meanings from that field — a chain object asserts the wallet is
 * on that network, `null` waives the assertion, and `undefined` falls back to the wallet
 * client's own `chain`. Forwarding `walletClient.chain` unconditionally therefore passes
 * `undefined` whenever the wallet client carries none, and viem rejects the write with "No
 * chain was provided to the request" before the wallet is ever asked. A wagmi client in the
 * browser is exactly that case, so the first click on a paid upload failed.
 *
 * Pure unit tests: they assert on the request handed to `writeContract`, so no node runs.
 */

const ADDRESS = '0x000000000000000000000000000000000000dEaD';
const PAYER = '0x00000000000000000000000000000000000000A1';
const CONTENT_HASH = `0x${'11'.repeat(32)}`;
const MONAD_TESTNET = { id: 10143, name: 'Monad Testnet' };

/** Captures the request rather than sending it. */
function harness({ walletChain, publicChain }) {
	const captured = {};
	const publicClient = {
		chain: publicChain,
		readContract: async () => 1234n, // the quote payForUpload fetches when no value is given
		waitForTransactionReceipt: async () => ({ status: 'success' }),
	};
	const walletClient = {
		chain: walletChain,
		account: { address: PAYER, type: 'json-rpc' },
		writeContract: async (request) => {
			Object.assign(captured, request);
			return `0x${'ab'.repeat(32)}`;
		},
	};
	const gateway = new MnemonadUploadGateway({ publicClient, walletClient, address: ADDRESS });
	return { gateway, captured };
}

describe('MnemonadUploadGateway chain resolution', () => {
	it('falls back to the public client when the wallet client has no chain', async () => {
		const { gateway, captured } = harness({ walletChain: undefined, publicChain: MONAD_TESTNET });

		await gateway.payForUpload(CONTENT_HASH, 1024);

		// The precise failure being guarded: anything undefined here reaches viem as "no
		// chain at all" and the write never leaves the SDK.
		expect(captured.chain).toBe(MONAD_TESTNET);
		expect(captured.chain).toBeDefined();
	});

	it('prefers the wallet client when both know the chain', async () => {
		const walletChain = { id: 10143, name: 'From wallet' };
		const { gateway, captured } = harness({ walletChain, publicChain: MONAD_TESTNET });

		await gateway.payForUpload(CONTENT_HASH, 1024);

		expect(captured.chain).toBe(walletChain);
	});

	it('waives the check with null, never undefined, when neither knows the chain', async () => {
		const { gateway, captured } = harness({ walletChain: undefined, publicChain: undefined });

		await gateway.payForUpload(CONTENT_HASH, 1024);

		// `null` tells viem "do not assert the network"; `undefined` tells it "look it up",
		// which then fails. The two are not interchangeable.
		expect(captured.chain).toBeNull();
	});

	it('passes the account object, not a bare address', async () => {
		const { gateway, captured } = harness({ walletChain: undefined, publicChain: MONAD_TESTNET });

		await gateway.payForUpload(CONTENT_HASH, 1024);

		// Same reasoning as Mnemonad._write: viem dispatches on the account's type, and a
		// bare address forces eth_sendTransaction, which public RPCs reject.
		expect(captured.account).toEqual({ address: PAYER, type: 'json-rpc' });
	});

	it('sends the quoted value when the caller supplies none', async () => {
		const { gateway, captured } = harness({ walletChain: undefined, publicChain: MONAD_TESTNET });

		await gateway.payForUpload(CONTENT_HASH, 1024);

		expect(captured.value).toBe(1234n);
	});
});
