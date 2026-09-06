/**
 * Deploys `MnemonadUploadGateway` against an already-deployed registry and wires the two
 * together. Shared core for `deploy_gateway_testnet.js` / `deploy_gateway_mainnet.js`.
 *
 * Deliberately separate from `deploy.js` rather than folded into it:
 *   - The registry deploy is the load-bearing, preflight-guarded path and shouldn't grow a
 *     second contract's config surface (Pyth address, feed id) that can fail it.
 *   - Deploy order is forced anyway — the gateway's `mnemonad` is immutable, so the registry
 *     must exist first.
 *   - The gateway is optional. A registry with `uploadGateway == address(0)` behaves exactly
 *     as it did before the hook existed.
 *
 * The resulting address is deliberately NOT recorded in `js/ids.js`: it is readable on-chain
 * via `Mnemonad.uploadGateway()`, so the registry stays the single source of truth and the
 * two can never disagree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad, monadTestnet } from 'viem/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const REGISTRY_ARTIFACT = path.join(REPO_ROOT, 'contracts/artifacts/src/Mnemonad.sol/Mnemonad.json');
const GATEWAY_ARTIFACT = path.join(
	REPO_ROOT,
	'contracts/artifacts/src/MnemonadUploadGateway.sol/MnemonadUploadGateway.json'
);
const IDS_PATH = path.join(REPO_ROOT, 'js/ids.js');
const ENV_PATH = path.join(REPO_ROOT, 'contracts/.env');

const CHAINS = { monadTestnet, monad };
const IDS_KEY = { monadTestnet: 'monadTestnet', monad: 'monadMainnet' };

/**
 * Pyth's price-feed contract per network.
 *
 * Only testnet is defaulted, and only because Monad's own docs publish it in full
 * (docs.monad.xyz/tooling-and-infra/oracles). Mainnet must be passed explicitly with
 * `--pyth`: Pyth commonly reuses one address across chains, but "commonly" is not a basis
 * for hardcoding the oracle of a contract that prices real money.
 */
const PYTH_ADDRESS = {
	monadTestnet: '0x2880aB155794e7179c9eE2e38200202908C17B43',
	monad: null,
};

/**
 * MON/USD feed id. Per Monad's docs this feed has graduated from Pyth's beta programme and
 * is served by the *primary* price-feed contract on both testnet and mainnet — the beta
 * contract (0xad2B52D2af1a9bD5c561894Cdd84f7505e1CD0B5) no longer serves it at all.
 */
const MON_USD_FEED_ID = '0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1';

/** The registry version that first carried the `uploadGateway` hook. */
const MIN_REGISTRY_VERSION = 2;

/** Mirrors `MnemonadUploadGateway.MAX_WEI_PER_MIB` — the constant band ceiling. */
const MAX_WEI_PER_MIB = 10n ** 21n;

/** Default headline price when `--cents-per-mib` is not given. Always logged. */
const DEFAULT_CENTS_PER_MIB = 5n;

/**
 * How far either side of the live rate the circuit-breaker band is placed by default.
 * A band is mandatory (the constructor rejects a zero ceiling) and has no meaningful
 * constant default, since it is denominated in wei and therefore depends entirely on
 * what MON is worth — so it is derived from the oracle at deploy time instead of guessed.
 */
const BAND_FACTOR = 10n;

/**
 * @param {'monadTestnet'|'monad'} networkKey
 * @param {Object} [opts={}]
 * @param {string} [opts.registry]   - defaults to the address recorded in js/ids.js.
 * @param {string} [opts.pyth]       - defaults per network, see PYTH_ADDRESS.
 * @param {string} [opts.feedId]     - defaults to MON/USD.
 * @param {string} [opts.owner]      - gateway owner; defaults to the deploying address.
 * @param {bigint} [opts.centsPerMiB]   - headline price; defaults to DEFAULT_CENTS_PER_MIB.
 * @param {bigint} [opts.minChargeWei]  - per-request floor; defaults to 0.
 * @param {bigint} [opts.minWeiPerMiB]  - band floor; derived from the live rate if omitted.
 * @param {bigint} [opts.maxWeiPerMiB]  - band ceiling; derived from the live rate if omitted.
 * @param {boolean} [opts.noWire]    - deploy only, skip `setUploadGateway`.
 * @returns {Promise<{address: string, txHash: string, wired: boolean}>}
 */
