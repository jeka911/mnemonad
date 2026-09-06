/**
 * Collects protocol revenue from both pots: the upload gateway's `revenue` and the
 * registry's `feesAccrued`. Shared core for `collect_fees_testnet.js` /
 * `collect_fees_mainnet.js`.
 *
 * **Dry run by default.** This moves money, so it reports what it would do and stops;
 * pass `--execute` to actually send. Reading the amounts is free, and a fee sweep is rare
 * enough that one extra flag costs nothing next to sending to the wrong place.
 *
 * The two pots have different access models, and the script reflects that rather than
 * papering over it:
 *
 *   - `gateway.withdrawRevenue(to)` is `onlyOwner`, and the caller names the destination.
 *   - `registry.withdrawFees()` is permissionless but takes no destination — it always
 *     pays `feeRecipient`. So `--to` cannot redirect it; change `feeRecipient` instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, formatEther, getAddress } from 'viem';
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
 * Explicit gas limit for the two withdrawal calls, because estimation is useless here.
 *
 * Both contracts pay out with `to.call{value: amount}("")`, which forwards *all* remaining
 * gas. An estimator simulates against a near-block-size limit, watches the call offer all
 * of it to the recipient, and concludes the transaction might need it: `estimateContractGas`
 * returns ~39.3M for `withdrawRevenue`, a function that does one SLOAD, one SSTORE and a
 * transfer. That exceeds Monad's 30M per-transaction cap, so the send is rejected outright.
 *
 * On Monad it would be wrong even if it fit: gas is charged on the *limit*, not on usage,
 * so submitting 39M would bill 39M for ~50k of work. Hence a fixed, generous-but-sane
 * ceiling — enough for an EOA or a modest contract recipient, ~0.4% of the estimate.
 *
 * Because the limit is what gets billed, the headroom is not free: this default cost
 * 0.0153 MON against ~50k of real work. Paying out to a plain EOA can safely pass a lower
 * `--gas`; a contract with an expensive fallback needs a higher one. For scale, submitting
 * the 39.3M estimate would have cost 4.0077 MON — more than the 3.985 MON it was
 * withdrawing, i.e. a net-negative collection.
 */
const WITHDRAW_GAS_LIMIT = 150_000n;

/**
 * @param {'monadTestnet'|'monad'} networkKey
 * @param {Object} [opts={}]
 * @param {boolean} [opts.execute]      - actually send; otherwise dry run.
 * @param {string} [opts.to]            - gateway revenue destination; defaults to the signer.
 * @param {string} [opts.registry]      - defaults to the address in js/ids.js.
 * @param {boolean} [opts.gatewayOnly]
 * @param {boolean} [opts.registryOnly]
 * @param {bigint} [opts.gas]           - override the withdrawal gas limit.
 */
