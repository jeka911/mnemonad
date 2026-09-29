# mnemonad-cli

CLI tool to sync local folders to versioned, diffed on-chain streams on [Monad](https://monad.xyz).

Built on top of [`mnemonad`](../js/README.md) and [`monadsync`](../monadsync/README.md), which layers
content-defined-chunking folder diffing on top of a Mnemonad stream.

Each `push` stores a versioned, gzip-compressed diff or snapshot inside a Mnemonad stream
on-chain (with large files optionally offloaded to IPFS via Pinata). Any past version can be
restored at any time with `pull`. Streams can optionally be encrypted with a password or the
signer's own wallet key.

## Installation

### From npm (recommended)

```bash
npm install -g mnemonad-cli@latest
mnemonad --help
```

To pick up a new release later, prefer reinstalling `@latest` over `npm update -g` — `update`
has known quirks where it doesn't reliably bump an already-installed global package even when
a newer version is published:

```bash
npm install -g mnemonad-cli@latest
mnemonad --help    # banner shows the version — confirm it actually moved
```

If it still reports the old version, you likely have two installs shadowing each other on
`PATH` (common with nvm, after switching Node versions):

```bash
which mnemonad
npm ls -g mnemonad-cli
```

If `which mnemonad` doesn't resolve into the `npm root -g` you just installed into, remove
the stale one — `npm uninstall -g mnemonad-cli`, then reinstall.

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
mnemonad burn <stream-id> --yes [options]      Permanently destroy a stream — irreversible
mnemonad index <path> [options]                Build/update a local vector-search index (optional)
mnemonad search <path> <query> [options]       Search a folder's vector index
```

`<path>` is always required for any command that touches a folder — there is no need to
`cd` into the folder first, but there's also no falling back to the current working
directory: an omitted or mistyped path fails fast with an error rather than silently
operating on wherever the CLI happened to be run from. The commands that can run with no
path at all are `mnemonad info` with no stream id either (it just checks your configured
chain/wallet) and `mnemonad burn`, which never takes one. A stream id is recognized as a
bare decimal number (`123`), a
`0x`-prefixed hex string, or the network-qualified form the
[explorer dApp](https://mnemonad.vercel.app)'s own URLs use —
`testnet-0x648f18…` — pasted straight out of a `/stream/<id>` link. That form also sets
`--chain` to match; pass `--chain` too only if it agrees, or the command refuses rather than
guess which one you meant. Every command's own output always prints the bare id in hex
(`0x` + the full 32-byte token id), matching the explorer's own display.

Every command prints the installed CLI version as its first line of output.

### Options

| Flag | Description |
|---|---|
| `--chain <name>` | Chain: `testnet`, `mainnet`, `local` (default: `testnet`) |
| `--rpc-url <url>` | Override the resolved RPC endpoint (e.g. a local Hardhat node) |
| `--contract-address <addr>` | Registry address to use instead of the chain's known deployment (required with `--chain local`) |
| `--gateway-url <url>` | IPFS gateway for reading externally-offloaded items (default: this project's Pinata dedicated gateway, or `MNEMONAD_IPFS_GATEWAY` env var) |
| `--key <privkey>` | Monad private key (or set `MNEMONAD_KEY` env var) |
| `--phrase <mnemonic>` | Mnemonic phrase instead of a raw key |
| `--passkey` | Sign with a passkey instead: opens the explorer in your browser to sign in with WebAuthn, then relays signing requests to that tab for this command. Interactive only — not for scripts/CI. Cannot be combined with `--key`/`--phrase` |
| `--auth-origin <url>` | Explorer deployment `--passkey` opens (default: this project's explorer deployment, or `MNEMONAD_AUTH_ORIGIN` env var) |
| `--version <n>` | Version to restore or compare against (`pull`, `diff`, `info`; default: latest) |
| `--exclude <p1,p2>` | Extra exclude patterns (comma-separated) |
| `--no-compress` | Disable gzip compression |
| `--encrypt` | Create a new stream encrypted. Only applies when creating; ignored for existing streams |
| `--encrypt-with <method>` | How to key it: `password` (needs `--password`), or `wallet` — the `--key`/`--phrase` account signs for it, and only that account can ever decrypt it. Implied by `--password` |
| `--password <pw>` | Password to encrypt a new stream with, or decrypt an existing one |
| `--pinata-jwt <jwt>` | Pinata JWT for IPFS offload of large files (or `PINATA_JWT` env var) |
| `--manifest` | Write/use `.mnemonad` manifest for faster change detection. With no stream-id given, every command recovers it from an existing `.mnemonad` in the folder instead of requiring it explicitly |
| `--force-snapshot` | Push a full snapshot regardless of prior history (repairs a corrupt stream) |
| `--index` | `push`/`watch`: update the folder's search index before every push (takes `--db`/`--model`/`--chunk-size`/`--chunk-overlap`); if indexing fails, nothing is pushed |
| `--poll-interval <s>` | `watch`: seconds between remote version checks (default: `2`) |
| `--debounce <ms>` | `watch`: quiet period in ms before pushing after a local change (default: `1000`) |
| `--push-only` | `watch`: disable auto-pull |
| `--pull-only` | `watch`: disable auto-push |
| `--yes` | Required by `burn` — explicit opt-in for an irreversible action, never assumed |
| `--db <name>` | `index`/`search`: vector-index filename (default: `search_index.db`) |
| `--model <name>` | `index` / `--index`: embedding model — `potion` (built in, the default for a new index) or `minilm` (needs `npm install -g mnemonad-search-transformers`), or a full model id. Without it, an existing index keeps its own model; `search` always uses the index's model |
| `--rebuild` | `index` / `--index`: start the index over — the way to switch models (the next push uploads the whole index again) |
| `--chunk-size <n>` | `index`: target characters per chunk (default: `1000`) |
| `--chunk-overlap <n>` | `index`: characters of overlap between chunks (default: `150`) |
| `--limit <n>`, `-k <n>` | `search`: number of results (default: `5`) |
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

Or sign in with a passkey instead of any key at all:

```bash
mnemonad push ~/my-data --passkey
```

This opens the explorer's `/cli-auth` page in your default browser to complete a WebAuthn
sign-in — no key ever touches this machine's disk or environment, only signatures relayed
back for the duration of that one command. It needs a passkey already registered through the
explorer (`--passkey` only signs in, it doesn't create one), a browser to complete the
prompt in, and someone available to click through it — so it's a good fit for a human running
a command by hand, not for scripts or CI (use `--key`/`MNEMONAD_KEY` there instead). See
[`docs/wallet/passkey-accounts.md`](../wallet/passkey-accounts.md) for how the account
is derived and what this flow does and doesn't send anywhere.

`pull`, `info` and `diff` work without a key for public (unencrypted) streams. A key is
required for encrypted streams that use wallet-based encryption (not needed for
password-based encryption — see below), and for any `push`.

## Examples

The examples below assume the key comes from `MNEMONAD_KEY` and use the default `testnet`
chain.

### Push a folder (first time)

```bash
mnemonad push ~/my-data

# prints the new stream id in hex, e.g.:
#   created: 0x68d9736257f0d2da3c848666a4b36c4b9f18eda7e4dfba655599c47560d8a4b5
#   version 1 pushed (full snapshot, gzip compressed)

# examples below use `123` as a stand-in for whatever id you actually got back —
# decimal or hex both work as input, see "Usage" above
```

By default a new stream is public (unencrypted). Encrypting one takes a method — the CLI
never picks for you, since both are reachable from the same invocation. See
[`../docs/encryption/encryption.md`](../encryption/encryption.md) (and its
[password](../encryption/password.md)/[signature](../encryption/signature.md)
pages) for how each actually works and the trade-off each makes:

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

stream: 0x68d9736257f0d2da3c848666a4b36c4b9f18eda7e4dfba655599c47560d8a4b5
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

`--manifest` writes `.mnemonad` into the folder, recording the stream id, version and file
hashes. With it, later commands on the same folder don't need the id typed again:

```bash
mnemonad push ~/my-data --manifest          # no id — read from .mnemonad
mnemonad pull ~/my-data --manifest          # same
mnemonad diff ~/my-data --manifest          # same
```

If no id is given and there's no `.mnemonad` yet (or `--manifest` wasn't passed), the usual
`stream-id is required` error is thrown.

`info` is the one exception that doesn't require `--manifest` to react to a manifest: being
read-only, it always peeks at `.mnemonad` in `<path>` and reports what it finds — a note that
one's available (with its id) if you left `--manifest` off, or a note if the id you gave
doesn't match the one recorded in the folder's own manifest.

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

### Burn a stream

Permanently destroys the stream: the ERC-721 token and its metadata are gone, and — because
ids are deterministic — re-creating a stream with the same id afterward does **not** recover
the old data; the contract deliberately marks a burned id as permanently used. Deployed
CODE-tier item bytes physically survive on-chain regardless — this removes the stream as a
usable, readable thing, not necessarily every trace of its bytes. Requires **`--yes`**: run
without it first to see what would be destroyed (owner, version count, on-chain size) before
committing.

```bash
mnemonad burn 123
# prints stream/chain/versions/size, then refuses to proceed without --yes

mnemonad burn 123 --yes
```

### Repair a corrupt stream with a force snapshot

If a diff patch was pushed against a stale base (e.g. a race condition in `watch`),
subsequent pulls will fail. Fix it by pushing a new full snapshot:

```bash
mnemonad push 123 ~/my-data --force-snapshot
# skips chain replay and pushes the current folder as a self-contained full snapshot
# restore() will recover from this snapshot, skipping any corrupt diffs before it
```

### Vector search (optional)

Builds a local, plain (non-dot-prefixed) `search_index.db` at the folder root, using a local
embedding model — no API key, nothing sent anywhere. Because it's a plain file, it rides
through the next `push` like anything else in the folder, so anyone who later `pull`s the
stream gets a ready-to-search index with no re-embedding of their own.

```bash
mnemonad index ~/my-data
# embeds every changed text file since the last run (skips unchanged ones); binary files
# are skipped entirely

mnemonad search ~/my-data "how does chunking work"
# 1. chunks.txt (chunk 0, distance 0.5838)
#    one byte slips inward the boundaries hold their ground only one chunk moves

mnemonad push ~/my-data
# search_index.db is included automatically — it's just a file in the folder
```

The built-in model is `minishlab/potion-base-8M`: static embeddings in plain JS, no native
code, a 31 MB download on first use, and a whole folder embedded in milliseconds. For better
results on paraphrased queries, MiniLM is available as an optional extension (about 450 MB
installed, most of it ONNX Runtime):

```bash
npm install -g mnemonad-search-transformers
mnemonad index ~/my-data --model minilm
```

An index keeps the model it was built with, and `search` always uses it. To switch an existing
index to another model, add `--rebuild`. See `docs/search.md` in the repository for how the two
compare on this project's own data.

`push` can also keep the index current for you: `--index` runs the same update right before pushing,
with the push's own `--exclude`, so the index always covers exactly what the push uploads.
If indexing fails (the first-time model download, say), nothing is pushed:

```bash
mnemonad push ~/my-data --index
#   updating search index...
#   index: 1 file(s) re-embedded, 0 removed (3 chunks)

mnemonad watch <stream-id> ~/my-data --index
# re-indexes before every automatic push; the model loads once for the whole session
```

A plain `push` of a folder that has an index checks it first. It doesn't load the model and
doesn't touch the file. If files changed since the index was built, it says so and suggests
`--index`, because a stale index would keep returning the old text's passages.

See [`../docs/search.md`](../search.md) for the whole process, and why the index stays
diff-friendly on repeated pushes.

A pushed index also turns on a search box in the explorer's file browser for that stream.
The search runs in the browser on the same file and gives the same ranking as `mnemonad search`.

## End-to-end workflow

Create a stream, verify what was stored, then roll back to an earlier version:

```bash
export MNEMONAD_KEY=0xabc123...

# 1. first push — creates the stream
mnemonad push ~/my-data
#   created: 0x68d9736257f0d2da3c848666a4b36c4b9f18eda7e4dfba655599c47560d8a4b5
#   version 1 pushed (full snapshot, gzip compressed)
# (the rest of this walkthrough keeps using 123 as a stand-in for that id — both
# forms work as input, see "Usage" above)

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
   pulls them if found. Push and pull never run concurrently. The contract *does* check an
   `expectedLength` atomically on every write, so two writers can never land at the same
   index — one just reverts. What it can't check is content: it stores opaque bytes, with no
   way to verify a diff patch is actually consistent with the real previous item. `watch`
   re-checks the remote length and resyncs before pushing specifically to narrow that
   separate window — a best-effort narrowing, not a hard guarantee, since only an atomic
   on-chain check (which it already has, for the index) could close it outright.
6. **compact** — drops all existing history on-chain and pushes the current folder as a
   single fresh full snapshot, speeding up future replay after many incremental syncs.

### Default excludes

The following are always excluded from snapshots: `node_modules`, `.git`, `.env`,
`.DS_Store`, `.mnemonad`, `.claude`, `pnpm-lock.yaml`, `package-lock.json`. Add more with
`--exclude`. `search_index.db` (see "Vector search" above) is deliberately **not** on this
list — it's a plain file, meant to be pushed like any other.

## Dependencies

| Package | Role |
|---|---|
| `mnemonad` | On-chain stream primitive (this repo's `js/`) |
| `monadsync` | Folder-diff / snapshot layer on top of `mnemonad` (this repo's `monadsync/`) |
| `better-sqlite3`, `@sqliteai/sqlite-vector` | The search index: SQLite with vector search (`lib/search/`) |
| `@huggingface/tokenizers` | Tokenizer for the built-in embedding model (pure JS) |
| `mnemonad-search-transformers` | *Not a dependency* — the optional MiniLM extension, installed separately and found at runtime |
| `viem` | Monad client / key management |
