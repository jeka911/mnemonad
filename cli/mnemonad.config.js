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

    // IPFS gateway for *reading* externally-offloaded items (pull/diff/info/watch) — same
    // default the explorer dApp uses (explorer/src/mnemonad/presignProvider.js), so a stream
    // pushed through either tool reads back the same way with no setup. Overridable per-run
    // with --gateway-url or MNEMONAD_IPFS_GATEWAY.
    //
    // A Pinata *dedicated* gateway, not the shared `gateway.pinata.cloud` — measured live: a
    // burst of 20 rapid reads of the same CID got 20/20 429 on the shared gateway and 20/20
    // (then 50/50) 200 here, fully unauthenticated. Safe to commit: it's a hostname, not a
    // credential, and the content behind it is public IPFS either way. List yours with
    // `GET https://api.pinata.cloud/v3/ipfs/gateways`.
    gatewayUrl: 'https://azure-casual-firefly-850.mypinata.cloud/ipfs/',
};
