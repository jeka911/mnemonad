/**
 * Regenerates `js/abi.js` and `js/test/artifact.js` from the compiled Hardhat artifact.
 *
 * Run after any change to the Solidity sources:
 *   cd contracts && pnpm build
 *   cd ../scripts && node sync_abi.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const jsRoot = path.join(REPO_ROOT, 'js');
const artifactPath = path.join(REPO_ROOT, 'contracts/artifacts/src/Mnemonad.sol/Mnemonad.json');

if (!fs.existsSync(artifactPath)) {
	console.error(`Artifact not found at ${artifactPath}\nRun \`pnpm build\` in ../contracts first.`);
	process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

fs.writeFileSync(
	path.join(jsRoot, 'abi.js'),
	`/**
 * ABI of the Mnemonad registry contract.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node sync_abi.js (from scripts/)
 */
export const mnemonadAbi = ${JSON.stringify(artifact.abi, null, '\t')};

export default mnemonadAbi;
`
);

// Bytecode is needed only by the tests, which deploy a fresh registry to a local node.
// Keeping it out of the published entrypoint avoids shipping ~25 KB of hex to consumers.
fs.mkdirSync(path.join(jsRoot, 'test'), { recursive: true });
fs.writeFileSync(
	path.join(jsRoot, 'test/artifact.js'),
	`/**
 * Compiled Mnemonad artifact, for tests that deploy to a local node.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node sync_abi.js (from scripts/)
 */
export const abi = ${JSON.stringify(artifact.abi)};

export const bytecode = ${JSON.stringify(artifact.bytecode)};

export default { abi, bytecode };
`
);

// The gateway's ABI ships alongside the registry's: the SDK needs it to read quotes and
// escrow state, and the two are versioned together. Bytecode is not exported — nothing in
// the JS tests deploys a gateway (its behaviour is covered by the Solidity suite), so
// shipping another ~7 KB of hex to consumers would buy nothing.
const gatewayArtifactPath = path.join(
	REPO_ROOT,
	'contracts/artifacts/src/MnemonadUploadGateway.sol/MnemonadUploadGateway.json'
);
if (!fs.existsSync(gatewayArtifactPath)) {
	console.error(`Gateway artifact not found at ${gatewayArtifactPath}\nRun \`pnpm build\` in ../contracts first.`);
	process.exit(1);
}
const gatewayArtifact = JSON.parse(fs.readFileSync(gatewayArtifactPath, 'utf8'));

fs.writeFileSync(
	path.join(jsRoot, 'gatewayAbi.js'),
	`/**
 * ABI of the MnemonadUploadGateway contract.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node sync_abi.js (from scripts/)
 */
export const uploadGatewayAbi = ${JSON.stringify(gatewayArtifact.abi, null, '\t')};

export default uploadGatewayAbi;
`
);

const fns = artifact.abi.filter((x) => x.type === 'function').length;
const gwFns = gatewayArtifact.abi.filter((x) => x.type === 'function').length;
console.log(
	`Synced registry ABI (${fns} functions), gateway ABI (${gwFns} functions), ` +
	`and test artifact (${artifact.bytecode.length} hex chars).`
);
