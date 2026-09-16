/**
 * Project-wide operational defaults for the CLI — non-secret URLs only, safe to commit.
 * Never put a key or JWT in here: those stay in `--key`/`MNEMONAD_KEY`/`PINATA_JWT`, which
 * this file has no bearing on.
 *
 * Precedence bin/mnemonad.js applies for every value here: CLI flag > env var > this file >
 * a hardcoded fallback (kept in case this file goes missing or fails to parse).
 */
export default {
    // The presign server (../presign-server/) this project runs by default — see its own
    // README for what it does. Pushing an item too big to fit on-chain (over the registry's
    // maxChunkBytes) uses this automatically, so a signer needs no Pinata credential of
    // their own. Overridable per-run with --presign-url or MNEMONAD_PRESIGN_URL.
    presignUrl: 'https://presign-server.vercel.app',

    // Public IPFS gateway for *reading* externally-offloaded items (pull/diff/info/watch)
    // — same default the explorer dApp uses (explorer/src/mnemonad/presignProvider.js), so
    // a stream pushed through either tool reads back the same way with no setup. Overridable
    // per-run with --gateway-url or MNEMONAD_IPFS_GATEWAY.
    gatewayUrl: 'https://gateway.pinata.cloud/ipfs/',
};