export async function deployGateway(networkKey, opts = {}) {
	const chain = CHAINS[networkKey];
	if (!chain) {
		throw new Error(`deploy-gateway: unknown network '${networkKey}', expected one of ${Object.keys(CHAINS).join(', ')}`);
	}

	const pythAddress = opts.pyth ?? PYTH_ADDRESS[networkKey];
	if (!pythAddress) {
		throw new Error(
			`deploy-gateway: no default Pyth address for '${networkKey}' — pass --pyth 0x... ` +
			'(see https://docs.pyth.network/price-feeds/core/contract-addresses/evm).'
		);
	}
	const feedId = opts.feedId ?? MON_USD_FEED_ID;

	loadEnv();
	const account = privateKeyToAccount(normalizeKey(requireEnv('PRIVATE_KEY')));

	const publicClient = createPublicClient({ chain, transport: http() });
	const walletClient = createWalletClient({ chain, transport: http(), account });

	const registry = getAddress(opts.registry ?? readRegistryFromIds(IDS_KEY[networkKey]));
	const registryAbi = readArtifact(REGISTRY_ARTIFACT).abi;
	const owner = opts.owner ?? account.address;

	// Everything checkable is checked before any gas is spent: a deployed-but-unwired gateway
	// is recoverable, but only by someone who knows to go looking for it.
	const liveRate = await preflight({
		publicClient,
		registry,
		registryAbi,
		account,
		pythAddress,
		feedId,
		noWire: opts.noWire,
	});

	const pricing = resolvePricing(opts, liveRate);

	console.log(`Deploying MnemonadUploadGateway to ${chain.name} (chainId ${chain.id})`);
	console.log(`  deployer:      ${account.address}`);
	console.log(`  registry:      ${registry}`);
	console.log(`  pyth:          ${pythAddress}`);
	console.log(`  feedId:        ${feedId}`);
	console.log(`  owner:         ${owner}`);
	console.log(`  price:         ${pricing.cents}c per MiB`);
	console.log(`  minCharge:     ${pricing.minChargeWei} wei`);
	console.log(`  band:          ${fmtMon(pricing.minWeiPerMiB)} .. ${fmtMon(pricing.maxWeiPerMiB)} MON/MiB`);
	if (liveRate) console.log(`  live rate now: ${fmtMon(liveRate)} MON/MiB`);

	const { abi, bytecode } = readArtifact(GATEWAY_ARTIFACT);
	const hash = await walletClient.deployContract({
		abi,
		bytecode,
		args: [
			registry,
			pythAddress,
			feedId,
			owner,
			pricing.cents,
			pricing.minChargeWei,
			pricing.minWeiPerMiB,
			pricing.maxWeiPerMiB,
		],
	});
	console.log(`  tx:            ${hash}`);

	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	if (receipt.status !== 'success' || !receipt.contractAddress) {
		throw new Error(`deploy-gateway: transaction did not produce a contract (status ${receipt.status})`);
	}
	const gateway = receipt.contractAddress;
	console.log(`  address:   ${gateway}`);

	let wired = false;
	if (opts.noWire) {
		console.log('\nSkipped wiring (--no-wire). The registry still ignores this gateway.');
	} else {
		const wireHash = await walletClient.writeContract({
			address: registry,
			abi: registryAbi,
			functionName: 'setUploadGateway',
			args: [gateway],
		});
		const wireReceipt = await publicClient.waitForTransactionReceipt({ hash: wireHash });
		if (wireReceipt.status !== 'success') {
			throw new Error(
				`deploy-gateway: gateway deployed at ${gateway} but setUploadGateway reverted (tx ${wireHash}). ` +
				'Re-run setUploadGateway by hand — do not redeploy.'
			);
		}
		wired = true;
		console.log(`  wired:         ${wireHash}`);
	}

	// No post-deploy ritual: pricing went in at construction and the rate is read live from
	// Pyth, so the gateway is sellable the moment it is wired.
	console.log(
		wired
			? '\nLive. Quote a size with quote(bytes), then payForUpload(contentHash, maxSize).'
			: '\nDeployed but not wired — the registry ignores it until setUploadGateway is called.'
	);

	return { address: gateway, txHash: hash, wired };
}

