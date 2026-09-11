# Mnemonad

##### TLDR:

On the base protocol layer, Mnemonad is an infinite bytes[] that lives entirely on-chain on Monad — append-only and unbounded in length, growing past what any single transaction could hold via chunked/staged writes — exposed as an ERC-721 NFT, so each "stream" is a token you own, can grant others write access to, and can optionally encrypt client-side. Storage auto-tiers by cost: packed slots → contract code → off-chain offload with just a hash+locator kept on-chain, paid for without ever putting a pinning-service credential in the browser. IPFS is the offload backend implemented today — the pointer format (codec + locator) is deliberately generic, so other backends (Arweave, HTTPS, Filecoin, Walrus, whatever comes next) can be added without a redeploy.

As we extend it — sets of streams, version control, sync, richer per-item structure, more offload backends — that base layer is what stays fixed underneath.

It ships as smart contracts, an SDK, a dApp, and a set of supporting tools — not just a protocol spec.

## Layout

| Path | What |
|---|---|
| [`contracts/`](contracts/) | The Solidity registry contract + paid-upload gateway, Hardhat 3 project |
| [`js/`](js/) | The JavaScript/TypeScript SDK |
| [`explorer/`](explorer/README.md) | Vue 3 + Quasar block explorer / demo app |
| [`presign-server/`](presign-server/) | Issues Pinata upload URLs against paid on-chain escrow |
| [`monadsync/`](monadsync/README.md) | DoubleSync + Mnemonad: versioned folder-tree sync on-chain |
| [`scripts/`](scripts/) | Deployment and ABI-sync tooling |

## Paid off-chain uploads

An item too large for the chain is stored as an `EXTERNAL` pointer — a CID plus a sha256 —
and something has to pay a pinning service to hold the bytes. Two contracts and one service
cover that:

`MnemonadUploadGateway` sells upload quota for MON, priced in USD via Pyth's MON/USD feed.
A client commits on-chain to `(contentHash, maxSize)` and escrows the quote;
[`presign-server/`](presign-server/) reads that escrow and hands back a one-shot Pinata
upload URL; the subsequent `pushExternal` settles the escrow and waives the registry's own
`EXTERNAL` fee. The full flow:

```
payForUpload(hash, maxSize) ──► escrow        (client pays MON)
POST /upload-url             ──► upload URL   (server checks escrow, EIP-712 signature)
POST <url>                   ──► CID          (browser holds no Pinata credential)
pushExternal(Pointer{hash})  ──► settled      (escrow consumed, EXTERNAL fee waived)
```

Escrow rather than immediate revenue is the load-bearing choice: it makes the server
non-custodial and *optional*. If it never issues a URL, the payer reclaims their MON after
`requestTtl` via `refund()`. A dead server delays uploads; it cannot strand funds.

The gateway is a separate deployable from the registry, discovered at runtime through
`Mnemonad.uploadGateway()`. The registry works fine with none wired — that path behaves
exactly as it did before the hook existed. Keeping them separate also means Pyth stays
swappable, which already mattered once: the MON/USD feed migrated off Pyth's beta contract,
which stopped serving it.

**Known gap:** Pinata accepts `maxFileSize` on a presigned URL and silently drops it
(verified — a URL minted for 1024 bytes accepted 2048 and pinned it). So a paid ceiling is
declared but not enforced; what bounds abuse is that each URL is single-use, short-lived,
and cost a real payment. See [`presign-server/README.md`](presign-server/README.md) for the
two ways to close it.

## Conventions

**Indentation is tabs, everywhere we author JS/TS/Vue.** That covers `js/` (the SDK and its
tests), `explorer/` (the Vue app), and any Node scripts under `contracts/` (deploy scripts,
tooling — not the Solidity itself, see below). This was a deliberate, repo-wide pass, not
an accident of whichever editor touched a file first — if you find a file in one of those
areas still on spaces, that's drift to fix, not a style to match.

**Solidity stays 4-space**, per the ecosystem's near-universal convention — the Solidity
style guide, `forge fmt`, `solhint`, and OpenZeppelin (which this project extends) all
default to 4-space. Converting `contracts/src/*.sol` and `contracts/test/*.sol` to tabs
would fight every Solidity tool's defaults for no real benefit, so it's the one deliberate
exception to "everywhere."

JSDoc comment continuation lines (` * ...`) inside tab-indented files keep a single literal
space before the `*`, matching the enclosing code's tab depth — e.g. a doc comment on a
method at one tab of indentation reads `\t * @param ...`, not `\t\t* @param ...`. This is
the standard JSDoc alignment convention, just expressed with a tab prefix instead of spaces.

Single quotes for strings, semicolons, in JS/TS/Vue — see any existing file in `js/` or
`explorer/` for the concrete style if in doubt.

## Status

Test MVP, **live on Monad testnet** (not mainnet). 113 Solidity + 330 SDK + 15 server +
31 monadsync tests passing. Current deployment is recorded in [`js/ids.js`](js/ids.js) — the deploy scripts
write it there, and the gateway address is read from the registry rather than recorded, so
the two cannot disagree.

Not yet audited, and encrypted streams still cannot be transferred (key rewrapping is
unimplemented), so treat mainnet as out of scope for now.
