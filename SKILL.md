---
name: mnemonad
version: 0.1.1
description: Agent skill for versioned folder storage and sync on Monad. Push local folders to on-chain append-only streams with content-defined-chunking diffs, pull any past version, encrypt with a password or the owner's wallet, and offload large files to IPFS.
keywords: [monad, evm, storage, versioning, sync, ipfs, encryption, blockchain, erc721]
---

# mnemonad

Versioned folder storage and sync on **Monad**, with optional **IPFS** offload for large files
and optional **AES-256-GCM** encryption.

A folder is stored as an append-only **stream** — an ERC-721 token whose items are
content-defined-chunking (CDC) diffs. Each push writes one gzip-compressed patch, so only what
actually changed goes on chain, and any past version can be restored exactly. Items too large
for on-chain storage are offloaded to IPFS with only a hash and pointer recorded on chain.

## When to Use

- **Archive and restore folder snapshots** on chain with full version history
- **Efficient incremental sync** — only changed chunks are written, not whole files
- **Encrypted storage** — data is encrypted client-side, before it ever leaves the process
- **Verify integrity** — pull any version and reconstruct the exact folder state
- **Publish a public dataset** that anyone can pull with no key and browse in the dApp
- **Two-way folder sync** against a stream that other machines are also pushing to

## When NOT to Use

- **Large binary churn.** Every push costs gas, and files over the registry's `maxChunkBytes`
  (65,536 bytes on testnet) need IPFS offload, which costs MON escrow per upload. A folder of
  constantly-rewritten large binaries is expensive; a folder of text, code, config or documents
  is what this is efficient at.
- **Secrets you cannot rotate.** An encrypted stream can never be transferred, and a
  wallet-keyed one can never be decrypted by anything but that wallet — with no recovery.
- **Data you may need to erase.** Chain data is permanent. `burn` destroys the token and its
  metadata, but item bytes already deployed as on-chain code survive regardless.

## Installation

Check whether it is already installed:

```bash
mnemonad --help
```

If not, install from npm:

```bash
npm install -g mnemonad-cli
# provides the `mnemonad` command
```

Then check the configured chain and wallet:

```bash
mnemonad info
# Output:   chain:            testnet
#           your wallet:      0x06bc6420b37a4898424429dcfa236f0065e12279
```

If `your wallet` shows `(none)`, set a key (below). A key is **not** required to pull, diff or
inspect a public stream — only to push, or to unlock a wallet-encrypted stream.

### Verify the install against a real public stream

This is a live, public, unencrypted stream on testnet — pulling it needs no key and no setup:

```bash
mnemonad pull 0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8 ~/mnemonad-demo
```

### Set up your key (required for push, and for wallet-encrypted pulls)

```bash
export MNEMONAD_KEY=0xabc123...        # a Monad private key
```

`--key` and `--phrase` work as flags too, but prefer the environment variable: a key passed as
a flag ends up in shell history, process listings and any log that captures the command.

Testnet MON for gas comes from https://faucet.monad.xyz/.

## Core concepts

**Streams are public by default.** Anything pushed without `--encrypt` is readable by anyone.
Encryption is opt-in, chosen once at creation, and permanent — see below.

**Stream ids are ERC-721 token ids.** Pass them as decimal or as `0x` hex; every command
accepts both. Output always prints the hex form (`0x` + 64 digits), which is also what the dApp
displays.

**`<path>` is always required** wherever a command touches a folder. There is deliberately no
fallback to the current directory, so a mistyped path fails immediately instead of quietly
syncing the wrong folder. The only exceptions are `mnemonad info` with no stream id, and
`mnemonad burn`, which takes no folder at all.

### Encryption

Two methods, decided at creation and never guessed for you:

| Method | Flags | Key comes from | Recovery |
|---|---|---|---|
| **Password** | `--encrypt --encrypt-with password --password <pw>` | PBKDF2 over your password + a per-stream salt published on chain | Anyone with the password, from any machine. No reset if lost. |
| **Wallet** | `--encrypt --encrypt-with wallet` | A signature from the `--key`/`--phrase` account | That account only. No recovery at all if the key is lost. |

`--password` on its own implies the password method. `--encrypt` without a method is rejected
rather than guessed, because the two differ in who can ever read the data.

Encryption applies **only when creating a stream** — `--encrypt` is ignored when pushing to an
existing one, and an encrypted stream can never be transferred to another owner.

## API Surface

