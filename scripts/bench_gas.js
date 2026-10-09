/**
 * Measures what storage, code and the Mnemonad registry actually cost on a live Monad
 * network — the numbers the local EDR node can't give, because it prices storage the
 * Ethereum way and Monad uses MIP-8 (4 KB pages of 128 slots: 8,000 gas per cold page,
 * 2,800 per first page write, 17,000 per slot of state growth).
 *
 * **Sends no transactions and needs no key.** Every number comes from `eth_call` with a
 * state override, which costs nothing and changes nothing:
 *
 *   - Each probe runs as code placed at a throwaway address. It reads `GAS` before and after
 *     the operation under test and returns the difference — the exact in-EVM charge, rather
 *     than `eth_estimateGas`, which stops its binary search within ~1.5% of the answer (too
 *     coarse to see a 100-gas warm read next to a 27,900-gas page write).
 *   - Registry calls go through a small meter contract placed *at the caller's own address*.
 *     Put at a stream owner's address, it calls `push`/`pushMany`/`pushExternal` as that
 *     owner, so a real stream's real storage is measured without anyone signing anything.
 *
 * Sections:
 *
 *   1. MIP-8 primitives — SLOAD/SSTORE on fresh and pre-populated pages, code deposit per
 *      byte, CREATE, and calldata pricing. The baseline everything else is built on.
 *   2. Fresh stream — `create()` with one item of each size, minus an empty `create()`: the
 *      marginal cost of each tier, where the SLOT/CODE crossover (`SLOT_MAX_BYTES`) lives,
 *      what packing saves, and how items share pages within one transaction.
 *   3. Existing stream — `push`/`pushMany`/`pushExternal` into a live stream as its owner,
 *      plus which page the next item lands on.
 *   4. Reads — `at()` over the stream's own items, as gas and gas/byte.
 *   5. Multi-chunk reads and `concat`, on streams built by setup calls inside the same
 *      `eth_call` (so warm — lower bounds).
 *
 * "Execution" is the gas the contract code burns. A real transaction also pays 21,000 plus
 * calldata (see section 1 for both calldata rules); "tx gas" adds those. On Monad the
 * *limit* is billed, not usage, so the wallet's estimate padding is charged too.
 *
 * Shared core for `bench_gas_testnet.js`. A network without a deployment (mainnet, today)
 * still runs section 1, and runs section 2 against testnet's deployed bytecode placed at a
 * throwaway address — same code, that network's gas schedule.
 */
import fs from 'node:fs';
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, encodeAbiParameters, keccak256, toHex, hexToBigInt, pad, concat, size as hexSize, getAddress } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import { mnemonadAbi } from '../js/abi.js';
import ids from '../js/ids.js';
import { isTransientRpcError } from '../js/MnemonadRateLimiter.js';

const CHAINS = { monadTestnet, monad };
const IDS_KEY = { monadTestnet: 'monadTestnet', monad: 'monadMainnet' };

/** Gas handed to every `eth_call`. Well over any single measurement here (a 64 KB CODE
 *  push is ~15M), under the public RPCs' 200M `eth_call` cap. */
const CALL_GAS = 100_000_000n;

/** Plain addresses the probes and meters are overridden onto. Nothing lives at them. */
const PROBE_ADDRESS = '0x00000000000000000000000000000000000b3c01';
const CALIBRATION_ADDRESS = '0x00000000000000000000000000000000000b3c02';
const REGISTRY_STANDIN = '0x00000000000000000000000000000000000b3c03';
const FRESH_CALLER = '0x00000000000000000000000000000000000b3c04';
const RPC_FROM = '0x00000000000000000000000000000000000b3c05';
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

/** The Ethereum (Cancun) price of each primitive, for the comparison column. */
const ETH = {
	coldSload: 2100,
	warmSload: 100,
	newSlot: 22100,
	newSlotWarm: 20000,
	rewrite: 100,
	modifyCold: 5000,
	deployPerByte: 200,
	create: 32000,
};

// -------------------------------------------------------------------------------------
// A minimal EVM assembler: just enough opcodes for the probes and the meter.
// -------------------------------------------------------------------------------------

const OP = {
	STOP: '00', ADD: '01', SUB: '03', CALLDATACOPY: '37', EXTCODESIZE: '3b', RETURNDATASIZE: '3d',
	RETURNDATACOPY: '3e', POP: '50', MSTORE: '52', MSTORE8: '53', SLOAD: '54', SSTORE: '55',
	GAS: '5a', AND: '16', SWAP1: '90', CREATE: 'f0', CALL: 'f1',
	RETURN: 'f3',
};

/** Static gas of the opcodes that appear *inside* a measured window, so it can be taken
 *  back out and leave only the operation being measured. */
const STATIC_GAS = { [OP.POP]: 2, [OP.GAS]: 2 };

/** `PUSHn value` with the smallest n that fits. Always 3 gas. */
function push(value) {
	let hex = BigInt(value).toString(16);
	if (hex.length % 2) hex = '0' + hex;
	const n = hex.length / 2;
	if (n > 32) throw new Error(`push: ${value} does not fit in 32 bytes`);
	return (0x5f + n).toString(16) + hex;
}

/** One measured step: `ops` must leave the stack as it found it. `staticGas` is what those
 *  ops cost apart from the one operation being measured. */
const step = (label, ops, staticGas) => ({ label, ops, staticGas });

const sloadStep = (label, slot) => step(label, push(slot) + OP.SLOAD + OP.POP, 3 + STATIC_GAS[OP.POP]);
const sstoreStep = (label, slot, value) => step(label, push(value) + push(slot) + OP.SSTORE, 6);

/**
 * Runtime code that runs `steps` in order and returns one 32-byte word per step: the gas
 * that step consumed, minus its own bookkeeping. Each step sits between two `GAS` reads;
 * the second read's own 2 gas lands inside the window, so it is counted as static too.
 * Results are written to memory *after* the closing read, outside every window.
 *
 * `setup` runs first, unmeasured — e.g. writing a child contract's initcode into memory.
 */
