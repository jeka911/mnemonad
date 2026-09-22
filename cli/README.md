# mnemonad-cli

CLI tool to sync local folders to versioned, diffed on-chain streams on [Monad](https://monad.xyz).

Built on top of [`mnemonad`](../js) and [`monadsync`](../monadsync), which layers
content-defined-chunking folder diffing on top of a Mnemonad stream.

Each `push` stores a versioned, gzip-compressed diff or snapshot inside a Mnemonad stream
on-chain (with large files optionally offloaded to IPFS via Pinata). Any past version can be
restored at any time with `pull`. Streams can optionally be encrypted with a password or the
signer's own wallet key.

## Installation

### From npm (recommended)

```bash
npm install -g mnemonad-cli
mnemonad --help
```

To pick up a new release later:

```bash
npm update -g mnemonad-cli
```

### From this repo (for development)

This package lives in the monorepo alongside `mnemonad` and `monadsync`, linked through a
pnpm workspace at the repo root. From the repo root:

```bash
cd cli
pnpm install
node bin/mnemonad.js --help
```

Or link it for a global `mnemonad` command that tracks your local checkout:

```bash
cd cli
pnpm install
npm link
mnemonad --help
```

`sample/` holds example content (pulled from a stream created via the dApp) used to try the
CLI out. `pnpm push-sample` pushes it to testnet as a brand-new stream:

```bash
export MNEMONAD_KEY=0xabc123...
pnpm push-sample
```

## Usage

```
mnemonad push [stream-id] <path> [options]     Sync a folder to a stream (creates one if no id given)
mnemonad pull <stream-id> <path> [options]     Restore stream contents to a folder
mnemonad info [stream-id] [path] [options]     Show chain/wallet info, or full stream metadata
mnemonad diff <stream-id> <path> [options]     List files added/modified/deleted locally vs the on-chain version
mnemonad watch <stream-id> <path> [options]    Watch folder: auto-push on changes, auto-pull on remote updates
mnemonad compact <stream-id> <path> [options]  Truncate old history and push folder as a fresh snapshot
```

`<path>` is always required for any command that touches a folder — there is no need to
`cd` into the folder first, but there's also no falling back to the current working
directory: an omitted or mistyped path fails fast with an error rather than silently
operating on wherever the CLI happened to be run from. The only command that can run with
no path at all is `mnemonad info` with no stream id either (it just checks your configured
chain/wallet). A stream id is recognized as a bare decimal number (`123`) or a
`0x`-prefixed hex string; anything else in that position is treated as a path.

Every command prints the installed CLI version as its first line of output.

### Options

| Flag | Description |
|---|---|
| `--chain <name>` | Chain: `testnet`, `mainnet`, `local` (default: `testnet`) |
| `--rpc-url <url>` | Override the resolved RPC endpoint (e.g. a local Hardhat node) |
| `--contract-address <addr>` | Registry address to use instead of the chain's known deployment (required with `--chain local`) |
| `--gateway-url <url>` | IPFS gateway for reading externally-offloaded items (default: `https://gateway.pinata.cloud/ipfs/`, or `MNEMONAD_IPFS_GATEWAY` env var) |
| `--key <privkey>` | Monad private key (or set `MNEMONAD_KEY` env var) |
| `--phrase <mnemonic>` | Mnemonic phrase instead of a raw key |
| `--version <n>` | Version to restore or compare against (`pull`, `diff`, `info`; default: latest) |
| `--exclude <p1,p2>` | Extra exclude patterns (comma-separated) |
| `--no-compress` | Disable gzip compression |
| `--encrypt` | Create a new stream encrypted. Only applies when creating; ignored for existing streams |
| `--encrypt-with <method>` | How to key it: `password` (needs `--password`), or `wallet` — the `--key`/`--phrase` account signs for it, and only that account can ever decrypt it. Implied by `--password` |
| `--password <pw>` | Password to encrypt a new stream with, or decrypt an existing one |
| `--pinata-jwt <jwt>` | Pinata JWT for IPFS offload of large files (or `PINATA_JWT` env var) |
| `--manifest` | Write/use `.mnemonad` manifest for faster change detection |
| `--force-snapshot` | Push a full snapshot regardless of prior history (repairs a corrupt stream) |
| `--poll-interval <s>` | `watch`: seconds between remote version checks (default: `2`) |
| `--debounce <ms>` | `watch`: quiet period in ms before pushing after a local change (default: `1000`) |
| `--push-only` | `watch`: disable auto-pull |
| `--pull-only` | `watch`: disable auto-push |
| `--help` | Show help |

### Authentication

Pass the signing key inline:

```bash
mnemonad push ~/my-data --key 0xabc123...
```

Or export it once and drop the flag from every command:

```bash
export MNEMONAD_KEY=0xabc123...
mnemonad push ~/my-data
```

A mnemonic works instead of a raw key: `--phrase "word1 word2 ..."`. `--key` and
`MNEMONAD_KEY` both take precedence over `--phrase`.

`pull`, `info` and `diff` work without a key for public (unencrypted) streams. A key is
required for encrypted streams that use wallet-based encryption (not needed for
password-based encryption — see below), and for any `push`.

## Examples

The examples below assume the key comes from `MNEMONAD_KEY` and use the default `testnet`
chain.

### Push a folder (first time)

```bash
mnemonad push ~/my-data

# prints the new stream id, e.g.:
#   created: 123
#   version 1 pushed (full snapshot, gzip compressed)
```

By default a new stream is public (unencrypted). Encrypting one takes a method — the CLI
never picks for you, since both are reachable from the same invocation:

```bash
# Keyed by a password: anyone who knows it can read the stream, from any machine.
mnemonad push ~/my-data --encrypt --password "correct horse battery staple"

# Keyed by the signing account itself: no password to remember or leak, but ONLY this
# account can ever decrypt it, and there is no recovery if the key is lost.
mnemonad push ~/my-data --encrypt --encrypt-with wallet
```

Reading one back needs whichever credential it was keyed with — `--password` for the first,
just the owner's `--key`/`--phrase` for the second. `mnemonad info` reports which:
`encrypted: yes (password)` or `encrypted: yes (owner wallet)`.

### Push an update

```bash
mnemonad push 123 ~/my-data

# same stream on mainnet
mnemonad push 123 ~/my-data --chain mainnet
```

### Pull the latest version

```bash
mnemonad pull 123 ~/restored
```

### Pull a specific version

```bash
mnemonad pull 123 ~/restored --version 1
```

### Inspect a stream

```bash
# check your wallet + chain (no stream id needed)
mnemonad info

# full stream metadata + local sync status
mnemonad info 123 ~/my-data
```

```
  chain:           testnet
  your wallet:     0x06bc6420b37a4898424429dcfa236f0065e12279

stream: 123
  owner:           0x06bc6420b37a4898424429dcfa236f0065e12279 (you)
  encrypted:       no
  versions:        3
  binary size:     385.7 KB

  local tree hash: 9f2c1a4b8e...
  detecting local version...
  local matches:   version 3 of 3
  status:          up to date
```

### See what changed locally (diff)

```bash
# list files added/modified/deleted locally compared to the latest on-chain version
mnemonad diff 123 ~/my-data

# compare against a specific version
mnemonad diff 123 ~/my-data --version 2
```

Output shows the changes from the local folder's perspective — what a `push` would apply:

```
diff: ~/my-data vs 123 (version 3 of 3)
local changes vs chain (what push would apply):
  added:      docs/new-page.md
  modified:   src/index.js
  deleted:    old-config.json

  3 change(s): 1 added, 1 modified, 1 deleted
```

### Fast incremental pushes with a manifest

```bash
mnemonad push 123 ~/my-data --manifest
# subsequent pushes are skipped when nothing has changed locally
```

### Watch a folder (auto push + pull)

```bash
mnemonad watch 123 ~/my-data
# pushes local changes 1 s after the last edit
# pulls remote updates every 2 s
# Ctrl-C to stop
```

Tune the timing:

```bash
mnemonad watch 123 ~/my-data --debounce 3000 --poll-interval 5
```

Watch in push-only or pull-only mode:

```bash
mnemonad watch 123 ~/my-data --push-only   # no auto-pull
mnemonad watch 123 ~/my-data --pull-only   # no auto-push (read-only mirror)
```

### Compact old history

After many incremental syncs, drop old history and push the current folder as a fresh
single snapshot. This speeds up future `pull`/`info`/`diff` (they replay less history to
reach the latest version) — Monad storage is not refundable, so this is not a cost rebate,
just a faster-replay optimization.

```bash
mnemonad compact 123 ~/my-data
```

### Repair a corrupt stream with a force snapshot

If a diff patch was pushed against a stale base (e.g. a race condition in `watch`),
subsequent pulls will fail. Fix it by pushing a new full snapshot:

```bash
mnemonad push 123 ~/my-data --force-snapshot
# skips chain replay and pushes the current folder as a self-contained full snapshot
# restore() will recover from this snapshot, skipping any corrupt diffs before it
```

## End-to-end workflow

Create a stream, verify what was stored, then roll back to an earlier version:

```bash
export MNEMONAD_KEY=0xabc123...

# 1. first push — creates the stream
mnemonad push ~/my-data
#   created: 123
#   version 1 pushed (full snapshot, gzip compressed)

# 2. verify: restore into a scratch folder and compare against the original
mnemonad pull 123 ~/verify-tmp
diff -r ~/my-data ~/verify-tmp

# 3. change something and push again
echo "hello" > ~/my-data/new.txt
mnemonad push 123 ~/my-data
#   version 2 pushed (diff, gzip compressed)

# 4. review the history
mnemonad info 123 ~/my-data
#   versions:        2
#   local matches:   version 2 of 2

# 5. roll back: restore version 1 into a separate folder
mnemonad pull 123 ~/my-data-v1 --version 1
```

## How it works

1. **push** — scans the current directory, computes a tree hash, and compares it against the
   last stored version. If changes are detected, a compressed diff (or full snapshot on the
   first push) is uploaded on-chain (large items offloaded to IPFS when `--pinata-jwt` is
   set).
2. **pull** — reads the requested version from the stream (fetching any externally-offloaded
   items through `--gateway-url`), decrypts it if encrypted, and writes only changed files to
   disk. Files absent from the stored version are deleted.
3. **info** — reads stream metadata from the chain (version count, binary size, owner) and
   checks whether the local folder matches any stored version.
4. **diff** — restores the requested version in memory (nothing is written to disk), hashes
   every file on both sides, and lists files added, modified, or deleted locally compared to
   the on-chain version.
5. **watch** — combines push and pull in a loop. A filesystem watcher triggers a debounced
   push on local changes. A poll interval checks the remote stream for new versions and
   pulls them if found. Push and pull never run concurrently. Monad's registry has no
   "expected prior length" guard on push, so `watch` re-checks the remote length itself
   right before pushing and resyncs if it has moved — a best-effort narrowing of the race
   window, not a hard guarantee.
6. **compact** — drops all existing history on-chain and pushes the current folder as a
   single fresh full snapshot, speeding up future replay after many incremental syncs.

### Default excludes

The following are always excluded from snapshots: `node_modules`, `.git`, `.env`,
`.DS_Store`, `.mnemonad`, `.claude`, `pnpm-lock.yaml`, `package-lock.json`. Add more with
`--exclude`.

## Dependencies

| Package | Role |
|---|---|
| `mnemonad` | On-chain stream primitive (this repo's `js/`) |
| `monadsync` | Folder-diff / snapshot layer on top of `mnemonad` (this repo's `monadsync/`) |
| `viem` | Monad client / key management |
