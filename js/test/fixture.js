import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abi, bytecode } from './artifact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.join(__dirname, '../../contracts');

/**
 * Resolved once `startNode()` returns. A free port is chosen per run rather than a fixed
 * one: a fixed port invites a race against a node from a previous run that is still
 * listening but already shutting down, which shows up as an intermittent
 * "HTTP request failed" during deployment.
 */
let RPC_URL = null;
let CHAIN = null;

/**
 * Well-known Hardhat Network development keys, derived from the standard
 * "test test ... junk" mnemonic. Local-node only; never used against a real chain.
 */
const KEYS = [
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
	'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];

/** The chain the current run is talking to. Valid only after `startNode()`. */
export function getChain() {
	if (!CHAIN) throw new Error('fixture: call startNode() first');
	return CHAIN;
}

/** The RPC URL the current run is talking to. Valid only after `startNode()`. */
export function getRpcUrl() {
	if (!RPC_URL) throw new Error('fixture: call startNode() first');
	return RPC_URL;
}

/**
 * Boots a local Hardhat node as a child process.
 *
 * The SDK's IPFS layer is exercised with an in-memory transport instead of a real pinning
 * service, so these tests need no network access at all.
 *
 * Set `EV_TEST_RPC_URL` to reuse a node you're already running, for faster iteration.
 * That has to be explicit: auto-detecting a listening node made the suite race against
 * one left over from a previous run.
 *
 * @returns {Promise<{stop: () => Promise<void>}>}
 */
export async function startNode() {
	if (process.env.EV_TEST_RPC_URL) {
		RPC_URL = process.env.EV_TEST_RPC_URL;
		CHAIN = makeChain(RPC_URL);
		if (!(await isReady(RPC_URL))) {
			throw new Error(`fixture: no usable node at ${RPC_URL}`);
		}
		return { stop: async () => {} };
	}

	const port = await freePort();
	RPC_URL = `http://127.0.0.1:${port}`;
	CHAIN = makeChain(RPC_URL);

	const child = spawn(
		'npx',
		['hardhat', 'node', '--port', String(port), '--hostname', '127.0.0.1'],
		{
			cwd: CONTRACTS_DIR,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				// Hardhat watches the artifacts tree for recompilation. Six suites, each
				// spawning a node, exhausts Linux's inotify instance budget
				// (`fs.inotify.max_user_instances`, 128 here) and the node dies with
				// EMFILE before it can serve anything. Polling costs a little CPU and
				// needs no kernel watches; these nodes are short-lived and nothing
				// recompiles under them, so the watcher has no work to do either way.
				CHOKIDAR_USEPOLLING: '1',
				CHOKIDAR_INTERVAL: '1000',
			},
		}
	);

	let stderr = '';
	child.stderr.on('data', (d) => { stderr += d.toString(); });

	const stop = async () => {
		if (child.exitCode !== null) return;
		child.kill('SIGTERM');
		await Promise.race([
			new Promise((res) => child.once('exit', res)),
			sleep(5_000).then(() => child.kill('SIGKILL')),
		]);
	};

	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`hardhat node exited early (code ${child.exitCode}):\n${stderr}`);
		}
		if (await isReady(RPC_URL)) return { stop };
		await sleep(200);
	}

	await stop();
	throw new Error(`hardhat node did not become ready on ${RPC_URL}:\n${stderr}`);
}

/**
 * @returns {{publicClient: Object, walletClient: Object, account: Object, accounts: Object[]}}
 */
export function makeClients() {
	const chain = getChain();
	const accounts = KEYS.map((k) => privateKeyToAccount(k));
	const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
	const walletClient = createWalletClient({
		chain,
		transport: http(RPC_URL),
		account: accounts[0],
	});
	return { publicClient, walletClient, account: accounts[0], accounts };
}

/**
 * Deploys a fresh registry.
 *
 * @param {Object} clients - from makeClients()
 * @param {Object} [params={}]
 * @param {number} [params.maxChunkBytes=20000] - deliberately configurable: a small value
 *        makes the staged multi-chunk path testable without needing >20 KB payloads.
 * @param {?string} [params.feeRecipient]
 * @returns {Promise<string>} the deployed address
 */
export async function deployRegistry(clients, params = {}) {
	const { publicClient, walletClient, account } = clients;
	const maxChunkBytes = BigInt(params.maxChunkBytes ?? 20_000);
	const feeRecipient = params.feeRecipient || account.address;

	const hash = await walletClient.deployContract({
		abi,
		bytecode,
		args: [maxChunkBytes, feeRecipient],
	});
	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	if (receipt.status !== 'success' || !receipt.contractAddress) {
		throw new Error('registry deployment failed');
	}
	return receipt.contractAddress;
}

/** Lazily read — only the two tests that actually deploy a gateway pay for this. */
function readArtifact(relativePath) {
	const full = path.join(CONTRACTS_DIR, relativePath);
	if (!fs.existsSync(full)) {
		throw new Error(`fixture: artifact not found at ${full} — run \`pnpm build\` in contracts/ first`);
	}
	return JSON.parse(fs.readFileSync(full, 'utf8'));
}