function meteredProgram(steps, setup = '') {
	let code = setup;
	steps.forEach((s, i) => {
		code += OP.GAS + s.ops + OP.GAS + OP.SWAP1 + OP.SUB + push(i * 32) + OP.MSTORE;
	});
	code += push(steps.length * 32) + push(0) + OP.RETURN;
	return '0x' + code;
}

/**
 * The meter: runtime code that makes a sequence of calls and measures only the last one.
 * Every call's payload sits in the meter's own calldata at a known offset, so the code is
 * generated per sequence, straight-line, with those offsets as constants. Returns
 * `[gasUsed, success, returndatasize, setupOk, returndata...]`.
 *
 * Earlier calls are setup — creating a stream, staging chunks — and run unmeasured, but in
 * the same transaction: whatever they touch is *warm* when the measured call runs. Callers
 * that care say so in their report.
 *
 * The measured call's payload is copied to memory and its target warmed with EXTCODESIZE
 * before the window opens, as in a real transaction (where `tx.to` is warm). What the
 * window still holds beyond the callee's own execution — a few stack ops and CALL's
 * 100-gas warm access — is the calibration, measured by calling a contract that just
 * STOPs and subtracted (see `calibrate`).
 */
function sequenceMeter(calls) {
	const callOps = (c) =>
		push(0) + push(0) + push(c.length) + push(0) + push(0) + push(c.target) + OP.GAS + OP.CALL;
	const copy = (c) => push(c.length) + push(c.offset) + push(0) + OP.CALLDATACOPY;

	let code = push(1); // running AND of the setup calls' success flags
	for (const c of calls.slice(0, -1)) code += copy(c) + callOps(c) + OP.AND;
	const last = calls.at(-1);
	code += copy(last) + push(last.target) + OP.EXTCODESIZE + OP.POP;
	code += OP.GAS + callOps(last) + OP.GAS; //   [setupOk, g0, ok, g1]
	code += OP.SWAP1 + push(32) + OP.MSTORE; //   mem[32] = ok
	code += OP.SWAP1 + OP.SUB + push(0) + OP.MSTORE; // mem[0] = g0 - g1
	code += push(96) + OP.MSTORE; //              mem[96] = setupOk
	code += OP.RETURNDATASIZE + push(64) + OP.MSTORE;
	code += OP.RETURNDATASIZE + push(0) + push(128) + OP.RETURNDATACOPY;
	code += OP.RETURNDATASIZE + push(128) + OP.ADD + push(0) + OP.RETURN;
	return '0x' + code;
}

// -------------------------------------------------------------------------------------
// RPC
// -------------------------------------------------------------------------------------

async function withRetry(fn, label) {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await fn();
		} catch (err) {
			if (attempt >= 5 || !isTransientRpcError(err)) {
				err.message = `${label}: ${err.shortMessage ?? err.message}`;
				throw err;
			}
			await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
		}
	}
}

function makeRpc(chain) {
	const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 0 }) });

	/** `eth_call` with a state override. `overrides` is `{address: {code?, balance?, stateDiff?}}`. */
	const call = (tx, overrides, label) => withRetry(
		() => client.request({
			method: 'eth_call',
			params: [{ from: RPC_FROM, gas: toHex(CALL_GAS), ...tx }, 'latest', overrides],
		}),
		label
	);

	const estimate = (tx, label) => withRetry(
		() => client.request({ method: 'eth_estimateGas', params: [{ from: RPC_FROM, ...tx }, 'latest'] }),
		label
	).then((hex) => Number(hexToBigInt(hex)));

	const read = (address, functionName, args = []) => withRetry(
		() => client.readContract({ address, abi: mnemonadAbi, functionName, args }),
		functionName
	);

	const storageAt = (address, slot) => withRetry(
		() => client.getStorageAt({ address, slot }),
		'getStorageAt'
	);

	return { client, call, estimate, read, storageAt };
}

/** Runs a metered program at PROBE_ADDRESS (optionally over pre-set storage) and returns
 *  `{label: gas}` with each step's static ops already taken out. */
async function runProbe(rpc, steps, { setup = '', stateDiff } = {}) {
	const override = { code: meteredProgram(steps, setup) };
	if (stateDiff) override.stateDiff = stateDiff;
	const out = await rpc.call({ to: PROBE_ADDRESS }, { [PROBE_ADDRESS]: override }, 'probe');
	const words = [];
	for (let i = 0; i < steps.length; i += 1) {
		words.push(Number(hexToBigInt(`0x${out.slice(2 + i * 64, 2 + (i + 1) * 64)}`)));
	}
	return Object.fromEntries(steps.map((s, i) => [s.label, words[i] - s.staticGas - STATIC_GAS[OP.GAS]]));
}

/**
 * Runs `calls` (`[{target, data}]`) through the meter placed at `caller`, so each one is
 * made *as* `caller`. Returns the last call's execution gas (calibration already
 * subtracted) and its return data; throws if any call reverts.
 */
