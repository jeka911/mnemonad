# Mnemonad — Monad contracts

Solidity implementation of Mnemonad for Monad. See the root [`README.md`](../README.md) for the
full design rationale.

Status: **test MVP.** Core contract complete and unit-tested; not deployed anywhere.

## Layout

| Path | Purpose |
|---|---|
| `src/Mnemonad.sol` | The registry. One contract holds all vectors; each vector is an ERC-721 token. |
| `src/DataChunk.sol` | SSTORE2-style library: stores bytes as non-callable contract code. |
| `test/Mnemonad.t.sol` | Behavioural unit tests (57). |
| `test/Gas.t.sol` | Cost-model assertions (6) — the plan's claims, made executable. |
| `test/lib/EvTest.sol` | Minimal local test base (cheatcode interface + assertions). |

## Commands

```bash
pnpm test
```

```bash
pnpm build
```

## Two environment caveats that shape the tests

**1. Code size.** The local EDR node enforces EIP-170's 24,576-byte limit and exposes no
`allowUnlimitedContractSize` for Solidity tests. Monad allows 128 KB. Consequences:

- `maxChunkBytes` is a **constructor immutable**, not a constant — tests instantiate it at
  20,000 so the boundary logic is exercisable; Monad would deploy at ~122,880.
- The registry is compiled with `optimizer.runs = 200` to stay under 24 KB and remain
  unit-testable. Monad's headroom would permit far more aggressive inlining.
- **The ~120 KB single-chunk path cannot be tested locally at all.** It is a testnet-only
  verification.

**2. Gas schedule.** Local EDR prices storage the Ethereum way (20,000 per new slot,
EIP-2929 cold access). Monad uses MIP-8: 4 KB/128-slot pages, 8,000 per cold page + 2,800
per page write + 17,000 per net-new slot, and possibly a repriced `CREATE`. So absolute
numbers from `Gas.t.sol` are **Ethereum numbers** and must not be quoted as Monad costs.
What carries over is the direction of each comparison.

## Measured (local, Ethereum schedule)

| Measurement | Result | Reading |
|---|---|---|
| `concat` 4 items × 100 B vs 4 × 5,000 B | 159,310 vs **159,310** gas | Identical to the gas. 50× the payload, zero cost difference — payloads are re-linked, never copied. |
| 10 × 200 B: individual vs packed | 1,048,092 → **729,986** gas | Packing saves 30%; the CREATE overhead per chunk is the thing being amortised. |
| CODE tier per-byte, 1 KB → 10 KB | 286 → **209** gas/byte | Converging on the predicted ~216 gas/byte (200 deploy + 16 calldata). |
| 31 B via SLOT vs 32 B via CODE | 76,072 vs 90,570 gas | Same cost band at the boundary. Does **not** confirm 31 as the exact crossover — see below. |

## Known gaps

- `SLOT_MAX_BYTES = 31` is derived from Monad's page model, which the local node does not
  implement. The exact crossover is a Phase 0 measurement, not a settled constant.
- Key rewrapping (`registerPublicKey`, `proposeTransferWithRewrap`, `acceptTransfer`) is not
  implemented. Encrypted vectors are currently non-transferable, full stop. This must exist
  before mainnet.
- `concat` is O(source item count). An O(1) segment-list design is possible but changes the
  storage layout.
- No deploy script, no JS SDK yet.
