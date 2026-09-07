# Upload method selection — what's forced, what's the SDK's call

Mnemonad has three storage tiers — SLOT, CODE, EXTERNAL — and routes a `push()` between
them today purely by **size**: does it fit in the packed-storage tier, does it fit in one
on-chain chunk, or does it not fit at all. That routing is deliberately incomplete. Some of
it is a hard boundary the contract enforces and can never be second-guessed; the rest is a
genuine cost trade-off the contract has no way to make correctly, and currently isn't made
at all. This is about which is which, and how big the gap actually is.

## What's forced by the contract

These are boundaries, not policy choices a caller can reason around — the contract reverts
if you try.

| Boundary | Value | Why it's forced |
|---|---|---|
| `SLOT_MAX_BYTES` | 31 bytes | Fixed EVM mechanics: at 32 bytes a Solidity `bytes` stops packing into one storage slot and cost roughly doubles in a single step. This crossover never moves, so hardcoding it is correct forever, not just today. |
| `MAX_CHUNK_BYTES_CEILING` | 65,536 bytes (64 KiB) | The largest `maxChunkBytes` a deployment may configure. Tightened from 131,071 (~128 KB, Monad's code-size cap) after a real incident — see [Why 64 KiB, not 128 KB](#why-64-kib-not-128-kb) below. |
| `maxChunkBytes` itself | ≤ the ceiling above, set at deploy | Anything bigger than this must go through the staged multi-transaction path or off-chain (EXTERNAL); `push()` reverts with `ChunkTooLarge` otherwise. |
| `externalFeeBytes` | `maxChunkBytes / 4` | The registry's flat EXTERNAL fee, in byte-equivalents. Fixed at deploy time along with `maxChunkBytes`, not something either the SDK or the contract can change per push. |

All four are deploy-time or EVM constants. None of them require knowing anything that
changes minute to minute — which is exactly what separates them from the next section.

## Why 64 KiB, not 128 KB

`DataChunk.write` deploys a chunk's bytes as contract code, measured live at **~221
gas/byte**. Monad's per-transaction gas cap is 30,000,000. The old ceiling (128 KB, chosen
because that's Monad's code-size limit) left almost no margin:

| Chunk size | Gas (at ~221/byte) | Headroom under the 30M cap |
|---|---|---|
| 120 KB (old ceiling) | ~27.2M | **~9%** |
| 97.1 KB (a real push, this session) | ~21.5M | ~40% — yet still failed |
| 64 KB (new ceiling) | ~14.5M | **~52%** |

The 97.1 KB push failed with `"Exceeds transaction gas limit"` despite simulating
comfortably under the cap — a connected wallet's own gas-estimation padding pushed the
*submitted* limit over 30M, even though the *real* cost had 40% headroom. At the old
ceiling's ~9% headroom, that failure mode was essentially guaranteed for any wallet that
pads its estimate at all. 64 KiB was chosen to survive that padding with real margin, not
merely to survive the exact estimate.

The SLOT/CODE crossover (31 bytes) could be hardcoded forever because it depends on nothing
but EVM mechanics. This crossover is different — it depends on Monad's per-transaction gas
cap staying at 30M and on `DataChunk`'s gas-per-byte cost staying near 221. Both are true
today; neither is a law of physics. If either changes materially, this ceiling is the
number to revisit.

## What isn't forced — the SDK's actual freedom

The contract's `push()` routing asks exactly one question: does this payload fit in
`maxChunkBytes`? If yes, CODE. If no, EXTERNAL (when configured) or staged on-chain. It
never asks whether a payload that *does* fit on-chain would be **cheaper** stored off-chain
instead. That second question is real, and today nothing answers it — `Mnemonad.js`'s
`push()` only reaches for IPFS when a payload doesn't fit on-chain at all; it never offloads
something smaller because that would save money.

### The gap is not theoretical — it's large, right now

Measured live against the deployed testnet registry and gateway:

