# Mnemonad — Monad contracts

Solidity implementation of Mnemonad for Monad. See the root [`README.md`](../README.md) for
how the contracts, SDK, explorer and presign server fit together.

Status: **live on Monad testnet**, not mainnet. Registry v2 at
`0x51f0b9ec54f6c533ba3d9ecb78cca7c502104e05`, `MnemonadUploadGateway` at
`0x479B04c301EcB6Ec2a039F845a919232E0E3Ac6d` (recorded in [`../js/ids.js`](../js/ids.js);
the gateway address is read from the registry rather than recorded, so the two cannot
disagree). 113 unit tests passing.

## Layout

| Path | Purpose |
|---|---|
| `src/Mnemonad.sol` | The registry. One contract holds all streams; each stream is an ERC-721 token. |
| `src/DataChunk.sol` | SSTORE2-style library: stores bytes as non-callable contract code. |
| `src/MnemonadUploadGateway.sol` | Sells off-chain pinning quota for MON, priced in USD via Pyth. Separate deployable — see below. |
| `src/IMnemonadUploadGateway.sol` | The single call the registry makes into a gateway. |
| `src/IPyth.sol` | Vendored slice of Pyth's EVM interface (4 functions, one struct). |
| `test/Mnemonad.t.sol` | Registry behavioural tests (57). |
| `test/MnemonadUploadGateway.t.sol` | Gateway + settlement-integration tests (50). |
| `test/Gas.t.sol` | Cost-model assertions (6) — the design's claims, made executable. |
| `test/lib/EvTest.sol` | Minimal local test base (cheatcode interface + assertions). |

## Commands

```bash
pnpm test
```

```bash
pnpm build
```

`pnpm test` leaks one EDR node process per run, which do not exit on their own. They
accumulate at roughly 240 MB each, so clean up after a long session:

```bash
pkill -f "hardhat/dist/src/cli.js node --port"
```

## Two contracts, deliberately

The paid-upload gateway is a **separate deployable**, not part of the registry, for three
reasons that all still hold:

- **Code size.** The registry sits at **23,396 of EIP-170's 24,576 bytes** — 1,180 spare.
  The gateway compiles to 7,158, so it never fit. Pushing the registry over the limit would
  make it undeployable on the local test node, costing the whole Solidity suite.
- **Pyth is a moving dependency.** Its `pyth` address and `priceFeedId` are settable on the
  gateway. That already mattered: the MON/USD feed migrated off Pyth's beta contract, which
  stopped serving it. Hard-wiring a moving oracle into an immutable data registry is the one
  mistake that cannot be walked back.
- **Blast radius.** A gateway accounting bug cannot touch `_items`/`_pointers` or drain the
  registry's own `feesAccrued`.

The registry's side is one owner-settable `uploadGateway` address and a `try/catch` call in
`pushExternal`: a matching prepaid escrow waives the `EXTERNAL` fee, and a reverting or
absent gateway degrades to charging normally rather than bricking every external push.

## Two environment caveats that shape the tests

**1. Code size.** The local EDR node enforces EIP-170's 24,576-byte limit and exposes no
`allowUnlimitedContractSize` for Solidity tests. Monad allows 128 KB. Consequences:

- `maxChunkBytes` is a **constructor immutable**, not a constant — tests instantiate it at
  20,000 so the boundary logic is exercisable. Bounded by `MAX_CHUNK_BYTES_CEILING`
  (64 KiB as of this writing — see that constant's own doc comment for why it's well under
  Monad's 128 KB code-size cap: the *gas* cost of a chunk that large binds before the code
  size does). The deployed testnet registry runs at that ceiling, 65,536.
- The registry is compiled with `optimizer.runs = 200` to stay under 24 KB and remain
  unit-testable. Monad's headroom would permit far more aggressive inlining.
- **The single-chunk CODE path near the ceiling cannot be tested locally at all** — it needs
  more code-size headroom than the local EDR node allows. Testnet-only verification.