/**
 * Refuses the deploy for the two reasons that would otherwise waste gas or leave a
 * half-configured system: a registry that predates the hook, and a deployer who cannot wire
 * it. Also reads the oracle once, so a wrong Pyth address or feed id surfaces here rather
 * than as a mystery revert on the first quote.
 */
async function preflight({ publicClient, registry, registryAbi, account, pythAddress, feedId, noWire }) {
	const version = Number(
		await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'CONTRACT_VERSION' })
	);
	if (version < MIN_REGISTRY_VERSION) {
		throw new Error(
			`deploy-gateway: registry at ${registry} reports v${version}, but the uploadGateway hook ` +
			`landed in v${MIN_REGISTRY_VERSION}. Redeploy the registry first.`
		);
	}

	if (!noWire) {
		const owner = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'owner' });
		if (getAddress(owner) !== getAddress(account.address)) {
			throw new Error(
				`deploy-gateway: setUploadGateway is onlyOwner, but the registry owner is ${owner} ` +
				`and PRIVATE_KEY is ${account.address}. Use the owner key, or pass --no-wire and ` +
				'call setUploadGateway separately.'
			);
		}
	}

	const balance = await publicClient.getBalance({ address: account.address });
	if (balance === 0n) throw new Error(`deploy-gateway: ${account.address} has no funds on this network.`);

	// Reading a price IS required now: pricing goes in at construction, and the default
	// circuit-breaker band is derived from the live rate rather than guessed. A failure here
	// is only survivable if the caller supplies the band explicitly.
	try {
		const price = await publicClient.readContract({
			address: pythAddress,
			abi: [
				{
					name: 'getPriceUnsafe',
					type: 'function',
					stateMutability: 'view',
					inputs: [{ name: 'id', type: 'bytes32' }],
					outputs: [
						{
							type: 'tuple',
							components: [
								{ name: 'price', type: 'int64' },
								{ name: 'conf', type: 'uint64' },
								{ name: 'expo', type: 'int32' },
								{ name: 'publishTime', type: 'uint256' },
							],
						},
					],
				},
			],
			functionName: 'getPriceUnsafe',
			args: [feedId],
		});
		const usd = Number(price.price) * 10 ** Number(price.expo);
		const ageDays = ((Date.now() / 1000 - Number(price.publishTime)) / 86400).toFixed(1);
		console.log(`Oracle check: MON/USD ≈ $${usd.toPrecision(6)}, published ${ageDays}d ago`);
		return weiPerMiBFor(price.price, price.expo, DEFAULT_CENTS_PER_MIB);
	} catch (err) {
		console.log(`Oracle check: could not read ${feedId} from ${pythAddress} — ${err.shortMessage || err.message}`);
		console.log('  Verify --pyth and --feed-id, or pass --max-wei-per-mib to set the band by hand.');
		return null;
	}
}

/**
 * Recreates the contract's own rate maths in JS, so the derived band is anchored to the
 * same number the contract will compute rather than to an approximation.
 * @param {bigint} price @param {number} expo @param {bigint} cents
 */
export function weiPerMiBFor(price, expo, cents) {
	const shift = 18n + BigInt(expo); // expo is negative in practice (-8)
	if (shift < 0n) throw new Error(`deploy-gateway: unsupported oracle exponent ${expo}`);
	const usdPerMon1e18 = BigInt(price) * 10n ** shift;
	return (cents * 10n ** 18n * 10n ** 18n) / (usdPerMon1e18 * 100n);
}

/**
 * Settles the four pricing values the constructor now demands. The headline price has a
 * logged default; the band is derived from the live rate because a wei-denominated bound
 * has no sensible constant — what counts as "absurdly expensive per MiB" depends entirely
 * on what MON is worth.
 */
