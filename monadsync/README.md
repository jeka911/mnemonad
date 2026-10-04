# MonadSync

Folder-tree delta sync on Monad.

**MonadSync** combines the power of two. Two libraries walk into a blockchain...

- **[Mnemonad](../js)** is a scalable append-only on-chain stream for Monad that grows beyond transaction/gas limits by chunking large items and offloading oversized ones to IPFS. It has built-in AES-256-GCM encryption support — all stored data can be encrypted with a password- or signer-wrapped key, so only the stream owner (or an approved reader who has the password) can decrypt.
- **[DoubleSync](https://github.com/FizzyFlow/doublesync)** is a content-defined chunking engine that splits files at content-determined boundaries so that small edits only affect nearby chunks, deduplicates identical chunks by SHA-256, fingerprints folder trees as Merkle trees for fast skip of unchanged subtrees, and produces compact incremental diff patches that carry only the changed operations and chunks.

Together: DoubleSync builds snapshot and diff patch documents from a folder tree, and Mnemonad stores them as an ordered chain of items on Monad, giving you versioned, deduplicated, incrementally-updated folder sync on the blockchain.

**TL;DR:** git-like filesystem/folder versioning on Monad.

Both libraries are fully standalone and can be used independently of each other and without MonadSync. Mnemonad works as general-purpose scalable on-chain storage for any `vector<uint8>` data, and DoubleSync works as a pure CDC diff engine for any folder sync scenario — network, disk, database, cloud, any abstraction and whatever transport you want.

## Overview

MonadSync stores a chain of patch documents inside a Mnemonad stream:

```
Mnemonad (on-chain)
  item[0]  full DoubleSyncPatch        (initial state)
  item[1]  DoubleSyncDiffPatch         (v1 -> v2, only changed chunks)
  item[2]  DoubleSyncDiffPatch         (v2 -> v3)
  ...
```

The first push is always a self-contained full patch. Every subsequent push produces an incremental diff patch that carries only the operations and chunks the receiver doesn't already have. Patch type is auto-detected by magic header — no metadata needed.

Mnemonad handles all on-chain size constraints automatically (chunk splitting, staged multi-transaction pushes, IPFS offloading for large payloads).

## Features

- **Incremental sync**: Content-defined chunking means only changed bytes cross the wire and land on-chain
- **Version history**: Every push is a new version; restore any past version by replaying the chain
- **Auto-detection**: Patch type (full / diff / compressed) detected from magic bytes
- **Compression**: Optional gzip envelope to reduce on-chain storage cost
- **Stateless resume**: A new sender instance rebuilds its CDC store and session state by replaying existing chain items — no local state required between sessions
- **Transparent blob routing**: Large patches are automatically staged/offloaded by Mnemonad
- **Transparent encryption**: If the underlying `Mnemonad` instance is itself encrypted (password- or signer-wrapped key), every patch document is transparently AES-encrypted by Mnemonad's own `push()`/`at()` — MonadSync never has to know
- **Corrupt chain recovery**: If a diff patch on-chain is unreadable (e.g. pushed against a stale base), `restore()` and `initialize()` skip it and reset at the next full snapshot further down the chain, rather than throwing. If no recovery snapshot exists, an error is thrown — repair with a force snapshot (see below)
- **Truncated-prefix aware**: If the stream's prefix has been dropped via `Mnemonad.truncateFrom()`, `initialize()`/`restore()`/`getTreeHash()` start from the first still-readable item instead of failing

## Install

```bash
pnpm add monadsync
```

## Usage

### Sender: push folder state to chain

```js
import Mnemonad from 'mnemonad';
import { DoubleSync, DoubleSyncMemoryFolder } from '@fizzyflow/doublesync';
import MonadSync from 'monadsync';

const mnemonad = new Mnemonad({
    publicClient,
    walletClient,
    contractAddress: 'monadTestnet',
    id: streamId,
});

const sync = new DoubleSync({ avgSize: 8192 });
const m = new MonadSync({ mnemonad, sync });
await m.initialize();

// Build your folder tree
const root = new DoubleSyncMemoryFolder('project');
const src = await root.addFolder('src');
await src.addFile('index.js', new TextEncoder().encode('console.log("hello")'));
await root.addFile('README.md', new TextEncoder().encode('# My Project'));

// Push to chain (first call = full patch, subsequent = diff)
await m.push(root);

// Edit and push again — only the diff goes on-chain
await src.addFile('utils.js', new TextEncoder().encode('export function add(a, b) { return a + b; }'));
await m.push(root);
```

### Receiver: restore folder state from chain

```js
const mnemonad = new Mnemonad({ publicClient, contractAddress: 'monadTestnet', id: streamId });
const m = new MonadSync({ mnemonad });

// Restore latest version
const folder = await m.restore();

// Or restore a specific version
const v1 = await m.restore(1);
```

### Encryption

Encryption is handled entirely by Mnemonad — create (or open) the stream encrypted, and every patch MonadSync pushes/reads is transparently encrypted/decrypted:

```js
const mnemonad = await Mnemonad.create({
    publicClient, walletClient, contractAddress: 'monadTestnet',
    encrypt: true, password: 'correct horse battery staple',
});
const m = new MonadSync({ mnemonad, sync });
await m.initialize();
await m.push(root); // patch bytes are encrypted on-chain automatically
```

### Compression

```js
const m = new MonadSync({ mnemonad, sync, compress: 'gzip' });
await m.initialize();
await m.push(root);  // patches are gzip-wrapped before pushing

// Restore auto-detects compression — no flag needed on the reader side
const m2 = new MonadSync({ mnemonad: reader });
const folder = await m2.restore();
```

### Resume from existing chain

A new MonadSync instance on a populated Mnemonad stream rebuilds its internal state (CDC store + last snapshot) by replaying all existing items. The next push produces a diff patch — not a full patch.

```js
// Some time later, new process...
const m = new MonadSync({ mnemonad, sync });
await m.initialize();  // replays chain to rebuild state
await m.push(updatedRoot);  // produces a diff patch
```

## API

### `new MonadSync({ mnemonad, sync?, compress?, maxPatchItemBytes? })`

| Param | Type | Default | Description |
|---|---|---|---|
| `mnemonad` | `Mnemonad` | required | Mnemonad instance (read-only or read+write) |
| `sync` | `DoubleSync` | `new DoubleSync()` | DoubleSync instance with CDC parameters |
| `compress` | `'gzip'` \| `false` | `false` | Wrap patches in gzip before pushing |
| `maxPatchItemBytes` | `number` | `8388608` | Split larger patch documents across multiple stream items |

### `initialize(): Promise<void>`

Load the Mnemonad stream's state and rebuild internal CDC store + session by replaying existing chain items. Safe to call multiple times.

### `push(root, params?): Promise<{ version: number }>`

Build the next patch from `root` and push it to the Mnemonad stream. Auto-initializes if needed. `params` is forwarded to `Mnemonad.push()` (e.g. a fee override via `value`). Same as `preparePush()` followed by `commitPush()`.

### `preparePush(root): Promise<PreparedPush>`

Build the next patch from `root` without writing anything to chain. Returns `{ patchBytes, kind, baseLength, itemCount, version, newSnapshot, newChunks }`. `patchBytes` is the exact, already compressed document `push()` would send, and `baseLength` is the stream length it was built against.

### `commitPush(prepared, params?): Promise<{ version: number }>`

Send a patch built by `preparePush()`. It needs no chain replay, so a fresh `MonadSync` on a fresh `Mnemonad` can send a patch prepared somewhere else (the CLI's `push --detach` sends it from a background process this way). Throws with `err.code === 'STREAM_MOVED'`, writing nothing, when the stream no longer has `baseLength` items. The contract checks the same thing on every write, so a stream that moves between that check and the transaction reverts instead of landing on the wrong base.

```js
const prepared = await m.preparePush(root);   // local work only
// … later, or in another process with its own Mnemonad instance:
await new MonadSync({ mnemonad }).commitPush(prepared);
```

### `restore(version?): Promise<DoubleSyncMemoryFolder>`

Reconstruct the folder tree by replaying patches from the chain. Defaults to latest version.

If a corrupt diff patch is encountered during replay, it is skipped and state is reset at the next full snapshot found further along the chain. If the chain ends in corrupt state with no recovery snapshot, an error is thrown with `'corrupt state'` in the message.

### `length(): Promise<number>`

Number of patch versions stored on chain.

### `getPatch(index): Promise<Uint8Array>`

Raw patch bytes at the given chain index.

### `getTreeHash(version?): Promise<Uint8Array>`

Returns the 32-byte Merkle tree hash for the given version (defaults to latest). Reads backwards to find the nearest full snapshot, then replays only the diff-patches forward — best case is a single read with no replay.

### `reInitialize()`

Force full state reset. Next `initialize()` replays the chain from scratch.

## Repairing a corrupt chain

If a diff patch was pushed against a stale base (e.g. a race condition or watch-command bug), `restore()` will throw because the chain ends in corrupt state with no recovery snapshot. Fix it by pushing a new full snapshot at the current chain tip:

```js
// m is a MonadSync instance on the corrupt Mnemonad stream
await m._mn.initialize();

// Bypass chain replay — push a clean full snapshot directly
m._isInitialized = true;
m._lastSnapshot = null;
m._replayedCount = m._mn.length;

await m.push(currentFolder);  // pushes full snapshot, not a diff
```

After this, `restore()` will skip the corrupt diff and recover from the new full snapshot. Subsequent pushes produce normal diffs again.

## Testing

Tests run against a real local Hardhat node, reusing [mnemonad](../js)'s own test harness (`../js/test/fixture.js`) directly rather than duplicating it:

```bash
pnpm test
```

Requires `contracts/` to already be built (`pnpm build` there) so the Mnemonad registry artifact exists for deployment.

## Dependencies

- [@fizzyflow/doublesync](https://github.com/fizzyFlow/doublesync) — CDC chunking, snapshot/patch encoding, folder-tree diff
- [mnemonad](../js) — on-chain append-only stream for Monad with chunking, staged multi-tx pushes, and IPFS offloading