```
feePerByte:            0          (dormant — not the live cost driver)
gas price:             102 gwei
CODE-tier cost:        ~221 gas/byte → 23.637 MON/MiB at current gas price
Gateway (IPFS) rate:   5¢/MiB → 1.920 MON/MiB (Pyth-priced, live)

CODE is 12.31× more expensive than IPFS per MiB, right now.
```

That ratio holds for payloads **comfortably under the new 64 KiB ceiling** — this isn't
about items too big to store on-chain, it's about items that fit easily but cost twelve
times more to put there than to offload. A 40 KB text blob, well inside the on-chain limit,
would cost roughly twelve times as much pushed as CODE as it would offloaded to IPFS at
today's gas price.

### Why the contract can't make this call

The SLOT/CODE crossover is safe to hardcode because it never changes. This one can't be,
for a concrete reason: it depends on the **gas price**, a live off-chain market value with
no oracle feeding it to the registry. The gateway separately consults Pyth for MON/USD to
price its own IPFS quote — a different variable, already the most external-data-dependent
part of this system — but nothing here tells the *registry* what gas costs right now, and
gas price is exactly what decides whether CODE or EXTERNAL is cheaper at any given moment.
A hardcoded threshold would be right by accident, for a while, and then silently wrong the
next time gas prices moved. This has to be a runtime decision, made by whoever can see both
sides of the trade — which today means the SDK, or whatever calls it.

### Why "always offload once it's cheaper" isn't a free lunch either

The 12× ratio makes offloading look like a strict improvement, but EXTERNAL carries real
costs CODE doesn't, which is exactly why this is a judgment call and not a threshold to
flip a switch on:

- **Three wallet prompts instead of one** — `payForUpload`, an EIP-712 signature, then
  `pushExternal` (see [`docs/testing/local-signer.md`](../testing/local-signer.md) for
  the full breakdown of that flow, and where it could shrink to two).
- **A liveness dependency.** CODE needs nothing but the chain. EXTERNAL needs a running
  presign server and a reachable Pinata — either being down makes the "cheaper" option
  simply unavailable, math notwithstanding.
- **Escrow and settlement complexity** — real, if well-contained, additional failure modes
  (refund windows, issuance limits) that a plain on-chain push never has to think about.
- **Pinata doesn't enforce the paid size ceiling** (see
  [`presign-server/README.md`](../../presign-server/README.md)'s known-gap section) — a
  pre-existing, unrelated gap, but one more reason EXTERNAL isn't simply "the cheap tier"
  with no asterisks.

### What this leaves unbuilt

Nothing currently computes the crossover or acts on it. A real implementation would need:

1. A live gas price (`publicClient.getGasPrice()` — the SDK already calls this elsewhere,
   e.g. `estimatePushCost`).
2. A live gateway quote (`MnemonadUploadGateway.weiPerMiB()`/`quote()` — already exists).
3. A CODE-tier cost estimate for the actual payload (`estimateContractGas` against the real
   size, or the ~221 gas/byte figure above as a fast approximation).
4. A comparison, respecting the caveats above — at minimum, don't silently offload if no
   presign server is configured, regardless of what the math says.
5. An explicit opt-in on `push()` (something like `{ preferCheaper: true }`), not a silent
   default change — offloading trades one prompt shape and one dependency for another, and
   that's a caller's choice to make, not one this class should make for them.

The `maxChunkBytes` field in `Mnemonad.js` now carries a comment flagging this gap
explicitly, so it's a documented absence rather than a silent one.

## Summary

| | Forced by the contract | The SDK's call |
|---|---|---|
| SLOT vs CODE (31 bytes) | ✅ fixed EVM mechanics, hardcoded correctly forever | — |
| Anything above `maxChunkBytes` | ✅ must go staged or EXTERNAL, contract-enforced | — |
| CODE vs EXTERNAL *below* `maxChunkBytes` | ❌ the contract has no opinion | ✅ this is the open question — currently unanswered, ~12× in cost right now |