export function resolvePricing(opts, liveRate) {
	const cents = opts.centsPerMiB ?? DEFAULT_CENTS_PER_MIB;
	if (cents <= 0n) throw new Error('deploy-gateway: --cents-per-mib must be greater than 0');
	const minChargeWei = opts.minChargeWei ?? 0n;

	let minWeiPerMiB = opts.minWeiPerMiB;
	let maxWeiPerMiB = opts.maxWeiPerMiB;

	if (maxWeiPerMiB === undefined) {
		if (liveRate === null) {
			throw new Error(
				'deploy-gateway: the oracle could not be read, so the circuit-breaker band cannot be ' +
				'derived — pass --max-wei-per-mib (and optionally --min-wei-per-mib) explicitly.'
			);
		}
		// Scale the oracle-derived rate to the chosen price before widening it.
		const expected = (liveRate * cents) / DEFAULT_CENTS_PER_MIB;
		maxWeiPerMiB = expected * BAND_FACTOR;
		if (maxWeiPerMiB > MAX_WEI_PER_MIB) maxWeiPerMiB = MAX_WEI_PER_MIB;
		if (minWeiPerMiB === undefined) minWeiPerMiB = expected / BAND_FACTOR;
	}
	if (minWeiPerMiB === undefined) minWeiPerMiB = 0n;

	if (maxWeiPerMiB <= 0n) throw new Error('deploy-gateway: --max-wei-per-mib must be greater than 0');
	if (maxWeiPerMiB > MAX_WEI_PER_MIB) {
		throw new Error(`deploy-gateway: --max-wei-per-mib exceeds the contract ceiling ${MAX_WEI_PER_MIB}`);
	}
	if (minWeiPerMiB > maxWeiPerMiB) {
		throw new Error('deploy-gateway: --min-wei-per-mib is above --max-wei-per-mib (an unsatisfiable band)');
	}

	return { cents, minChargeWei, minWeiPerMiB, maxWeiPerMiB };
}

/** @param {bigint} wei */
function fmtMon(wei) {
	return (Number(wei) / 1e18).toFixed(4);
}

/**
 * Minimal `--flag value` parser, matching `parseDeployArgs`' surface and error style.
 * @param {string[]} argv
 */
export function parseGatewayArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--registry') out.registry = argv[(i += 1)];
		else if (arg === '--pyth') out.pyth = argv[(i += 1)];
		else if (arg === '--feed-id') out.feedId = argv[(i += 1)];
		else if (arg === '--owner') out.owner = argv[(i += 1)];
		else if (arg === '--cents-per-mib') out.centsPerMiB = BigInt(argv[(i += 1)]);
		else if (arg === '--min-charge-wei') out.minChargeWei = BigInt(argv[(i += 1)]);
		else if (arg === '--min-wei-per-mib') out.minWeiPerMiB = BigInt(argv[(i += 1)]);
		else if (arg === '--max-wei-per-mib') out.maxWeiPerMiB = BigInt(argv[(i += 1)]);
		else if (arg === '--no-wire') out.noWire = true;
		else throw new Error(`deploy-gateway: unrecognized argument '${arg}'`);
	}
	return out;
}

function loadEnv() {
	try {
		process.loadEnvFile(ENV_PATH);
	} catch {
		// no contracts/.env — fine if PRIVATE_KEY is already exported.
	}
}

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`deploy-gateway: ${name} is not set. Add it to contracts/.env or export it before running.`);
	}
	return value;
}

function normalizeKey(key) {
	return key.startsWith('0x') ? key : `0x${key}`;
}

function readArtifact(artifactPath) {
	if (!fs.existsSync(artifactPath)) {
		throw new Error(
			`deploy-gateway: no compiled artifact at ${artifactPath} — run 'pnpm build' in contracts/ first.`
		);
	}
	const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
	return { abi: artifact.abi, bytecode: artifact.bytecode };
}

/** Reads the registry address this network's `js/ids.js` block already records. */
function readRegistryFromIds(idsKey) {
	if (!fs.existsSync(IDS_PATH)) throw new Error(`deploy-gateway: js/ids.js not found at ${IDS_PATH}`);
	const src = fs.readFileSync(IDS_PATH, 'utf8');
	const block = src.match(new RegExp(`\\t${idsKey}: \\{\\n([\\s\\S]*?)\\n\\t\\},?`));
	if (!block) throw new Error(`deploy-gateway: could not find a '${idsKey}' block in js/ids.js`);
	const address = block[1].match(/contractAddress:\s*'(0x[0-9a-fA-F]{40})'/);
	if (!address) {
		throw new Error(
			`deploy-gateway: js/ids.js has no ${idsKey} contractAddress — deploy the registry first, ` +
			'or pass --registry 0x...'
		);
	}
	return address[1];
}
