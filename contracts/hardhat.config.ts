import type { HardhatUserConfig } from "hardhat/config";

// Loads contracts/.env if present (deploy key, nothing else needs it). Node's own loader,
// no dotenv dependency. Missing file is fine — local test runs never need one.
try {
    process.loadEnvFile();
} catch {
    // no .env — fine for `hardhat test`, only the deploy script needs PRIVATE_KEY.
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;

/**
 * Mnemonad — Monad contracts.
 *
 * `evmVersion` is pinned to cancun: Monad is EVM-equivalent at the bytecode level but is
 * not on Prague/Osaka, so newer opcodes must stay out of the output.
 */
const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.28",
        settings: {
            evmVersion: "cancun",
            optimizer: {
                enabled: true,
                // Monad's 128 KB code limit would allow aggressive inlining, but the local
                // EDR test node enforces EIP-170's 24,576 bytes and offers no
                // `allowUnlimitedContractSize` for Solidity tests. Keeping runs modest holds
                // the registry under 24 KB so it stays unit-testable — and incidentally
                // deployable on any EVM chain, not just Monad.
                runs: 200,
            },
        },
    },
    paths: {
        sources: "src",
        tests: {
            solidity: "test",
        },
    },
    networks: {
        monadTestnet: {
            type: "http",
            url: "https://testnet-rpc.monad.xyz",
            chainId: 10143,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
        },
        monad: {
            type: "http",
            url: "https://rpc.monad.xyz",
            chainId: 143,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
        },
    },
};

export default config;