| Command | Arguments | Use case |
|---|---|---|
| **push** | `[stream-id] <path> [options]` | Sync a folder to a stream; creates a new one if no id is given |
| **pull** | `<stream-id> <path> [options]` | Restore a stream into a folder (default: latest version) |
| **info** | `[stream-id] [path] [options]` | No id: chain + wallet. With id: full stream metadata and local sync status |
| **diff** | `<stream-id> <path> [options]` | List files added/modified/deleted locally vs the chain. Read-only |
| **watch** | `<stream-id> <path> [options]` | Two-way sync: auto-push local changes, auto-pull remote updates |
| **compact** | `<stream-id> <path> [options]` | Drop old history and push the current folder as a fresh snapshot |
| **burn** | `<stream-id> --yes [options]` | Permanently destroy the stream. Irreversible |

### Command examples

#### push (creates a new public stream)

```bash
mnemonad push ~/my-data
# Output: creating new stream on testnet (public) ...
#           created: 0x68d9736257f0d2da3c848666a4b36c4b9f18eda7e4dfba655599c47560d8a4b5
#           version 1 pushed (full snapshot, gzip compressed)
```

#### push (encrypted with a password)

```bash
mnemonad push ~/my-data --encrypt --password "correct horse battery staple"
# Anyone who knows the password can read it, from any machine.
```

#### push (encrypted to the signing wallet)

```bash
mnemonad push ~/my-data --encrypt --encrypt-with wallet
# Only this account can ever decrypt it. No password to leak — and no recovery.
```

#### push (to an existing stream)

```bash
mnemonad push 0x68d97362... ~/my-data
# Pushes a diff against the latest version. Prints "no changes, nothing to push" if identical.
```

#### push (faster change detection via manifest)

```bash
mnemonad push 0x68d97362... ~/my-data --manifest
# Writes .mnemonad in the folder, recording the stream id, version and file hashes.
# Subsequent pushes compare against it instead of replaying the chain.
```

#### push (full snapshot instead of a diff)

```bash
mnemonad push 0x68d97362... ~/my-data --force-snapshot
# Repairs a stream whose diff history no longer replays cleanly.
```

#### pull (latest, or a specific version)

```bash
mnemonad pull 0x68d97362... ~/restored
mnemonad pull 0x68d97362... ~/restored --version 3
```

#### diff (preview what a push would do)

```bash
mnemonad diff 0x68d97362... ~/my-data
# Output: local changes vs chain (what push would apply):
#           added:      docs/new-page.md
#           modified:   src/index.js
#           deleted:    old-config.json
#         3 change(s): 1 added, 1 modified, 1 deleted
# Writes nothing. Compare against an older version with --version N.
```

#### info (full stream metadata + local sync status)

```bash
mnemonad info 0x68d97362... ~/my-data
# Output: stream: 0x68d9736257f0d2da3c848666a4b36c4b9f18eda7e4dfba655599c47560d8a4b5
#           owner:            0x06bc6420b37a4898424429dcfa236f0065e12279 (you)
#           encrypted:        no
#           versions:         3
#           binary size:      385.7 KB
#           local matches:    version 3 of 3
#           status:           up to date
```

#### watch (two-way sync)

```bash
mnemonad watch 0x68d97362... ~/my-data --poll-interval 5
# Auto-pushes local changes after a 1000ms quiet period.
# Checks the chain every 5s and auto-pulls new versions. Ctrl-C to stop.

mnemonad watch 0x68d97362... ~/my-data --push-only   # never auto-pull
mnemonad watch 0x68d97362... ~/my-data --pull-only   # read-only mirror
```

#### compact (shorten replay history)

```bash
mnemonad compact 0x68d97362... ~/my-data
# Drops old history, then pushes the current folder as one full snapshot.
# Future pull/info/diff replay less history, so they are faster.
```

**Compaction is not a refund.** Monad has no storage rebate — this buys read speed, not gas
back, and it costs a transaction to do. Versions before the compaction point become
unavailable.

#### burn (permanent destruction)

```bash
mnemonad burn 0x68d97362...
# Prints what would be destroyed, then refuses without --yes.

mnemonad burn 0x68d97362... --yes
```

Destroys the ERC-721 token and its metadata. Re-creating a stream with the same id afterwards
does **not** recover the data — the contract marks a burned id as permanently used. Item bytes
already deployed as on-chain code physically survive; burning removes the stream as a usable,
readable thing.

## Configuration

### Command-line flags