async function meteredCalls(rpc, { caller, calls, calibration, extraOverrides = {}, gas, label }) {
	let offset = 0;
	const layout = calls.map((c) => {
		const length = hexSize(c.data);
		const entry = { target: c.target, offset, length };
		offset += length;
		return entry;
	});
	const overrides = {
		...extraOverrides,
		[caller]: { ...(extraOverrides[caller] ?? {}), code: sequenceMeter(layout), balance: toHex(10n ** 24n) },
	};
	const out = await rpc.call(
		{ to: caller, data: concat(['0x', ...calls.map((c) => c.data)]), ...(gas ? { gas: toHex(gas) } : {}) },
		overrides,
		label
	);
	const wordAt = (i) => hexToBigInt(`0x${out.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
	const used = Number(wordAt(0));
	const ok = wordAt(1) === 1n;
	const retLen = Number(wordAt(2));
	const setupOk = wordAt(3) === 1n;
	const ret = `0x${out.slice(2 + 4 * 64, 2 + 4 * 64 + retLen * 2)}`;
	if (!setupOk) throw new Error(`${label}: a setup call reverted`);
	if (!ok) {
		const err = new Error(`${label}: call reverted (${ret === '0x' ? 'no data' : ret.slice(0, 74)})`);
		err.revertData = ret;
		throw err;
	}
	return { gas: used - (calibration ?? 0), ret };
}

/** One measured call to `target` as `caller`. */
const metered = (rpc, { target, data, ...rest }) => meteredCalls(rpc, { ...rest, calls: [{ target, data }] });

/** The meter's own overhead: a call to a contract that does nothing. */
async function calibrate(rpc) {
	const { gas } = await metered(rpc, {
		caller: FRESH_CALLER,
		target: CALIBRATION_ADDRESS,
		data: '0x',
		calibration: 0,
		extraOverrides: { [CALIBRATION_ADDRESS]: { code: '0x00' } },
		label: 'calibrate',
	});
	return gas;
}

// -------------------------------------------------------------------------------------
// Calldata
// -------------------------------------------------------------------------------------

function calldataTokens(data) {
	const bytes = Buffer.from(data.slice(2), 'hex');
	let zeros = 0;
	for (const b of bytes) if (b === 0) zeros += 1;
	return { zeros, nonzeros: bytes.length - zeros };
}

/**
 * Gas a real transaction carrying `data` and burning `execution` gas would be charged:
 * the standard rule (21,000 + 16 per non-zero / 4 per zero byte + execution), or the
 * calldata floor (21,000 + 40 per non-zero / 10 per zero byte) when that is higher —
 * which section 1 shows Monad enforces.
 */
function txGas(data, execution) {
	const { zeros, nonzeros } = calldataTokens(data);
	const standard = 21000 + 16 * nonzeros + 4 * zeros + execution;
	const floor = 21000 + 40 * nonzeros + 10 * zeros;
	return Math.max(standard, floor);
}

// -------------------------------------------------------------------------------------
// Section 1 — MIP-8 primitives
// -------------------------------------------------------------------------------------

const PAGE = 128n;
const slotOf = (page, offset = 0) => BigInt(page) * PAGE + BigInt(offset);
const word = (v) => pad(toHex(v));

async function benchPrimitives(rpc) {
	// Fresh, empty storage. Pages 1 and 2 are untouched by anything but these steps.
	const reads = await runProbe(rpc, [
		sloadStep('sload cold page', slotOf(1, 0)),
		sloadStep('sload same slot again', slotOf(1, 0)),
		sloadStep('sload other slot, same page', slotOf(1, 5)),
		sloadStep('sload next page', slotOf(2, 0)),
	]);

	const writes = await runProbe(rpc, [
		sstoreStep('sstore new slot, cold page', slotOf(1, 0), 1),
		sstoreStep('sstore new slot, same page', slotOf(1, 1), 1),
		sstoreStep('sstore rewrite same slot', slotOf(1, 1), 2),
		sstoreStep('sstore zero into empty slot', slotOf(1, 2), 0),
		sstoreStep('sstore clear a slot', slotOf(1, 1), 0),
		sstoreStep('sstore new slot after a clear', slotOf(1, 3), 1),
		sstoreStep('sstore new slot, next page', slotOf(2, 0), 1),
	]);

	// Pre-populated storage via stateDiff: page 1 holds slots 0..3, page 2 holds slot 0.
	const existing = {
		[word(slotOf(1, 0))]: word(7n),
		[word(slotOf(1, 1))]: word(7n),
		[word(slotOf(1, 2))]: word(7n),
		[word(slotOf(1, 3))]: word(7n),
		[word(slotOf(2, 0))]: word(7n),
	};
	// Account access: EXTCODESIZE on an address nothing in this call has touched, then again.
	const accounts = await runProbe(rpc, [
		step('account cold', push(BURN_ADDRESS) + OP.EXTCODESIZE + OP.POP, 3 + STATIC_GAS[OP.POP]),
		step('account warm', push(BURN_ADDRESS) + OP.EXTCODESIZE + OP.POP, 3 + STATIC_GAS[OP.POP]),
	]);

	let onExisting = null;
	try {
		onExisting = await runProbe(rpc, [
			sloadStep('sload populated page', slotOf(1, 0)),
			sstoreStep('sstore modify slot, loaded page', slotOf(1, 1), 8),
			sstoreStep('sstore new slot, populated page', slotOf(1, 4), 1),
			sstoreStep('sstore modify slot, cold populated page', slotOf(2, 0), 8),
			sstoreStep('sstore clear slot, populated page', slotOf(2, 0), 0),
			sstoreStep('sstore new slot after that clear', slotOf(2, 1), 1),
		], { stateDiff: existing });
	} catch (err) {
		onExisting = { error: err.message };
	}

	// Code deposit: a child that returns L bytes of code, against the same child returning
	// none. Both expand memory to L and run the same ops; only the deposit differs.
	const childInitcode = (len, returnLen) =>
		push(1) + push(len - 1) + OP.MSTORE8 + push(returnLen) + push(0) + OP.RETURN;
	const createStep = (label, len, returnLen) => {
		const child = childInitcode(len, returnLen);
		const childBytes = child.length / 2;
		// Child initcode is right-aligned in the word at 0x400 by the setup MSTORE.
		const childOffset = 0x400 + 32 - childBytes;
		return {
			setup: push(BigInt('0x' + child)) + push(0x400) + OP.MSTORE,
			step: step(label, push(childBytes) + push(childOffset) + push(0) + OP.CREATE + OP.POP, 9 + STATIC_GAS[OP.POP]),
		};
	};
	const deposit = {};
	for (const len of [32, 1024, 24576, 65536]) {
		const withCode = createStep('with', len, len);
		const withoutCode = createStep('without', len, 0);
		const a = await runProbe(rpc, [withCode.step], { setup: withCode.setup });
		const b = await runProbe(rpc, [withoutCode.step], { setup: withoutCode.setup });
		deposit[len] = { total: a.with - b.without, perByte: (a.with - b.without) / len };
	}
	// CREATE itself: a one-byte child that just STOPs, so only its initcode word (2 gas)
	// needs taking back out.
	const stopChild = step('create', push(1) + push(0x400 + 31) + push(0) + OP.CREATE + OP.POP, 9 + STATIC_GAS[OP.POP]);
	const createOnly = (await runProbe(rpc, [stopChild], { setup: push(0) + push(0x400) + OP.MSTORE })).create - 2;

	// Memory expansion: 0 → 1 KB, then 1 KB → 64 KB, each by one MSTORE at the new end.
	// Ethereum charges 3w + w²/512 for w words in total.
	const mstoreTo = (label, bytes) => step(label, push(0) + push(bytes - 32) + OP.MSTORE, 6 + 3);
	const memory = await runProbe(rpc, [mstoreTo('to 1 KB', 1024), mstoreTo('1 KB to 64 KB', 65536)]);

	// Calldata, through eth_estimateGas on plain transfers (the only way to see the
	// intrinsic charge). Within ~1.5% — the estimator's own tolerance — which is plenty to
	// tell 16 per byte from 40.
	const transfer = await rpc.estimate({ to: BURN_ADDRESS }, 'transfer');
	const nonzero = await rpc.estimate({ to: BURN_ADDRESS, data: '0x' + 'aa'.repeat(1024) }, 'calldata nonzero');
	const zero = await rpc.estimate({ to: BURN_ADDRESS, data: '0x' + '00'.repeat(1024) }, 'calldata zero');
	const calldata = {
		transfer,
		perNonzeroByte: (nonzero - transfer) / 1024,
		perZeroByte: (zero - transfer) / 1024,
	};

	return { reads, writes, onExisting, accounts, deposit, create: createOnly, memory, calldata };
}

// -------------------------------------------------------------------------------------
// Section 2 — fresh stream
// -------------------------------------------------------------------------------------

/** Deterministic non-zero filler, so payload content never changes a measurement. */
function payload(len, seed = 1) {
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i += 1) bytes[i] = ((i * 31 + seed) % 251) + 1;
	return toHex(bytes);
}

const FRESH_SIZES = [1, 16, 31, 32, 33, 64, 128, 512, 1024, 4096, 16384, 24576, 65536];

async function benchFresh(rpc, ctx) {
	const { registry, calibration, extraOverrides, maxChunkBytes } = ctx;
	const salt = keccak256(toHex(`bench-gas-${Date.now()}`));
	const createGas = async (items, label) => {
		const data = encodeFunctionData({ abi: mnemonadAbi, functionName: 'create', args: [salt, '0x', '0x', items] });
		const { gas } = await metered(rpc, { caller: FRESH_CALLER, target: registry, data, calibration, extraOverrides, label });
		return { gas, data };
	};

	const empty = await createGas([], 'create empty');
	const tiers = [];
	for (const len of FRESH_SIZES.filter((n) => n <= maxChunkBytes)) {
		const item = payload(len);
		const { gas } = await createGas([item], `create ${len} B`);
		const marginal = gas - empty.gas;
		// The item's own calldata, priced by the standard rule: with this much execution in
		// the transaction, the calldata floor never binds.
		const { zeros, nonzeros } = calldataTokens(item);
		tiers.push({
			size: len,
			tier: len <= 31 ? 'SLOT' : 'CODE',
			execution: marginal,
			perByte: marginal / len,
			withCalldata: marginal + 16 * nonzeros + 4 * zeros,
		});
	}

	// Packing: 10 items of 200 B in one create (one shared chunk) against 10 separate ones.
	const single200 = (await createGas([payload(200)], 'create 1x200')).gas - empty.gas;
	const packed10 = (await createGas(Array.from({ length: 10 }, (_, i) => payload(200, i + 2)), 'create 10x200')).gas - empty.gas;

	// Items per transaction: n one-byte items, packed into one chunk, so the only thing that
	// scales with n is the items array (one slot per item) and the offsets. Shows how
	// consecutive items share the page charge within a single transaction.
	const batches = [];
	for (const n of [1, 2, 8, 32, 128, 256]) {
		const items = Array.from({ length: n }, (_, i) => payload(1, i + 1));
		const gas = (await createGas(items, `create ${n}x1`)).gas - empty.gas;
		batches.push({ items: n, execution: gas, perItem: gas / n });
	}

	return {
		empty: empty.gas,
		emptyTx: txGas(empty.data, empty.gas),
		tiers,
		packing: { single200, separate10: single200 * 10, packed10 },
		batches,
	};
}

// -------------------------------------------------------------------------------------
// Section 3 — existing stream
// -------------------------------------------------------------------------------------

/** `_items`'s declaration slot isn't in the build artifacts, so find it: the length of
 *  `_items[id]` lives at keccak256(id . p), and must equal the stream's known length. */
async function findItemsSlot(rpc, registry, id, length) {
	for (let p = 0n; p < 40n; p += 1n) {
		const lengthSlot = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [id, p]));
		const value = await rpc.storageAt(registry, lengthSlot);
		if (value && hexToBigInt(value) === length) return { p, lengthSlot: hexToBigInt(lengthSlot) };
	}
	return null;
}

async function benchExisting(rpc, ctx, streamId) {
	const { registry, calibration } = ctx;
	const id = BigInt(streamId);
	const owner = getAddress(await rpc.read(registry, 'ownerOf', [id]));
	const [len] = await rpc.read(registry, 'getStreamInfo', [id]);
	const length = BigInt(len);

	const pushGas = async (functionName, args, label) => {
		const data = encodeFunctionData({ abi: mnemonadAbi, functionName, args });
		const { gas } = await metered(rpc, { caller: owner, target: registry, data, calibration, label });
		return { execution: gas, tx: txGas(data, gas), data };
	};

	const rows = [];
	for (const len of [1, 31, 32, 200, 1024, 24576]) {
		const r = await pushGas('push', [id, NO_CHECK, payload(len), '0x'], `push ${len} B`);
		rows.push({ call: `push ${len.toLocaleString('en-US')} B`, size: len, ...r });
	}
	const many = await pushGas('pushMany', [id, NO_CHECK, Array.from({ length: 10 }, (_, i) => payload(200, i + 2))], 'pushMany 10x200');
	rows.push({ call: 'pushMany 10 × 200 B', size: 2000, ...many });
	const pointer = { hash: keccak256('0x01'), size: 1_000_000n, codec: 1, locator: toHex('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi') };
	const ext = await pushGas('pushExternal', [id, NO_CHECK, pointer, '0x'], 'pushExternal');
	rows.push({ call: 'pushExternal (1 MB off-chain)', size: 0, ...ext });

	// Cross-check the meter against the node's own estimator for one call. They should
	// agree to within the estimator's ~1.5% tolerance.
	const sample = rows.find((r) => r.size === 1024);
	let crossCheck = null;
	try {
		const estimated = await rpc.estimate({ from: owner, to: registry, data: sample.data }, 'estimate push 1 KB');
		crossCheck = { metered: sample.tx, estimated, diff: (estimated - sample.tx) / sample.tx };
	} catch (err) {
		crossCheck = { error: err.message };
	}

	const slots = await findItemsSlot(rpc, registry, id, length);
	let placement = null;
	if (slots) {
		const start = hexToBigInt(keccak256(pad(toHex(slots.lengthSlot))));
		const next = start + length;
		placement = {
			itemsDeclarationSlot: Number(slots.p),
			nextIndex: Number(length),
			nextItemPageOffset: Number(next % PAGE),
			itemsUntilNextPage: Number(PAGE - (next % PAGE)),
			sharesPageWithLengthSlot: next / PAGE === slots.lengthSlot / PAGE,
		};
	}

	return { streamId, owner, length: Number(length), rows: rows.map(({ data, ...r }) => r), crossCheck, placement };
}

// -------------------------------------------------------------------------------------
// Section 4 — reads
// -------------------------------------------------------------------------------------

async function benchReads(rpc, ctx, streamId) {
	const { registry, calibration } = ctx;
	const id = BigInt(streamId);
	const [len, , firstIdx] = await rpc.read(registry, 'getStreamInfo', [id]);

	const indices = [];
	for (let i = BigInt(firstIdx); i < BigInt(len); i += 1n) indices.push(i);
	const refs = [];
	for (let i = 0; i < indices.length; i += 50) {
		const batch = indices.slice(i, i + 50);
		const got = await rpc.read(registry, 'getItemRefsBatch', [id, batch]);
		got.forEach((r, j) => refs.push({ index: batch[j], store: Number(r.store), chunks: r.chunks.length, size: Number(r.size) }));
	}

	// One item per power-of-two size bucket (the largest in each), SLOT and CODE only —
	// EXTERNAL items aren't readable on chain.
	const buckets = new Map();
	for (const r of refs) {
		if (r.store !== 1 && r.store !== 2) continue;
		const b = Math.floor(Math.log2(Math.max(1, r.size)));
		if (!buckets.has(b) || buckets.get(b).size < r.size) buckets.set(b, r);
	}
	const picks = [...buckets.values()].sort((a, b) => a.size - b.size);

	const rows = [];
	for (const r of picks) {
		const data = encodeFunctionData({ abi: mnemonadAbi, functionName: 'at', args: [id, r.index] });
		const { gas } = await metered(rpc, { caller: FRESH_CALLER, target: registry, data, calibration, label: `at(${r.index})` });
		rows.push({ index: Number(r.index), store: r.store === 1 ? 'SLOT' : 'CODE', chunks: r.chunks, size: r.size, execution: gas, perByte: gas / r.size });
	}
	return { streamId, items: refs.length, rows };
}

// -------------------------------------------------------------------------------------
// Section 5 — multi-chunk reads and concat, on streams built inside the call
// -------------------------------------------------------------------------------------

const NO_CHECK = 2n ** 64n - 1n;

/**
 * Things no existing stream has to offer — items larger than one chunk, a pair of streams
 * to concat — are built by setup calls in the same `eth_call` as the measured one. So
 * everything the measured call touches was just written: its pages are warm, and so are
 * the chunk accounts. These numbers are therefore lower bounds on a real (cold) call; the
 * report sets a warm single-chunk read beside section 4's cold one to size the gap.
 */
async function benchBuilt(rpc, ctx) {
	const { registry, calibration, extraOverrides, maxChunkBytes } = ctx;
	const streamId = (salt) => hexToBigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [FRESH_CALLER, salt])));
	const enc = (functionName, args) => ({ target: registry, data: encodeFunctionData({ abi: mnemonadAbi, functionName, args }) });
	const run = (calls, label, gas) => meteredCalls(rpc, { caller: FRESH_CALLER, calls, calibration, extraOverrides, gas, label });

	const salt = keccak256(toHex(`bench-gas-built-${Date.now()}`));
	const id = streamId(salt);
	const create = enc('create', [salt, '0x', '0x', []]);
	const read = enc('at', [id, 0n]);

	// Staging ids come from a counter: whatever beginItem returns now is what it will
	// return inside the measured sequence too.
	const begun = await run([create, enc('beginItem', [id, 1, '0x'])], 'beginItem');
	const stagingId = decodeFunctionResult({ abi: mnemonadAbi, functionName: 'beginItem', data: begun.ret });

	const reads = [];
	for (const size of [1024, 24576, 65536].filter((n) => n <= maxChunkBytes)) {
		const { gas } = await run([create, enc('push', [id, NO_CHECK, payload(size), '0x']), read], `warm at ${size}`);
		reads.push({ size, chunks: 1, execution: gas, perByte: gas / size });
	}
	for (const size of [131072, 262144, 524288]) {
		const calls = [create, enc('beginItem', [id, size, '0x'])];
		let chunks = 0;
		for (let off = 0; off < size; off += maxChunkBytes) {
			calls.push(enc('appendChunk', [stagingId, off, payload(Math.min(maxChunkBytes, size - off), chunks + 1)]));
			chunks += 1;
		}
		calls.push(enc('commitItem', [stagingId]), read);
		try {
			// Deploying the chunks is most of this call's gas, hence the larger allowance.
			const { gas } = await run(calls, `warm at ${size}`, 150_000_000n);
			reads.push({ size, chunks, execution: gas, perByte: gas / size });
		} catch (err) {
			reads.push({ size, chunks, error: err.message });
		}
	}

	// concat: 4 items into an empty destination, small payloads against 50× larger ones.
	const concats = [];
	for (const size of [100, 5000]) {
		const srcSalt = keccak256(toHex(`${salt}-src-${size}`));
		const dstSalt = keccak256(toHex(`${salt}-dst-${size}`));
		const src = streamId(srcSalt);
		const dst = streamId(dstSalt);
		const calls = [enc('create', [srcSalt, '0x', '0x', []])];
		for (let i = 0; i < 4; i += 1) calls.push(enc('push', [src, NO_CHECK, payload(size, i + 1), '0x']));
		calls.push(enc('create', [dstSalt, '0x', '0x', []]), enc('concat', [dst, src, NO_CHECK]));
		const { gas } = await run(calls, `concat 4x${size}`);
		concats.push({ items: 4, size, execution: gas });
	}

	return { reads, concats };
}

// -------------------------------------------------------------------------------------
// Report
// -------------------------------------------------------------------------------------

/** Ethereum's total memory cost for `w` words. */
const ethMemory = (w) => 3 * w + Math.floor((w * w) / 512);

const n = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : String(v));
const f = (v, d = 1) => v.toFixed(d);

function table(head, rows) {
	// First column left-aligned (labels), the rest right-aligned (numbers).
	const lines = [`| ${head.join(' | ')} |`, `|${head.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`];
	for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
	return lines.join('\n');
}

function report(res) {
	const out = [];
	out.push(`# Gas on ${res.network} (chainId ${res.chainId})`);
	out.push('');
	out.push(`Measured ${res.at} at block ${res.block} with metered \`eth_call\`s — no transactions sent. Registry: \`${res.registry}\`${res.registryNote ? ` (${res.registryNote})` : ''}. Meter overhead subtracted: ${res.calibration} gas.`);
	out.push('', 'Generated by [`scripts/bench_gas.js`](../scripts/bench_gas.js), which explains the method. To refresh:', '');
	out.push('```bash', `cd scripts && node bench_gas_testnet.js${res.args ? ` ${res.args}` : ''} --out ../docs/gas.md`, '```');

	const p = res.primitives;
	out.push('', '## 1. MIP-8 primitives', '');
	out.push(table(['Operation', 'Monad', 'Ethereum'], [
		['SLOAD, cold page', n(p.reads['sload cold page']), n(ETH.coldSload)],
		['SLOAD, same slot again', n(p.reads['sload same slot again']), n(ETH.warmSload)],
		['SLOAD, other slot on a loaded page', n(p.reads['sload other slot, same page']), `${n(ETH.coldSload)} (cold slot)`],
		['SLOAD, next page', n(p.reads['sload next page']), n(ETH.coldSload)],
		['SSTORE new slot, cold empty page', n(p.writes['sstore new slot, cold page']), n(ETH.newSlot)],
		['SSTORE new slot, page already written', n(p.writes['sstore new slot, same page']), n(ETH.newSlot)],
		['SSTORE rewrite a slot written this tx', n(p.writes['sstore rewrite same slot']), n(ETH.rewrite)],
		['SSTORE zero into an empty slot', n(p.writes['sstore zero into empty slot']), `${n(ETH.coldSload)}+100`],
		['SSTORE clear a slot written this tx', n(p.writes['sstore clear a slot']), n(ETH.rewrite)],
		['SSTORE new slot after that clear', n(p.writes['sstore new slot after a clear']), n(ETH.newSlot)],
		['SSTORE new slot, next page', n(p.writes['sstore new slot, next page']), n(ETH.newSlot)],
	]));
	if (p.onExisting && !p.onExisting.error) {
		const e = p.onExisting;
		out.push('', 'On pages that already hold data (set with a `stateDiff` override):', '');
		out.push(table(['Operation', 'Monad', 'Ethereum'], [
			['SLOAD, populated cold page', n(e['sload populated page']), n(ETH.coldSload)],
			['SSTORE modify a slot, page loaded', n(e['sstore modify slot, loaded page']), `${n(ETH.modifyCold)} (cold slot)`],
			['SSTORE new slot on a populated page', n(e['sstore new slot, populated page']), n(ETH.newSlot)],
			['SSTORE modify a slot, cold populated page', n(e['sstore modify slot, cold populated page']), n(ETH.modifyCold)],
			['SSTORE clear that slot', n(e['sstore clear slot, populated page']), n(ETH.rewrite)],
			['SSTORE new slot after that clear', n(e['sstore new slot after that clear']), n(ETH.newSlot)],
		]));
	} else if (p.onExisting?.error) {
		out.push('', `Populated-page probes skipped: ${p.onExisting.error}`);
	}
	out.push('', table(['Code, memory, calldata', 'Monad', 'Ethereum'], [
		['Account access, cold / warm (EXTCODESIZE)', `${n(p.accounts['account cold'])} / ${n(p.accounts['account warm'])}`, '2,600 / 100'],
		['CREATE (opcode, empty child)', n(p.create), n(ETH.create)],
		...Object.entries(p.deposit).map(([len, d]) => [`Code deposit, ${n(Number(len))} B`, `${n(d.total)} (${f(d.perByte)}/B)`, `${n(ETH.deployPerByte * Number(len))} (200/B)`]),
		['Memory, 0 → 1 KB', n(p.memory['to 1 KB']), n(ethMemory(32) - ethMemory(0))],
		['Memory, 1 KB → 64 KB', n(p.memory['1 KB to 64 KB']), n(ethMemory(2048) - ethMemory(32))],
		['Calldata, per non-zero byte (plain transfer)', f(p.calldata.perNonzeroByte), '16, floor 40 (EIP-7623)'],
		['Calldata, per zero byte (plain transfer)', f(p.calldata.perZeroByte), '4, floor 10 (EIP-7623)'],
	]));

	if (res.fresh) {
		const fr = res.fresh;
		out.push('', '## 2. Fresh stream', '');
		out.push(`\`create()\` with no items: ${n(fr.empty)} execution, ${n(fr.emptyTx)} as a transaction. Rows below are what one item adds to it.`, '');
		out.push(table(['Item', 'Tier', 'Execution', 'gas/byte', '+ calldata'], fr.tiers.map((t) => [
			`${n(t.size)} B`, t.tier, n(t.execution), t.perByte >= 100 ? n(t.perByte) : f(t.perByte), n(t.withCalldata),
		])));
		const slot31 = fr.tiers.find((t) => t.size === 31);
		const code32 = fr.tiers.find((t) => t.size === 32);
		if (slot31 && code32) {
			// SLOT_MAX_BYTES check. A 32-byte `bytes` in storage no longer fits its own slot:
			// the data moves to keccak256(slot) — one more new slot, on a page of its own.
			// And CODE at 1 byte is CODE at 32 minus 31 bytes of deposit.
			const newPage = p.writes['sstore new slot, next page'];
			const perByte = p.deposit[1024]?.perByte ?? 200;
			const slot32 = slot31.execution + newPage;
			const code1 = code32.execution - 31 * perByte;
			const holds = code32.execution < slot32 && slot31.execution < code1;
			out.push('', `SLOT/CODE crossover: 31 B via SLOT ${n(slot31.execution)}, 32 B via CODE ${n(code32.execution)}. ` +
				`SLOT at 32 B would add a slot on a new page (${n(newPage)}) → ≈ ${n(slot32)}; CODE at 1 B ≈ ${n(code1)}. ` +
				(holds
					? '`SLOT_MAX_BYTES = 31` is the right cutoff: SLOT is cheaper for every size up to 31, CODE from 32.'
					: '**`SLOT_MAX_BYTES = 31` is not the cheapest cutoff on this schedule** — see the numbers above.'));
		}
		const pk = fr.packing;
		out.push('', `Packing: 10 × 200 B as separate items ≈ ${n(pk.separate10)}, packed into one chunk ${n(pk.packed10)} (${f((1 - pk.packed10 / pk.separate10) * 100, 0)}% less).`, '');
		out.push(table(['Items in one tx (1 B each, packed)', 'Execution', 'per item'], fr.batches.map((b) => [n(b.items), n(b.execution), n(b.perItem)])));
		out.push('', 'The items array starts at a hashed slot, so where its page boundaries fall differs per stream; rows can shift by a page charge between runs.');
	} else if (res.freshSkipped) {
		out.push('', '## 2. Fresh stream', '', res.freshSkipped);
	}

	if (res.existing) {
		const ex = res.existing;
		out.push('', '## 3. Existing stream', '');
		out.push(`Stream \`${ex.streamId}\` (${n(ex.length)} items), called as its owner \`${ex.owner}\`.`, '');
		out.push(table(['Call', 'Execution', 'Tx gas'], ex.rows.map((r) => [r.call, n(r.execution), n(r.tx)])));
		const one200 = ex.rows.find((r) => r.size === 200);
		const many = ex.rows.find((r) => r.call.startsWith('pushMany'));
		if (one200 && many) {
			out.push('', `Packing: 10 separate pushes of 200 B ≈ ${n(one200.tx * 10)} tx gas, one \`pushMany\` of the same ${n(many.tx)} (${f((1 - many.tx / (one200.tx * 10)) * 100, 0)}% less).`);
		}
		if (ex.crossCheck?.estimated) {
			out.push('', `Cross-check, push 1 KB: meter + intrinsic ${n(ex.crossCheck.metered)}, \`eth_estimateGas\` ${n(ex.crossCheck.estimated)} (${f(ex.crossCheck.diff * 100, 2)}%).`);
		}
		if (ex.placement) {
			const pl = ex.placement;
			out.push('', `Item ${n(pl.nextIndex)} lands at offset ${pl.nextItemPageOffset} of its page; ${pl.itemsUntilNextPage} more item(s) fit before the array crosses into a new page.`);
		}
	} else if (res.existingSkipped) {
		out.push('', '## 3. Existing stream', '', res.existingSkipped);
	}

	if (res.reads?.length) {
		out.push('', '## 4. Reads', '');
		out.push('`at()` on the largest on-chain item in each power-of-two size bucket. Metered against the `eth_call` gas cap, not paid.');
		for (const rd of res.reads) {
			out.push('', `Stream \`${rd.streamId}\` (${n(rd.items)} items):`, '');
			if (!rd.rows.length) {
				out.push('No on-chain items (all EXTERNAL).');
				continue;
			}
			out.push(table(['Item', 'Tier', 'Chunks', 'Size', 'Execution', 'gas/byte'], rd.rows.map((r) => [
				`#${r.index}`, r.store, n(r.chunks), `${n(r.size)} B`, n(r.execution), f(r.perByte, 2),
			])));
		}
	}
	if (res.built) {
		const b = res.built;
		out.push('', '## 5. Multi-chunk reads and concat (warm)', '');
		out.push('Built by setup calls inside the same `eth_call`, so every page and chunk account the measured call touches is already warm — lower bounds. Compare the warm single-chunk rows with section 4\'s cold reads to size the gap.', '');
		// A cold read's extra cost, from parts measured above: the fixed part is section 4's
		// cheapest cold read minus the warm 1 KB one (both are a single chunk, and bytes are
		// nearly free), and each further chunk is one more cold account plus — once — a cold
		// page of the `_extraChunks` array.
		const coldRows = (res.reads ?? []).flatMap((rd) => rd.rows);
		const warm1k = b.reads.find((r) => r.size === 1024 && !r.error);
		const coldBase = coldRows.length && warm1k ? Math.min(...coldRows.map((r) => r.execution)) - warm1k.execution : null;
		const perChunk = p.accounts['account cold'] - p.accounts['account warm'];
		const coldEstimate = (r) => r.execution + coldBase + (r.chunks > 1 ? p.reads['sload cold page'] : 0) + (r.chunks - 1) * perChunk;
		const head = ['`at()` item', 'Chunks', 'Execution (warm)', 'gas/byte', ...(coldBase != null ? ['Cold, est.', 'gas/byte'] : [])];
		out.push(table(head, b.reads.map((r) => {
			if (r.error) return [`${n(r.size)} B`, n(r.chunks), 'n/a', r.error.split('\n')[0].slice(0, 60)];
			const row = [`${n(r.size)} B`, n(r.chunks), n(r.execution), f(r.perByte, 2)];
			if (coldBase != null) row.push(n(coldEstimate(r)), f(coldEstimate(r) / r.size, 2));
			return row;
		})));
		if (coldBase != null) {
			out.push('', `Cold estimate = warm + ${n(coldBase)} fixed (section 4's cheapest cold read − the warm 1 KB read) + ${n(perChunk)} per extra chunk (cold account) + ${n(p.reads['sload cold page'])} once for the extra-chunk list's page.`);
		}
		out.push('', table(['`concat`', 'Execution'], b.concats.map((c) => [`${c.items} items × ${n(c.size)} B`, n(c.execution)])));
	}
	return out.join('\n') + '\n';
}

// -------------------------------------------------------------------------------------
// Entry
// -------------------------------------------------------------------------------------

/**
 * @param {'monadTestnet'|'monad'} networkKey
 * @param {Object} [opts]
 * @param {string} [opts.stream] - stream for sections 3 and 4 (any stream; the meter runs
 *   at its owner's address). Defaults to the docs stream on testnet.
 * @param {string[]} [opts.readStreams] - more streams for section 4's reads.
 * @param {boolean} [opts.skipExisting] - skip section 3 (and its stream's reads).
 * @returns {Promise<{result: object, markdown: string}>}
 */
export async function benchGas(networkKey, opts = {}) {
	const chain = CHAINS[networkKey];
	if (!chain) throw new Error(`bench-gas: unknown network '${networkKey}', expected one of ${Object.keys(CHAINS).join(', ')}`);
	const rpc = makeRpc(chain);
	const log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));

	const block = await rpc.client.getBlockNumber();
	const result = { network: chain.name, chainId: chain.id, block: Number(block), at: new Date().toISOString(), args: opts.args };

	log('calibrating meter…');
	result.calibration = await calibrate(rpc);

	log('section 1: MIP-8 primitives…');
	result.primitives = await benchPrimitives(rpc);

	// The registry to measure. Without a deployment on this network, testnet's deployed
	// code is placed at a stand-in address: same bytecode (immutables included), this
	// network's gas schedule, empty storage — enough for section 2, nothing for 3 and 4.
	const deployed = ids[IDS_KEY[networkKey]]?.contractAddress;
	let registry = deployed;
	let extraOverrides = {};
	if (!deployed) {
		const testnet = makeRpc(monadTestnet);
		const code = await testnet.client.getCode({ address: ids.monadTestnet.contractAddress });
		registry = REGISTRY_STANDIN;
		extraOverrides = { [REGISTRY_STANDIN]: { code } };
		result.registryNote = `no deployment here — testnet's code at a stand-in address, ${hexSize(code)} bytes`;
	}
	result.registry = registry;

	const maxChunkBytes = Number(deployed
		? await rpc.read(registry, 'maxChunkBytes')
		: await makeRpc(monadTestnet).read(ids.monadTestnet.contractAddress, 'maxChunkBytes'));
	const feePerByte = deployed ? await rpc.read(registry, 'feePerByte') : 0n;
	const ctx = { registry, calibration: result.calibration, extraOverrides, maxChunkBytes };

	if (feePerByte !== 0n) {
		// Every write would need msg.value, and a value-carrying CALL adds 9,000 to the
		// meter's window that a real transaction doesn't pay. Not worth modelling until a
		// network actually charges a fee.
		result.freshSkipped = `Skipped: feePerByte is ${feePerByte} here; the meter only handles fee-free writes.`;
		result.existingSkipped = result.freshSkipped;
	} else {
		log('section 2: fresh stream…');
		result.fresh = await benchFresh(rpc, ctx);

		const stream = opts.stream ?? (networkKey === 'monadTestnet' ? readDocsStreamId() : null);
		if (opts.skipExisting || !deployed || !stream) {
			result.existingSkipped = opts.skipExisting
				? 'Skipped (--skip-existing).'
				: 'Skipped: no deployed registry or no stream to measure against (pass --stream).';
		} else {
			log('section 3: existing stream…');
			result.existing = await benchExisting(rpc, ctx, stream);
		}
		log('section 5: multi-chunk reads and concat…');
		result.built = await benchBuilt(rpc, ctx);

		const readStreams = [...new Set([...(result.existing ? [stream] : []), ...(opts.readStreams ?? [])])];
		if (deployed && readStreams.length) {
			log('section 4: reads…');
			result.reads = [];
			for (const id of readStreams) result.reads.push(await benchReads(rpc, ctx, id));
		}
	}

	return { result, markdown: report(result) };
}

