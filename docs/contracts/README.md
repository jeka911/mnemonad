# Mnemonad — Monad contracts

Solidity implementation of Mnemonad for Monad. See the root [`README.md`](../../README.md) for
how the contracts, SDK, explorer and presign server fit together.

Status: **live on Monad testnet**, not mainnet. Registry v2 at
`0x51f0b9ec54f6c533ba3d9ecb78cca7c502104e05`, `MnemonadUploadGateway` at
`0x479B04c301EcB6Ec2a039F845a919232E0E3Ac6d` (recorded in [`../js/ids.js`](../../js/ids.js);
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
  size does). **The currently-deployed testnet registry predates this ceiling and is still
  running at 122,880** — the tightened value only takes effect on the next deploy.
- The registry is compiled with `optimizer.runs = 200` to stay under 24 KB and remain
  unit-testable. Monad's headroom would permit far more aggressive inlining.
- **The single-chunk CODE path near the ceiling cannot be tested locally at all** — it needs
  more code-size headroom than the local EDR node allows. Testnet-only verification.

**2. Gas schedule.** Local EDR prices storage the Ethereum way (20,000 per new slot,
EIP-2929 cold access). Monad uses MIP-8: 4 KB/128-slot pages, 8,000 per cold page + 2,800
per page write + 17,000 per net-new slot, and possibly a repriced `CREATE`. So absolute
numbers below are **Ethereum numbers** and must not be quoted as Monad costs. What carries
over is the direction of each comparison.

## Measured (local, Ethereum schedule)

Re-measured from `Gas.t.sol`'s own output. The assertions in that file are *relational*
(cheaper-than, within-20%-of), not exact-value — so these figures are a snapshot that can
drift as the contracts change, while the readings hold.

| Measurement | Result | Reading |
|---|---|---|
| `concat` 4 items × 100 B vs 4 × 5,000 B | 162,668 vs **162,668** gas | Identical to the gas. 50× the payload, zero cost difference — payloads are re-linked, never copied. |
| 10 × 200 B: individual vs packed | 1,047,452 → **729,986** gas | Packing saves 30%; the per-chunk `CREATE` overhead is what's amortised. |
| CODE tier per-byte, 1 KB → 10 KB | 286 → **209** gas/byte | Converging on the predicted ~216 gas/byte (200 deploy + 16 calldata). |
| 31 B via SLOT vs 32 B via CODE | 76,008 vs 90,506 gas | Same cost band at the boundary. Does **not** confirm 31 as the exact crossover — see below. |
| `pushExternal` (Item + Pointer) | 123,785 gas | Flat regardless of payload size: only a CID and a hash are stored. |

## Known gaps

- `SLOT_MAX_BYTES = 31` is derived from Monad's page model, which the local node does not
  implement. The exact crossover is an unconfirmed measurement, not a settled constant.
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
