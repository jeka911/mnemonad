#!/usr/bin/env node
/**
 * Smoke test: fires a real burst of `readContract` calls straight at Monad testnet's public
 * RPC (no client-side pacing) to reproduce a genuine rate-limit response, then reports its
 * exact shape via `describeErrorChain` and whether `isTransientRpcError` recognizes it.
 *
 * This is how `-32011` (Monad testnet RPC's own rate-limit code, not the more common EIP-1474
 * `-32005`) was found missing from `MnemonadRateLimiter`'s `RETRYABLE_RPC_CODES` — the app was
 * failing with "RPC Request failed" instead of retrying, and this script proved why against
 * the real endpoint rather than guessing from a browser console log.
 *
 * Run against contracts/ current testnet deployment (js/ids.js). Second half re-runs the same
 * sustained burst through a real `MnemonadRateLimiter` to prove the fix actually recovers
 * calls end to end, not just that the classifier returns true in isolation.
 *
 *   node scripts/smoke_rpc_rate_limit.mjs
 */
import { createPublicClient, http } from 'viem';
import { monadTestnet } from 'viem/chains';
import MnemonadRateLimiter, { describeErrorChain, isTransientRpcError } from '../js/MnemonadRateLimiter.js';
import { mnemonadAbi } from '../js/abi.js';
import ids from '../js/ids.js';

const { contractAddress } = ids.monadTestnet;

async function burst(client, n, fn) {
	const results = await Promise.allSettled(Array.from({ length: n }, () => fn(client)));
	const failures = results.filter((r) => r.status === 'rejected');
	return { total: results.length, failed: failures.length, firstError: failures[0]?.reason };
}

function report(label, { total, failed, firstError }) {
	console.log(`${label}: ${total - failed}/${total} succeeded, ${failed} failed`);
	if (firstError) {
		console.log('  chain:', describeErrorChain(firstError));
		console.log('  isTransientRpcError:', isTransientRpcError(firstError));
	}
}

async function sustainedBurst(client, waves, perWave, fn) {
	let total = 0;
	let failed = 0;
	let firstError = null;
	for (let i = 0; i < waves; i += 1) {
		const r = await burst(client, perWave, fn);
		total += r.total;
		failed += r.failed;
		if (r.firstError && !firstError) firstError = r.firstError;
		await new Promise((res) => setTimeout(res, 200));
	}
	return { total, failed, firstError };
}

const readVersion = (client) =>
	client.readContract({ address: contractAddress, abi: mnemonadAbi, functionName: 'maxChunkBytes' });

console.log('--- Raw client, no retry (5 waves x 30 readContract, 200ms apart) ---');
const raw = createPublicClient({ chain: monadTestnet, transport: http() });
report('raw', await sustainedBurst(raw, 5, 30, readVersion));

console.log('\n--- MnemonadRateLimiter (attempts: 8, maxDelayMs: 8000), same load ---');
const limiter = new MnemonadRateLimiter({ attempts: 8, maxDelayMs: 8000 });
const wrapped = limiter.wrapClient(createPublicClient({ chain: monadTestnet, transport: http() }));
report('retried', await sustainedBurst(wrapped, 5, 30, readVersion));