**2. Gas schedule.** Local EDR prices storage the Ethereum way (22,100 for a cold new slot,
EIP-2929 cold access, quadratic memory). Monad uses MIP-8 — 4 KB pages of 128 slots — plus
its own cold-access and memory prices, so the local suite's absolute numbers are
**Ethereum numbers**. What carries over is the direction of each comparison, which is all
`Gas.t.sol` asserts. Monad's own numbers are measured on testnet, below.

## Measured on Monad testnet

From [`scripts/bench_gas.js`](../scripts/bench_gas.js), which measures exact gas with
metered `eth_call`s against the live registry — no transactions, no key. Full report, with
the method and every row: [`docs/gas.md`](../docs/gas.md).

The schedule, as the registry experiences it:

| Operation | Monad | Ethereum |
|---|---:|---:|
| Read a slot on a cold page / a page already loaded | 8,100 / 100 | 2,100 / 100 |
| New slot on a cold page / a page already written this tx | 27,900 / 17,100 | 22,100 |
| Modify a slot on a cold page | 10,900 | 5,000 |
| Cold account access (each chunk a read touches) | 10,100 | 2,600 |
| `CREATE` / code deposit | 32,000 / 200 per byte | same |
| Memory, 0 → 64 KB | 1,024 | 14,336 |

Page warmth lasts one transaction. A new slot on a page that already holds data still costs
27,900 if nothing in the transaction loaded that page, so separate transactions never share
a page charge — only batches do.

What that means for the registry:

| Measurement | Result | Reading |
|---|---|---|
| 31 B via SLOT vs 32 B via CODE (into a fresh stream) | 89,366 vs 99,946 gas | `SLOT_MAX_BYTES = 31` is the right cutoff: SLOT at 32 B would need a second slot on a second page (~117,000), and CODE at 1 B would still cost ~93,700. |
| CODE tier per byte, 1 KB → 64 KB | 292 → **202** gas/byte | Plus 16/byte calldata: a 64 KB chunk is 14.3M gas as a transaction, under half the 30M cap. |
| `push` into an existing stream: 1 B / 1 KB / 24 KB | 122,984 / 348,608 / 5,445,040 tx gas | A lone push pays every page it touches cold, ~11,000 more than the same item in `create()`. |
| 10 × 200 B: separate pushes vs `pushMany` | ~1,704,000 → **760,781** tx gas | Packing saves 55%: one `CREATE` and one set of cold pages instead of ten. |
| `pushExternal` (Item + Pointer) | 225,610 tx gas | Flat regardless of payload size: only a CID and a hash are stored. |
| `at()` on one chunk: 391 B / 25 KB / 59 KB | 44,900 / 50,360 / 57,794 gas | ~42,000 of cold page and account loads, then ~0.25 gas/byte. Not paid, but metered against the `eth_call` cap. |
| `at()` on 512 KB (8 chunks) | ~298,000 gas (estimated cold) | ~0.6 gas/byte; each extra chunk adds a 10,000 cold account access. |
| `concat` 4 items × 100 B vs 4 × 5,000 B (pages warm) | 231,004 vs **231,004** gas | Identical. 50× the payload, zero cost difference — payloads are re-linked, never copied. |

`Gas.t.sol` logs the same comparisons under the Ethereum schedule when you run `pnpm test`.

## Known gaps

- Key rewrapping (`registerPublicKey`, `proposeTransferWithRewrap`, `acceptTransfer`) is not
  implemented. Encrypted streams are currently non-transferable, full stop. This must exist
  before mainnet.
- `concat` is O(source item count). An O(1) segment-list design is possible but changes the
  storage layout.
- The gateway's staleness bounds are **deliberately loose for testnet**: `maxPriceAge` is
  60 days, because nothing keeps MON/USD warm on Monad testnet (a live read came back ~27
  days old). A price that old is worthless for pricing real money — mainnet must set
  seconds. `test_stalenessDefaultIsTestnetLoose` fails on purpose when this is tightened.
- No external audit.