/**
 * Deploys a `MockPyth` + `MnemonadUploadGateway` pair and wires it to `registryAddress`,
 * mirroring `contracts/test/MnemonadUploadGateway.t.sol`'s own `setUp()` exactly (same
 * price/expo/pricing constants) so the numbers here are hand-checkable against that suite
 * rather than invented fresh. Deliberately the *only* JS-side gateway deployment in the
 * repo — `sync_abi.js`'s own comment notes the gateway's on-chain behavior is covered by
 * the Solidity suite, not the JS one; this exists specifically to prove `Mnemonad.push()`'s
 * own orchestration (encrypt → commit → pay → upload) calls a *real* gateway correctly,
 * which the Solidity suite has no way to exercise (it never runs the SDK).
 *
 * @param {Object} clients - from makeClients()
 * @param {string} registryAddress
 * @returns {Promise<{gatewayAddress: string, pythAddress: string}>}
 */
export async function deployGateway(clients, registryAddress) {
	const { publicClient, walletClient, account } = clients;

	const pythArtifact = readArtifact('artifacts/test/MnemonadUploadGateway.t.sol/MockPyth.json');
	const gatewayArtifact = readArtifact('artifacts/src/MnemonadUploadGateway.sol/MnemonadUploadGateway.json');

	const pythHash = await walletClient.deployContract({
		abi: pythArtifact.abi,
		bytecode: pythArtifact.bytecode,
		args: [],
	});
	const pythReceipt = await publicClient.waitForTransactionReceipt({ hash: pythHash });
	const pythAddress = pythReceipt.contractAddress;

	// MON/USD = $0.025 at Pyth's usual exponent — same numbers EvTest's setUp() uses, so a
	// discrepancy against that suite would be a real signal, not just a different fixture.
	const PRICE = 2_500_000n;
	const EXPO = -8;
	const block = await publicClient.getBlock();
	await walletClient.writeContract({
		address: pythAddress,
		abi: pythArtifact.abi,
		functionName: 'set',
		args: [PRICE, 1000n, EXPO, block.timestamp],
	});

	const FEED = `0x${'0'.repeat(60)}feed`;
	const CENTS_PER_MIB = 5n; // $0.05/MiB — 2 MON/MiB at the price above
	const BAND_MAX = 100n * 10n ** 18n;
	const gatewayHash = await walletClient.deployContract({
		abi: gatewayArtifact.abi,
		bytecode: gatewayArtifact.bytecode,
		args: [registryAddress, pythAddress, FEED, account.address, CENTS_PER_MIB, 0n, 0n, BAND_MAX],
	});
	const gatewayReceipt = await publicClient.waitForTransactionReceipt({ hash: gatewayHash });
	const gatewayAddress = gatewayReceipt.contractAddress;

	await walletClient.writeContract({
		address: registryAddress,
		abi,
		functionName: 'setUploadGateway',
		args: [gatewayAddress],
	});

	return { gatewayAddress, pythAddress };
}

/**
 * An in-memory IPFS transport, content-addressed by sha256 so CIDs are stable across
 * re-uploads (which is what `repin()` relies on).
 *
 * @returns {{put: Function, get: Function, store: Map<string, Uint8Array>, corrupt: Function}}
 */
export function makeMockIpfs(params = {}) {
	const store = new Map();
	/** Bytes actually handed out, so a test can prove a range read didn't pull the lot. */
	const stats = { bytesRead: 0, wholeReads: 0, rangeReads: 0 };

	const transport = {
		store,
		stats,
		async put(bytes) {
			const cid = `bafyTEST${simpleHash(bytes)}`;
			store.set(cid, new Uint8Array(bytes));
			return cid;
		},
		async get(cid) {
			if (!store.has(cid)) throw new Error(`mock ipfs: ${cid} not pinned`);
			const data = store.get(cid);
			stats.bytesRead += data.length;
			stats.wholeReads += 1;
			return data;
		},
		/** Replaces a pinned payload with different bytes, to test read-time verification. */
		corrupt(cid, bytes) {
			store.set(cid, new Uint8Array(bytes));
		},
		reset() {
			stats.bytesRead = 0;
			stats.wholeReads = 0;
			stats.rangeReads = 0;
		},
	};

	// Omitting getRange emulates a transport with no ranged support, which must still be
	// correct — just not cheap.
	if (!params.noRange) {
		transport.getRange = async (cid, start, len) => {
			if (!store.has(cid)) throw new Error(`mock ipfs: ${cid} not pinned`);
			const data = store.get(cid);
			stats.bytesRead += len;
			stats.rangeReads += 1;
			return data.subarray(start, start + len);
		};
	}

	return transport;
}

/**
 * Deterministic pseudo-random bytes. Mirrors the `_bytes` helper in the Solidity tests so
 * the two suites exercise the same payloads.
 *
 * @param {number} len
 * @param {number} [seed=1]
 * @returns {Uint8Array}
 */
export function makeBytes(len, seed = 1) {
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i += 1) {
		out[i] = (((i * 31 + seed) % 251) + 1) & 0xff;
	}
	return out;
}

function makeChain(rpcUrl) {
	return defineChain({
		id: 31337,
		name: 'Hardhat',
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } },
	});
}

/** Asks the OS for an unused port by binding to 0 and reading back what it assigned. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/**
 * Readiness means "can actually serve the calls a deployment needs", not just "answered
 * once". A single successful `eth_chainId` is satisfied by a node that is still starting
 * up or already tearing down.
 */
async function isReady(rpcUrl) {
	for (const method of ['eth_chainId', 'eth_blockNumber', 'eth_accounts']) {
		if (!(await rpc(rpcUrl, method))) return false;
	}
	return true;
}

async function rpc(rpcUrl, method) {
	try {
		const res = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
		});
		if (!res.ok) return false;
		const json = await res.json();
		return json.result !== undefined;
	} catch {
		return false;
	}
}

function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

function simpleHash(bytes) {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i += 1) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}