function readDocsStreamId() {
	try {
		const url = new URL('../explorer/src/mnemonad/docsStream.json', import.meta.url);
		return JSON.parse(fs.readFileSync(url, 'utf8')).testnet ?? null;
	} catch {
		return null;
	}
}

/** `--stream <id>`, `--read-stream <id>` (repeatable), `--json <file>`, `--out <file>`,
 *  `--skip-existing`. */
export function parseBenchArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === '--stream') opts.stream = argv[++i];
		else if (a === '--read-stream') (opts.readStreams ??= []).push(argv[++i]);
		else if (a === '--json') opts.json = argv[++i];
		else if (a === '--out') opts.out = argv[++i];
		else if (a === '--skip-existing') opts.skipExisting = true;
		else throw new Error(`bench-gas: unknown argument '${a}'`);
	}
	return opts;
}

/** Runs the benchmark and writes the report to stdout (and `--out`/`--json` if given). */
export async function benchGasCli(networkKey, argv) {
	const opts = parseBenchArgs(argv);
	const { result, markdown } = await benchGas(networkKey, {
		...opts,
		// Echoed in the report's "to refresh" line, minus the output flags.
		args: argv.filter((_, i) => !['--out', '--json'].includes(argv[i]) && !['--out', '--json'].includes(argv[i - 1])).join(' '),
	});
	process.stdout.write(markdown);
	if (opts.out) fs.writeFileSync(opts.out, markdown);
	if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(result, null, '\t') + '\n');
}