| Flag | Arguments | Default | Use |
|---|---|---|---|
| `--chain` | `testnet` \| `mainnet` \| `local` | `testnet` | Which Monad network to use |
| `--rpc-url` | URL | chain default | Override the RPC endpoint (e.g. a local Hardhat node) |
| `--contract-address` | Address | known deployment | Registry address; required with `--chain local` |
| `--key` | Monad private key | — | Sign transactions (prefer `MNEMONAD_KEY`) |
| `--phrase` | Mnemonic phrase | — | Alternative to a raw key; `--key`/`MNEMONAD_KEY` win over it |
| `--encrypt` | — | off | Create the new stream encrypted. Only applies at creation |
| `--encrypt-with` | `password` \| `wallet` | — | Which method keys it. Implied by `--password`; required otherwise |
| `--password` | Password | — | Encrypt a new stream with, or decrypt an existing one |
| `--version` | Number | latest | `pull`/`diff`/`info`: use a specific version |
| `--exclude` | Comma-separated patterns | — | Extra patterns to exclude from sync |
| `--no-compress` | — | gzip on | Disable gzip compression |
| `--manifest` | — | off | Write/use `.mnemonad` for faster change detection |
| `--force-snapshot` | — | off | Push a full snapshot regardless of history (repairs a corrupt stream) |
| `--gateway-url` | URL | Pinata public gateway | IPFS gateway for reading offloaded items |
| `--presign-url` | URL | deployed presign server | Paid IPFS uploads with no Pinata credential of your own |
| `--pinata-jwt` | JWT | — | Use your own Pinata credential instead of the presign server |
| `--poll-interval` | Seconds | `2` | `watch`: how often to check the chain |
| `--debounce` | Milliseconds | `1000` | `watch`: quiet period before pushing a local change |
| `--push-only` | — | — | `watch`: disable auto-pull |
| `--pull-only` | — | — | `watch`: disable auto-push |
| `--yes` | — | — | Required by `burn`; explicit opt-in to an irreversible action |

### Environment variables

| Variable | Type | Use |
|---|---|---|
| `MNEMONAD_KEY` | Monad private key | Sign transactions (preferred over `--key`) |
| `PINATA_JWT` | Pinata JWT | Same as `--pinata-jwt` |
| `MNEMONAD_IPFS_GATEWAY` | URL | Same as `--gateway-url` |
| `MNEMONAD_PRESIGN_URL` | URL | Same as `--presign-url` |

### Large files and IPFS

An item larger than the registry's `maxChunkBytes` cannot go on chain and must be offloaded.
By default the CLI uses the project's deployed presign server: the signing account pays an
on-chain escrow, proves it with a signature, and gets a one-shot upload URL — no Pinata
account needed. Supply `--pinata-jwt` to use your own credential instead. Reading an offloaded
item back only needs `--gateway-url`, which has a working public default.

## Example workflows

### Workflow 1: create and verify

```bash
# 1. Push a folder — creates the stream
mnemonad push ~/important-data
#   created: 0x68d97362...
#   version 1 pushed (full snapshot, gzip compressed)

# 2. Verify by restoring into a scratch folder
mnemonad pull 0x68d97362... ~/verify-tmp

# 3. Compare
diff -r ~/important-data ~/verify-tmp && echo "identical"
```

### Workflow 2: version history and rollback

```bash
mnemonad push 0x68d97362... ~/data          # version 2
echo "new file" > ~/data/new.txt
mnemonad push 0x68d97362... ~/data          # version 3

mnemonad info 0x68d97362... ~/data          # how many versions, which one is local

mnemonad pull 0x68d97362... ~/data-v1 --version 1
```

### Workflow 3: publish a public dataset

```bash
mnemonad push ~/dataset
# No --encrypt: anyone can pull it with no key, and browse it at
# https://mnemonad.vercel.app/stream/testnet-0x68d97362.../files
```

### Workflow 4: private folder, keyed to your wallet

```bash
export MNEMONAD_KEY=0xabc123...
mnemonad push ~/private-notes --encrypt --encrypt-with wallet

# Later, on any machine holding the same key:
mnemonad pull 0x68d97362... ~/private-notes
```

### Workflow 5: compact a long history

```bash
mnemonad info 0x68d97362... ~/data
#   versions:         87

mnemonad compact 0x68d97362... ~/data
#   dropped 86 history entries
#   pushed version 88
# Future reads replay one snapshot instead of 87 patches. Not a gas refund.
```

## Troubleshooting

