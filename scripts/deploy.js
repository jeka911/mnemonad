/**
 * Deploys the Mnemonad registry to a live Monad network and records the result in
 * `js/ids.js`. Shared core for `deploy_testnet.js` and `deploy_mainnet.js` — thin CLI
 * wrappers pick the network, this does the actual work.
 *
 * Uses viem directly rather than `hardhat run`: this repo has no Hardhat/viem bridge
 * plugin installed, and the test fixture already deploys the same way
 * (see js/test/fixture.js), so this keeps one deployment code path instead of two.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad, monadTestnet } from 'viem/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'contracts/artifacts/src/Mnemonad.sol/Mnemonad.json');
const IDS_PATH = path.join(REPO_ROOT, 'js/ids.js');
const ENV_PATH = path.join(REPO_ROOT, 'contracts/.env');

/**
 * viem chain key -> js/ids.js key. The two disagree on the mainnet name (`monad` matches
 * viem/chains and contracts/hardhat.config.ts; `monadMainnet` is what ids.js already uses)
 * so the mapping lives here rather than renaming either side.
 */
const IDS_KEY = {
	monadTestnet: 'monadTestnet',
	monad: 'monadMainnet',
};

const CHAINS = { monadTestnet, monad };

/**
 * Real-network ceiling for the largest single on-chain chunk. The unit tests use small
 * values (2-20 KB, see js/test/fixture.js) so the staged multi-chunk path is exercisable
 * without huge payloads; this is the value that matters for an actual deployment, and the
 * ~120 KB single-chunk path it unlocks cannot be verified locally at all — see
 * contracts/README.md's "Known gaps".
 */
const DEFAULT_MAX_CHUNK_BYTES = 122_880n;

/**
 * @param {'monadTestnet'|'monad'} networkKey
 * @param {Object} [opts={}]
 * @param {bigint} [opts.maxChunkBytes]
 * @param {string} [opts.feeRecipient] - defaults to the deploying address.
 * @returns {Promise<{address: string, version: number, txHash: string}>}
 */
export async function deployToNetwork(networkKey, opts = {}) {
	const chain = CHAINS[networkKey];
	if (!chain) {
		throw new Error(`deploy: unknown network '${networkKey}', expected one of ${Object.keys(CHAINS).join(', ')}`);
	}
	const idsKey = IDS_KEY[networkKey];

	// Fail before spending any gas, not after: a deploy that succeeds on-chain but can't be
	// recorded leaves a real contract with no address anywhere in js/ids.js, recoverable
	// only by editing the file by hand and knowing to do so.
	assertIdsWritable(idsKey);

	loadEnv();
	const account = privateKeyToAccount(normalizeKey(requireEnv('PRIVATE_KEY')));

	const publicClient = createPublicClient({ chain, transport: http() });
	const walletClient = createWalletClient({ chain, transport: http(), account });

	const { abi, bytecode } = readArtifact();
	const maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
	const feeRecipient = opts.feeRecipient ?? account.address;

	console.log(`Deploying Mnemonad to ${chain.name} (chainId ${chain.id})`);
	console.log(`  rpc:           ${chain.rpcUrls.default.http[0]}`);
	console.log(`  deployer:      ${account.address}`);
	console.log(`  maxChunkBytes: ${maxChunkBytes}`);
	console.log(`  feeRecipient:  ${feeRecipient}`);

	const balance = await publicClient.getBalance({ address: account.address });
	if (balance === 0n) {
		const hint = chain.testnet ? 'Fund it from https://faucet.monad.xyz/ first.' : 'Fund it first.';
		throw new Error(`deploy: ${account.address} has 0 ${chain.nativeCurrency.symbol} on ${chain.name}. ${hint}`);
	}
	console.log(`  balance:       ${balance} wei ${chain.nativeCurrency.symbol}`);

	const hash = await walletClient.deployContract({ abi, bytecode, args: [maxChunkBytes, feeRecipient] });
	console.log(`  tx:            ${hash}`);

	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	if (receipt.status !== 'success' || !receipt.contractAddress) {
		throw new Error(`deploy: transaction did not produce a contract (status ${receipt.status})`);
	}

	const contractVersion = await publicClient.readContract({
		address: receipt.contractAddress,
		abi,
		functionName: 'CONTRACT_VERSION',
	});

	console.log(`  address:       ${receipt.contractAddress}`);
	console.log(`  version:       ${contractVersion}`);

	updateIds(idsKey, chain.id, Number(contractVersion), receipt.contractAddress);
	console.log(`Wrote ${idsKey} into js/ids.js`);

	return { address: receipt.contractAddress, version: Number(contractVersion), txHash: hash };
}

