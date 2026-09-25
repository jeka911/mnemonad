---
name: mnemonad
version: 0.1.1
description: Agent skill for versioned folder storage and sync on Monad. Push local folders to on-chain append-only streams with content-defined-chunking diffs and pull any past version. Streams are created encrypted to the signing wallet by default; password-keyed and public streams are also supported. Large files offload to IPFS.
keywords: [monad, evm, storage, versioning, sync, ipfs, encryption, blockchain, erc721]
---

# mnemonad

Versioned folder storage and sync on **Monad**, with **AES-256-GCM** encryption and **IPFS**
offload for large files.

A folder is stored as an append-only **stream** — an ERC-721 token whose items are
content-defined-chunking (CDC) diffs. Each push writes one gzip-compressed patch, so only what
actually changed goes on chain, and any past version can be restored exactly. Items too large
for on-chain storage are offloaded to IPFS with only a hash and pointer recorded on chain.

> **Default: create streams encrypted to the signing wallet.**
> ```bash
> mnemonad push ~/my-data --encrypt --encrypt-with wallet --manifest
> ```
> Everything on this chain is world-readable, so a stream created without `--encrypt` publishes
> its contents to anyone who looks. Unless the user has asked for something public or shareable,
> encrypt to the wallet — it needs no password to manage or leak, and the same `MNEMONAD_KEY`
> that pushes also reads it back. Public and password-keyed streams are both supported and both
> useful; see [Choosing how a stream is keyed](#choosing-how-a-stream-is-keyed).

## When to Use

- **Private, versioned backup of a working folder** — encrypted client-side, before anything
  leaves the process, and readable only by the key that wrote it
- **Archive and restore folder snapshots** on chain with full version history
- **Efficient incremental sync** — only changed chunks are written, not whole files
- **Verify integrity** — pull any version and reconstruct the exact folder state
- **Two-way folder sync** against a stream that other machines are also pushing to
- **Publish a public dataset** that anyone can pull with no key and browse in the dApp —
  deliberately, by leaving `--encrypt` off

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
npm install -g mnemonad-cli@latest
# provides the `mnemonad` command. Already installed but on an old version? `npm update -g`
# doesn't reliably pick up a new release — reinstall with @latest instead, same as above.
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

**The CLI's own default is public; this skill's default is not.** `mnemonad push` with no
encryption flags creates a stream anyone can read — the flags are opt-in, and there is no
setting that changes that. So an agent following this skill passes `--encrypt --encrypt-with
wallet` explicitly on every stream it creates, unless the user asked for otherwise. Forgetting
the flags does not produce an error; it produces a public stream.

**How a stream is keyed is decided once, at creation, and is permanent.** There is no
converting a public stream to an encrypted one later, or re-keying a password stream to a
wallet. The only escape is creating a new stream and pushing the folder into it — which leaves
the original contents on chain regardless.

**Stream ids are ERC-721 token ids.** Pass them as decimal or as `0x` hex; every command
accepts both. Output always prints the hex form (`0x` + 64 digits), which is also what the dApp
displays.

**A link from the dApp can be pasted straight in, network prefix and all.** The explorer's URLs
name the id as `testnet-0x648f18…` — paste that whole thing as `<stream-id>` and the CLI sets
`--chain` to match, no need to strip the prefix by hand. Passing `--chain` too only works if it
agrees; a mismatch is refused rather than guessed.

**`<path>` is always required** wherever a command touches a folder. There is deliberately no
fallback to the current directory, so a mistyped path fails immediately instead of quietly
syncing the wrong folder. The only exceptions are `mnemonad info` with no stream id, and
`mnemonad burn`, which takes no folder at all.

### Choosing how a stream is keyed

Three options. **Wallet is the default** — use it unless the user's goal rules it out:

| | Flags | Who can read it | If the credential is lost |
|---|---|---|---|
| **Wallet** *(default)* | `--encrypt --encrypt-with wallet` | Only the `--key`/`--phrase` account that created it | Unrecoverable |
| **Password** | `--encrypt --encrypt-with password --password <pw>` | Anyone with the password, from any machine | Unrecoverable — no reset |
| **Public** | *(no encryption flags)* | Everyone | N/A — nothing is hidden |

**Wallet** is the default because it is the option with nothing to manage: no password to
choose, store, transmit or leak, and the same `MNEMONAD_KEY` already needed to push is what
reads it back. Its cost is that it is bound to exactly one account forever — lose the key and
the contents are gone, and no other wallet can ever be granted access.

**Password** is the right choice when the data has to be readable somewhere the key isn't —
another machine, another person, a teammate — since the password travels independently of the
wallet. That portability is also the whole risk surface: anyone who learns it can read the
stream.

**Public** is a deliberate publishing act, not a fallback. Use it when the point *is* that
anyone can pull the stream with no credential and browse it in the dApp — a sample dataset,
released documents, anything intended to be shared. Confirm with the user first; on-chain data
cannot be unpublished, and `burn` does not remove item bytes already deployed as on-chain code.

`--password` on its own implies the password method. `--encrypt` with no method is rejected
rather than guessed, because the three differ in who can ever read the data.

Encryption applies **only when creating a stream** — `--encrypt` is ignored when pushing to an
existing one, and an encrypted stream can never be transferred to another owner.

### Use `--manifest`, and use `info` to find a folder's stream id

The stream id is the only handle to a folder's data — there is no lookup by name, and an id
that was never captured anywhere durable is gone for good. **Pass `--manifest` on every push
and pull for any folder that will be touched again**, not just the first one. It writes
`.mnemonad` into the folder (stream id, version, file hashes) and costs nothing to keep
around.

Before assuming a folder isn't synced to a stream yet, check it with `info` — safe and
side-effect-free, even without `--manifest`:

```bash
mnemonad info ~/my-data
# Reports whether a .mnemonad manifest exists in ~/my-data and what stream id it names,
# even though no --manifest flag was passed.
```

With `--manifest`, any command resolves a missing id from `.mnemonad` automatically —
`mnemonad info ~/my-data --manifest`, or `push`/`pull`/`diff`/`watch`/`compact` the same way,
logged as `using stream id from .mnemonad manifest: 0x...`. And if an id is already in hand
from elsewhere, `info` flags it when it doesn't match the folder's own manifest, rather than
silently trusting either one.

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

#### push — creates a new wallet-encrypted stream (the default)

```bash
mnemonad push ~/my-data --encrypt --encrypt-with wallet --manifest
# Output: creating new stream on testnet (encrypted to 0x06bc6420b37a4898424429dcfa236f0065e12279) ...
#           created: 0x68d9736257f0d2da3c848666a4b36c4b9f18eda7e4dfba655599c47560d8a4b5
#           version 1 pushed (full snapshot, gzip compressed)
```

Only this account can ever decrypt it. Nothing to remember, nothing to leak — and no recovery
if the key is lost. Every later `pull`, `diff`, `info` or `watch` on it needs the same key.
`--manifest` writes `.mnemonad` into the folder recording the stream id — without it, the id
exists only in this command's output.

#### push — encrypted with a password instead

```bash
mnemonad push ~/my-data --encrypt --password "correct horse battery staple"
# Readable from any machine by anyone who knows the password.
```

#### push — public, no encryption

```bash
mnemonad push ~/my-data
# Output: creating new stream on testnet (public) ...
# Anyone can read this, permanently. Only do this when publishing is the intent —
# confirm with the user first.
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

#### push/pull without an id, once a manifest exists

```bash
mnemonad push ~/my-data --manifest
# No id needed — read from .mnemonad, written by the wallet-encrypted push above.
mnemonad pull ~/my-data --manifest
# Same. Works for diff, watch, compact and info too, wherever the id is omitted.
```

#### push (full snapshot instead of a diff)

```bash
mnemonad push 0x68d97362... ~/my-data --force-snapshot
# Repairs a stream whose diff history no longer replays cleanly.
```

#### pull (latest, or a specific version)

```bash
mnemonad pull 0x68d97362... ~/restored --manifest
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
| `--manifest` | — | off | Write/use `.mnemonad` for faster change detection; resolves a missing stream-id from it too |
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

### Workflow 1: create and verify (the default path)

```bash
export MNEMONAD_KEY=0xabc123...

# 1. Push a folder — creates the stream, encrypted to this key
mnemonad push ~/important-data --encrypt --encrypt-with wallet
#   creating new stream on testnet (encrypted to 0x06bc6420...) ...
#   created: 0x68d97362...
#   version 1 pushed (full snapshot, gzip compressed)

# 2. Verify by restoring into a scratch folder (same key required)
mnemonad pull 0x68d97362... ~/verify-tmp

# 3. Compare
diff -r ~/important-data ~/verify-tmp && echo "identical"
```

Record the stream id — it and the key are jointly the only way back to this data.

### Workflow 2: version history and rollback

```bash
mnemonad push 0x68d97362... ~/data          # version 2
echo "new file" > ~/data/new.txt
mnemonad push 0x68d97362... ~/data          # version 3

mnemonad info 0x68d97362... ~/data          # how many versions, which one is local

mnemonad pull 0x68d97362... ~/data-v1 --version 1
```

### Workflow 3: publish a public dataset (deliberately unencrypted)

```bash
mnemonad push ~/dataset
# No --encrypt: anyone can pull it with no key, and browse it at
# https://mnemonad.vercel.app/stream/testnet-0x68d97362.../files
```

This is the one case where leaving the encryption flags off is correct rather than an
oversight — and it is permanent, so confirm the contents are meant to be public first.

### Workflow 4: shared folder, keyed by a password

Use this when the data has to be readable somewhere the signing key isn't — another machine,
or someone else:

```bash
mnemonad push ~/shared-notes --encrypt --password "correct horse battery staple"

# Anywhere else, with no wallet involved in the read:
mnemonad pull 0x68d97362... ~/shared-notes --password "correct horse battery staple"
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
| **"No signing key"** | A write, or a wallet-encrypted read, with no credentials | `export MNEMONAD_KEY=0x...`, or pass `--key` / `--phrase` |
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

- **Default to `--manifest` on every push and pull.** It writes `.mnemonad` into the folder,
  recording the stream id, version and file hashes — the local record tying the folder back
  to its stream, and subsequent pushes compare against it instead of replaying the chain.
  With it, a later command on the same folder can drop the id entirely —
  `mnemonad push ~/my-data --manifest`, `mnemonad pull ~/my-data --manifest` — and every
  command that touches a folder resolves it from `.mnemonad` when no id is given. Without
  `--manifest`, the id lives only in that one push's output and there is no lookup by name.

- **Create streams with `--encrypt --encrypt-with wallet` by default.** Leaving the flags off
  is not a neutral choice — it publishes the folder to anyone who looks, permanently, and the
  CLI will not warn you. Pass them on every creation unless the user has said the data should
  be public or readable without their key.

- **Say what you created, in one line, the first time.** "Encrypted to your wallet — only this
  key can read it, and there's no recovery if it's lost." The user needs to know both halves
  before they put anything real in it, and it is far cheaper to say at creation than to
  discover at restore.

- **Making a stream public requires the user's explicit intent.** Confirm before pushing
  without `--encrypt`. On-chain data cannot be unpublished, and `burn` does not remove item
  bytes already deployed as on-chain code.

- **Use the password method when the user names a reader who isn't them** — another machine,
  a teammate, a recipient. That is what it's for; a wallet-keyed stream cannot be shared with
  anyone, ever.

- **Never put a private key in a command line.** Use `MNEMONAD_KEY`. A key in a flag lands in
  shell history and process listings, and agent transcripts often get shared.

- **Never run `burn` speculatively, and never add `--yes` on the user's behalf.** Run it once
  without `--yes` to show what would be destroyed, and let the user confirm. It cannot be
  undone.

- **Check `diff` before a push you are unsure about.** It is read-only, costs nothing, and
  shows exactly what the push would apply.

- **Expect a push to cost gas and take a block.** On a failure, read the output before
  retrying: "no changes, nothing to push" is success, not an error.
