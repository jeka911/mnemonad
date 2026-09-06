# mnemonad-presign-server

Issues Pinata presigned upload URLs against paid on-chain escrow, so a browser never needs
a Pinata credential of its own.

```
client                     this server                  chain
  │                                                       │
  ├─ gateway.payForUpload(contentHash, maxSize) ──────────►│  escrow
  │                                                       │
  ├─ POST /upload-url  {payer, contentHash, size,          │
  │                     deadline, signature}  ────────────►│  reads escrow
  │◄─ { url, expiresAt, maxFileSize } ─────────────────────┤
  │                                                       │
  ├─ POST <url>  (bytes) ──────► Pinata                    │
  │                                                       │
  └─ mnemonad.pushExternal(Pointer{hash,…}) ──────────────►│  settles escrow,
                                                           │  waives EXTERNAL fee
```

## Why it exists

An off-chain item's bytes never touch the chain, so something has to pay a pinning service
to hold them. Handing a Pinata credential to a browser means every visitor can upload
without limit on your account. This service holds the credential instead, and only hands
out an upload URL to someone who has demonstrably paid.

## Running

```bash
cp .env.example .env      # set PINATA_JWT
pnpm install
pnpm start
```

It refuses to start if `PINATA_JWT` is missing, if the RPC is unreachable, or if the
registry has no gateway wired — a server that accepts requests it cannot fulfil is worse
than one that says why it won't start.

`REGISTRY_ADDRESS` normally needs no value: it defaults to whatever `mnemonad`'s `ids.js`
records for `CHAIN_ID`.

### Deploying

`mnemonad` is depended on as `link:../js`, which symlinks the sibling package rather than
fetching it — and pnpm does not install a linked package's own dependencies. Locally that
goes unnoticed because `js/` has been installed for its test suite. A host that installs
only this directory ships `../js` without a `node_modules` beside it, and the first import
of the SDK dies with `Cannot find package '@noble/hashes' imported from .../js/Mnemonad.js`.

`vercel.json` therefore extends the install step to cover the SDK too:

```bash
pnpm install && pnpm --dir ../js install --frozen-lockfile --ignore-scripts
```

The SDK's dev dependencies are installed along with the rest because `viem` is a *peer*
dependency there — the SDK imports it at runtime, but a linked package gets no peers
resolved for it. `--ignore-scripts` keeps the install from failing over build scripts
(`esbuild`, pulled in by `vitest`) that nothing here needs to run.

Any other host needs the same treatment, or `js/` published to a registry so it can be
depended on by version instead of by path.

## Endpoints

| | |
|---|---|
| `POST /upload-url` | Trades a proven, paid escrow for an upload URL |
| `GET /health` | Liveness — includes chain reachability and gateway resolution |
| `GET /config` | Public config, including the EIP-712 domain clients must sign |

`/config` publishes the exact EIP-712 domain and types, so a client signs what this server
verifies instead of both sides hardcoding a copy that can drift.

## The gates on `POST /upload-url`

1. **Schema** — a malformed hash or out-of-range size is rejected before any I/O.
2. **Signature** — EIP-712, recovered and matched against `payer`. `requestId` is public in
   `UploadPaid` events, so without this it would be a bearer token: anyone watching the
   chain could claim the URL that someone else's payment bought. Domain-separated by chainId
   *and* gateway address, so a signature can't be replayed across networks or against a
   redeployed gateway. `deadline` bounds a leaked signature's useful life.
3. **Escrow** — read from the contract, never trusted from the request body.
4. **Size** — refuses a request above what the escrow covers.
5. **Expiry** — the URL must die before the escrow does. Past the escrow's expiry the payer
   can `refund()`, so a URL that outlived it would let them reclaim their MON *and* still
   upload. The TTL is shrunk to fit, and refused outright if it can't.
6. **Issuance limit** — a still-valid URL is returned as-is for a retry (a dropped response
   shouldn't burn an attempt); beyond `MAX_ISSUES_PER_REQUEST` it refuses. A failed Pinata
   call releases the claim, since the payer did nothing wrong.

## Properties worth keeping

**No blockchain key.** This service only reads chain state and calls Pinata. Settlement
happens in the *user's* own `pushExternal`. A compromise here leaks upload capacity on your
Pinata account — never funds. Don't add a signer.

**Double-issuance can't cost money.** `consumeUpload` deletes the on-chain request on
settlement, so no number of leaked URLs can produce a second fee waiver. That's why the
issuance ledger is an append-only JSON-lines file rather than a database: it protects
storage, not funds, at a volume of one row per paid upload. If issuance volume ever
justifies indexes, `src/store.js` is the seam.

## Known limitation: `maxFileSize` is not enforced

Pinata's sign endpoint accepts `maxFileSize` and **silently drops it**. Verified against the
live API: a URL minted with `maxFileSize: 1024` accepted a 2048-byte upload with HTTP 200
and pinned it. Options Pinata *does* honour appear in the signed URL as `X-Upload-Option-*`
params; no size param ever appears.

So an issued URL is single-use (a second POST returns 409 `duplicate file id`), short-lived,
scoped to one file, and only obtainable by proving payment — but it does **not** cap bytes.
A payer for 124 KB can upload more. Abuse is therefore *priced and rate-limited* rather than
prevented: each attempt costs a real payment.

Two ways to close it properly, neither implemented:

- **Proxy the upload** — the client POSTs to this server, which counts bytes as they stream
  and aborts past the paid ceiling (`@fastify/multipart` has a hard `limits.fileSize`), then
  forwards to Pinata. Airtight, at the cost of routing payload bandwidth through here.
- **Reconcile after the fact** — compare each pinned file's real size against its escrow
  (the `requestId` is stored in the file's keyvalues for exactly this) and unpin overages.
  Reactive, but keeps uploads direct.

## Tests

```bash
pnpm test
```

Chain and Pinata are injected as stubs, because what's worth testing here is the decision
logic — not viem's or Pinata's behaviour. The full path has separately been exercised
against live Monad testnet and the real Pinata API.