/**
 * Minimal `--flag value` parser, shared by the two entry scripts so the argument surface
 * (and its error messages) stays in one place.
 *
 * @param {string[]} argv
 * @returns {{maxChunkBytes?: bigint, feeRecipient?: string}}
 */
export function parseDeployArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--max-chunk-bytes') {
			out.maxChunkBytes = BigInt(argv[(i += 1)]);
		} else if (arg === '--fee-recipient') {
			out.feeRecipient = argv[(i += 1)];
		} else {
			throw new Error(`deploy: unrecognized argument '${arg}'`);
		}
	}
	return out;
}

function loadEnv() {
	try {
		process.loadEnvFile(ENV_PATH);
	} catch {
		// no contracts/.env — fine if PRIVATE_KEY is already set some other way.
	}
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`deploy: ${name} is not set. Add it to contracts/.env or export it before running.`);
	}
	return value;
}

function normalizeKey(key) {
	return key.startsWith('0x') ? key : `0x${key}`;
}

function readArtifact() {
	if (!fs.existsSync(ARTIFACT_PATH)) {
		throw new Error(`deploy: no compiled artifact at ${ARTIFACT_PATH} — run 'npm run build' in contracts/ first.`);
	}
	const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
	return { abi: artifact.abi, bytecode: artifact.bytecode };
}

/**
 * Locates one network's `{...}` block in js/ids.js. Shared by the preflight check and the
 * actual rewrite so both agree on exactly what "writable" means — a regex that matches here
 * but not there would defeat the point of checking first.
 *
 * @returns {{src: string, match: RegExpMatchArray}}
 */
function findIdsBlock(idsKey) {
	if (!fs.existsSync(IDS_PATH)) {
		throw new Error(`deploy: js/ids.js not found at ${IDS_PATH}`);
	}
	fs.accessSync(IDS_PATH, fs.constants.W_OK); // throws EACCES/ENOENT-style if not writable
	const src = fs.readFileSync(IDS_PATH, 'utf8');
	const blockRe = new RegExp(`(\\t${idsKey}: \\{\\n)([\\s\\S]*?)(\\n\\t\\},?)`);
	const match = src.match(blockRe);
	if (!match) {
		throw new Error(`deploy: could not find a '${idsKey}' block in js/ids.js — update it by hand first.`);
	}
	return { src, match };
}

/**
 * Verifies the post-deploy write to js/ids.js will succeed, before anything is deployed.
 * Also surfaces (without blocking) when a deploy is about to overwrite an existing
 * non-null address for this network — that's a real, recorded prior deployment.
 */
function assertIdsWritable(idsKey) {
	const { match } = findIdsBlock(idsKey);
	const existing = match[2].match(/contractAddress:\s*'(0x[0-9a-fA-F]+)'/);
	if (existing) {
		console.log(
			`Note: js/ids.js already has a ${idsKey} address (${existing[1]}) — this run will replace it.`
		);
	}
}

/**
 * Rewrites just one network's block in js/ids.js, preserving the file's header comment,
 * the other network's block, and that block's `chainId` — including dropping the
 * "Populated by ..." placeholder comment, since after this call it has been.
 */
function updateIds(idsKey, chainId, version, contractAddress) {
	const { src, match } = findIdsBlock(idsKey);
	const body =
		`\t\tchainId: ${chainId},\n` +
		`\t\tversion: ${version},\n` +
		`\t\tcontractAddress: '${contractAddress}',`;
	const updated =
		src.slice(0, match.index) + match[1] + body + match[3] + src.slice(match.index + match[0].length);
	fs.writeFileSync(IDS_PATH, updated);
}