export async function collectFees(networkKey, opts = {}) {
	const chain = CHAINS[networkKey];
	if (!chain) {
		throw new Error(`collect-fees: unknown network '${networkKey}', expected one of ${Object.keys(CHAINS).join(', ')}`);
	}

	loadEnv();
	const account = privateKeyToAccount(normalizeKey(requireEnv('PRIVATE_KEY')));
	const publicClient = createPublicClient({ chain, transport: http() });
	const walletClient = createWalletClient({ chain, transport: http(), account });

	const registry = getAddress(opts.registry ?? readRegistryFromIds(IDS_KEY[networkKey]));
	const registryAbi = readArtifact(REGISTRY_ARTIFACT).abi;
	const gatewayAbi = readArtifact(GATEWAY_ARTIFACT).abi;

	const read = (address, abi) => (functionName, args = []) =>
		publicClient.readContract({ address, abi, functionName, args });
	const reg = read(registry, registryAbi);

	console.log(`${chain.name} (chainId ${chain.id})`);
	console.log(`  signer:   ${account.address}`);
	console.log(`  registry: ${registry}`);

	// --- registry fees -----------------------------------------------------------------
	const [feesAccrued, feeRecipient, feePerByte, registryOwner] = await Promise.all([
		reg('feesAccrued'),
		reg('feeRecipient'),
		reg('feePerByte'),
		reg('owner'),
	]);

	console.log('\nRegistry fees');
	console.log(`  feesAccrued:  ${formatEther(feesAccrued)} ${chain.nativeCurrency.symbol}`);
	console.log(`  feeRecipient: ${feeRecipient}`);
	if (feePerByte === 0n) {
		console.log('  feePerByte:   0 — the fee ships dormant, so nothing new accrues');
	}
	if (getAddress(feeRecipient) !== getAddress(account.address)) {
		// Not an error: withdrawFees is permissionless, so this signer may sweep to someone
		// else's address perfectly legitimately. Worth saying out loud before it happens.
		console.log(`  note:         proceeds go to ${feeRecipient}, not to the signer`);
	}
	if (getAddress(registryOwner) !== getAddress(account.address)) {
		console.log(`  note:         registry owner is ${registryOwner} — setFeeRecipient needs that key`);
	}

	// --- gateway revenue ---------------------------------------------------------------
	let gateway = null;
	let gatewayState = null;
	if (!opts.registryOnly) {
		const gatewayAddress = await reg('uploadGateway');
		if (!gatewayAddress || /^0x0+$/i.test(gatewayAddress)) {
			console.log('\nUpload gateway\n  none wired to this registry');
		} else {
			gateway = getAddress(gatewayAddress);
			const gw = read(gateway, gatewayAbi);
			const [revenue, escrowed, owner, balance] = await Promise.all([
				gw('revenue'),
				gw('escrowed'),
				gw('owner'),
				publicClient.getBalance({ address: gateway }),
			]);
			gatewayState = { revenue, escrowed, owner, balance };

			console.log('\nUpload gateway');
			console.log(`  address:  ${gateway}`);
			console.log(`  revenue:  ${formatEther(revenue)} ${chain.nativeCurrency.symbol}  (withdrawable)`);
			console.log(`  escrowed: ${formatEther(escrowed)} ${chain.nativeCurrency.symbol}  (owed to payers — never withdrawable)`);
			console.log(`  balance:  ${formatEther(balance)} ${chain.nativeCurrency.symbol}`);

			// The invariant the contract is built around. A shortfall would mean an
			// accounting bug; a surplus means someone force-sent native currency (which no
			// function can pay out, so it is stranded). Neither is fatal here, both are
			// worth surfacing rather than silently ignoring.
			const accounted = revenue + escrowed;
			if (balance < accounted) {
				console.log(
					`  WARNING:  balance is ${formatEther(accounted - balance)} short of revenue+escrowed — do not withdraw, investigate`
				);
			} else if (balance > accounted) {
				console.log(`  note:     ${formatEther(balance - accounted)} unaccounted (force-sent, unrecoverable)`);
			}

			if (getAddress(owner) !== getAddress(account.address)) {
				console.log(`  note:     withdrawRevenue is onlyOwner and the owner is ${owner} — this signer cannot call it`);
			}
		}
	}

	// --- act ---------------------------------------------------------------------------
	const to = getAddress(opts.to ?? account.address);
	const gasLimit = opts.gas ?? WITHDRAW_GAS_LIMIT;
	const actions = [];
	if (gateway && gatewayState && gatewayState.revenue > 0n && !opts.registryOnly) {
		actions.push({
			label: `gateway.withdrawRevenue(${to}) → ${formatEther(gatewayState.revenue)} ${chain.nativeCurrency.symbol}`,
			send: () =>
				walletClient.writeContract({
					address: gateway,
					abi: gatewayAbi,
					functionName: 'withdrawRevenue',
					args: [to],
					gas: gasLimit,
				}),
		});
	}
	if (feesAccrued > 0n && !opts.gatewayOnly) {
		actions.push({
			label: `registry.withdrawFees() → ${formatEther(feesAccrued)} ${chain.nativeCurrency.symbol} to ${feeRecipient}`,
			send: () =>
				walletClient.writeContract({
					address: registry,
					abi: registryAbi,
					functionName: 'withdrawFees',
					gas: gasLimit,
				}),
		});
	}

	console.log('');
	if (actions.length === 0) {
		console.log('Nothing to collect.');
		return { collected: [] };
	}

	if (!opts.execute) {
		console.log('Would collect (dry run — pass --execute to send):');
		for (const a of actions) console.log(`  ${a.label}`);
		return { collected: [], dryRun: true };
	}

	const collected = [];
	for (const a of actions) {
		console.log(`Sending: ${a.label}`);
		const hash = await a.send();
		const receipt = await publicClient.waitForTransactionReceipt({ hash });
		if (receipt.status !== 'success') throw new Error(`collect-fees: reverted (tx ${hash})`);
		console.log(`  ok: ${hash}`);
		collected.push({ label: a.label, txHash: hash });
	}
	return { collected };
}

/**
 * Minimal `--flag [value]` parser, matching `parseDeployArgs`' surface and error style.
 * @param {string[]} argv
 */
export function parseCollectArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--execute') out.execute = true;
		else if (arg === '--gateway-only') out.gatewayOnly = true;
		else if (arg === '--registry-only') out.registryOnly = true;
		else if (arg === '--to') out.to = argv[(i += 1)];
		else if (arg === '--registry') out.registry = argv[(i += 1)];
		else if (arg === '--gas') out.gas = BigInt(argv[(i += 1)]);
		else throw new Error(`collect-fees: unrecognized argument '${arg}'`);
	}
	if (out.gatewayOnly && out.registryOnly) {
		throw new Error('collect-fees: --gateway-only and --registry-only are mutually exclusive');
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
		throw new Error(`collect-fees: ${name} is not set. Add it to contracts/.env or export it before running.`);
	}
	return value;
}

function normalizeKey(key) {
	return key.startsWith('0x') ? key : `0x${key}`;
}

function readArtifact(artifactPath) {
	if (!fs.existsSync(artifactPath)) {
		throw new Error(`collect-fees: no compiled artifact at ${artifactPath} — run 'pnpm build' in contracts/ first.`);
	}
	return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
}

/** Reads the registry address this network's `js/ids.js` block records. */
function readRegistryFromIds(idsKey) {
	if (!fs.existsSync(IDS_PATH)) throw new Error(`collect-fees: js/ids.js not found at ${IDS_PATH}`);
	const src = fs.readFileSync(IDS_PATH, 'utf8');
	const block = src.match(new RegExp(`\\t${idsKey}: \\{\\n([\\s\\S]*?)\\n\\t\\},?`));
	if (!block) throw new Error(`collect-fees: could not find a '${idsKey}' block in js/ids.js`);
	const address = block[1].match(/contractAddress:\s*'(0x[0-9a-fA-F]{40})'/);
	if (!address) {
		throw new Error(`collect-fees: js/ids.js has no ${idsKey} contractAddress — pass --registry 0x...`);
	}
	return address[1];
}