| Issue | Cause | Solution |
|---|---|---|
| **"No signing key. Use --key, --phrase, or MNEMONAD_KEY env var"** | A write (or a wallet-encrypted read) with no credentials | `export MNEMONAD_KEY=0x...`, or pass `--key` / `--phrase` |
| **"a folder path is required"** | The command touches a folder but no path was given | Pass it explicitly — there is no current-directory fallback |
| **"stream-id is required for ..."** | Command needs a stream id | Pass it first: `mnemonad pull 0x... ~/dest` |
| **"This stream is encrypted with a password. Provide --password to decrypt."** | Password-keyed stream, no password given | Add `--password <pw>` |
| **"This stream is encrypted to its owner's wallet."** | Wallet-keyed stream, wrong or missing key | Use the owning account's key via `--key` / `--phrase` / `MNEMONAD_KEY` |
| **"Could not decrypt this stream"** | Credential is the right *kind* but the wrong one | Wrong password, or a key that isn't the stream's owner |
| **"stream 0x... is owned by 0x... but you are signing as 0x..."** | Pushing to someone else's stream | Use the owner's key, or push with no id to create your own |
| **"--encrypt needs a method"** | `--encrypt` alone | Add `--encrypt-with password` (with `--password`) or `--encrypt-with wallet` |
| **"Item of N bytes exceeds maxChunkBytes"** | File too large for on-chain storage, no offload configured | Leave the default presign server enabled, or pass `--pinata-jwt` |
| **`payForUpload` reverted** | Not enough MON to cover the IPFS upload escrow | Fund the account (https://faucet.monad.xyz/ on testnet) or push less data |
| **"unknown patch type"** | The stream holds plain items, not a folder filesystem | It was not created by this CLI; there is no folder to restore |
| **`IndexTruncated` / old versions missing** | Those versions were dropped by `compact` | Only versions from the compaction point onward are available; pull without `--version` |
| **"version must be between 1 and N"** | `--version` outside the stream's range | Run `info` to see how many versions exist |
| **"--chain local requires --rpc-url / --contract-address"** | Local mode has no known deployment | Pass both, pointing at your local node and deployed registry |
| **"no such folder: /path"** | A command that reads a folder was given a path that doesn't exist | Create it, or `mnemonad pull <stream-id> <path>` to fetch one into it. `pull` itself creates the folder |
| **"not a folder: /path"** | The path is a file | These commands sync a directory, not a single file |
| **Connection errors** | RPC unreachable, or the wrong chain | Check `--chain`; retry, or pass `--rpc-url` |

## Links

- **npm**: https://www.npmjs.com/package/mnemonad-cli
- **dApp / explorer**: https://mnemonad.vercel.app
- **Testnet faucet**: https://faucet.monad.xyz/
- **SDK** (`mnemonad`): https://www.npmjs.com/package/mnemonad
- **Folder-sync layer** (`monadsync`): https://www.npmjs.com/package/monadsync

## Agent guidelines

- **Run `mnemonad` commands as standalone Bash calls.** Never chain them with `&&` or `;`, and
  never combine them with file creation in the same invocation. Write the files in one call,
  then push in a dedicated one — a push is a chain transaction, and its output is what tells
  you (and the user) what actually happened.

- **Report the stream id and version after every push,** and offer the browse link:
  `https://mnemonad.vercel.app/stream/<network>-0x<id>/files`. The id is printed as hex; use it
  verbatim.

- **The stream id is the only handle to the data — surface it immediately on creation.** There
  is no lookup by name and no way to recover an id you never recorded. On a first push, show
  the id prominently and suggest `--manifest`, which writes `.mnemonad` into the folder
  recording the stream id, version and file hashes — that file is the local record tying the
  folder back to its stream.

- **Never choose the encryption method for the user.** Public, password and wallet-keyed are
  three different security models, the choice is permanent, and two of them have no recovery.
  Ask; the CLI deliberately refuses to guess.

- **Never put a private key in a command line.** Use `MNEMONAD_KEY`. A key in a flag lands in
  shell history and process listings, and agent transcripts often get shared.

- **Never run `burn` speculatively, and never add `--yes` on the user's behalf.** Run it once
  without `--yes` to show what would be destroyed, and let the user confirm. It cannot be
  undone.

- **Check `diff` before a push you are unsure about.** It is read-only, costs nothing, and
  shows exactly what the push would apply.

- **Expect a push to cost gas and take a block.** On a failure, read the output before
  retrying: "no changes, nothing to push" is success, not an error.
