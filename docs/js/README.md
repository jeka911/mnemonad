# Mnemonad — JavaScript SDK

JavaScript/TypeScript SDK for the Mnemonad contract on [Monad](https://monad.xyz).
Mnemonad is a scalable, append-only on-chain `bytes[]` that grows beyond what a single
transaction can carry, by tiering storage and staging large writes. Items too large for the
chain are transparently offloaded to IPFS. Optional client-side AES-256-GCM encryption
protects stored data.

See the root [`README.md`](../../README.md) for how the pieces fit together.

Status: **test MVP.** 330 passing tests against a local node (plus an opt-in suite against
a real Pinata account). Not published; live on Monad testnet, not mainnet.


## API notes

A few methods worth knowing about, beyond `push()` / `at()` / `length`:

- `pushMany()` — packs a batch into one shared chunk (see Batching below)
- `getItemRefs()` — an item's physical layout (chunk addresses, offset): the primitive a
  future contract migration would read
- `setWriterApproval()` — grants append rights to another address, independent of ERC-721
  transfer approval
- `itemAt()` — an item's tier/size without reading its payload
- `estimatePushCost()` — gas + protocol fee for a push, before sending it. Mirrors `push()`'s
  own routing: a single-write estimate when the item fits in one chunk, the staged
  multi-transaction path for `{ onChain: true }` on an oversized item (modeled — the true
  per-call gas can't be simulated without spending it, since `appendChunk`/`commitItem` each
  need a `stagingId` that only exists once a prior transaction has landed), or an
  IPFS-backed estimate when a transport is configured. Encrypts first on an encrypted
  stream with a usable key, exactly like `push()` does, since the ~28-byte AES-GCM framing
  overhead can flip which of those routes actually applies, not just its price. Its result
  carries `transactionCount`, which is `1` except on the staged path
- `quoteOffloadUpload()` — MON needed to prepay the wired upload gateway for an off-chain
  payload of a given size, before ever committing to it; `null` if no gateway is wired
- `create`/`push`'s `name`/`type` params, and the `streamMeta`/`itemMeta` getters — a small
  JSON metadata format for a stream's name/KEK and an item's name/MIME type, gzip-compressed
  on-chain when that's smaller; `encodeStreamMeta`/`decodeStreamMeta`/`encodeItemMeta`/
  `decodeItemMeta` are the low-level functions underneath, for raw-bytes access. See
  Metadata below
- `Mnemonad.listOwned(publicClient, contractAddress, owner)` — static; every stream `owner`
  currently holds, via the registry's `ERC721Enumerable` index rather than an off-chain scan
- `maxRPCRequestsPerSecond` — caps outbound RPC calls, queuing the rest instead of firing
  them all at once. Public RPC endpoints commonly 429 an unthrottled fan-out (several fields
  per stream, times several streams, all via `Promise.all`); every instance configured with
  the same rate on the same chain shares one budget, so the cap holds across a whole
  fan-out rather than per instance. Omit for unlimited (the default)

This stream is strictly append-only — there is no update-in-place operation — and deletion
is logical only, via `truncateFrom()`, not a way to reclaim gas.

## Quick start

```javascript
import { Mnemonad } from 'mnemonad';

const ev = await Mnemonad.create({
    publicClient,
    walletClient,
    contractAddress: 'monadTestnet', // or an explicit 0x... address
});

await ev.push(new Uint8Array([1, 2, 3]));
const item = await ev.at(0); // Uint8Array
```

Read-only instances need only `publicClient`, `contractAddress` and `id`. Add
`walletClient` (or `sendTransaction`) for writes, IPFS params for large items, and `signer`
for encryption.

## Storage tiers

The contract picks a tier per item; the SDK routes by size. All thresholds are read from
chain, never hardcoded.

| Payload | Tier | Notes |
|---|---|---|
| ≤ 31 bytes | `SLOT` | One packed storage slot. |
| 32 bytes – `maxChunkBytes` | `CODE` | Deployed as contract code. ~2.5× cheaper per byte than storage, ~44× cheaper to read. |
| larger, `{ onChain: true }` | `CODE` × N | Staged across several transactions. |
| larger, IPFS configured | `EXTERNAL` | Only a CID + hash on-chain — prepaid through a wired gateway automatically, if one exists (see "Prepaying an off-chain upload is automatic" below). |

```javascript
// Force a large item on-chain instead of offloading it
await ev.push(bigPayload, { onChain: true });
```

Both multi-step paths report progress the same way — `onProgress` is silent for anything
that's just one transaction:

```javascript
await ev.push(bigPayload, {
  onChain: true, // staged: fires once per beginItem/appendChunk/commitItem
  onProgress: ({ phase, chunkIndex, chunkCount }) => {
    // phase: 'begin' | 'chunk' | 'commit' (staged)
    //      | 'gateway-pay' | 'gateway-upload' (off-chain, gateway-prepaid)
    console.log(`${phase}: ${chunkIndex}/${chunkCount}`);
  },
});
```

Only called for the staged path — a single-transaction push has nothing to report progress
on. There is no resume support yet: `appendChunk` validates its offset on-chain, which is
what would make resuming a failed upload safe, but nothing currently persists the staging
id across a failure to make use of that.

## Batching matters

Each `CODE` chunk carries ~32,000 gas of `CREATE` overhead, and each transaction loads the
stream's storage pages cold (8,100 a page under Monad's MIP-8). Both dominate for small
items. `pushMany` packs a whole batch into one chunk and one transaction:

```javascript
await ev.pushMany([chunk1, chunk2, chunk3]); // one deployed chunk, three items
```

Packing is only possible within a single transaction — chunks are immutable, so an item can
never be folded into an existing chunk afterwards. Measured on Monad testnet, 10 × 200 B
costs 760,781 gas packed versus ~1,704,000 as ten separate pushes — 55% less (see
[gas on Monad testnet](../gas.md)).

## Metadata

Both a stream and an item carry an opaque `meta` field on-chain — the contract never
interprets it. The SDK's own convention on top of that: a small JSON object, gzip-compressed
when that's actually smaller than plain (the common case for a bare short name is that it
isn't — gzip's own header/trailer overhead outweighs the savings below a certain size; a
name alongside a KEK block, or anything with enough repeated structure, wins — measured, not
assumed). The two forms self-distinguish on decode (gzip's magic header can never start a
JSON object's UTF-8 bytes), so there's no separate format-version byte to track.

A caller never has to encode this itself — `name`/`type` are just params on `create()`/
`push()` directly, alongside everything else those already take:

```javascript
const ev = await Mnemonad.create({ ...params, name: 'My Documents' });

await ev.push(fileBytes, { name: 'photo.jpg', type: 'image/jpeg' });
```

`create()` folds in this stream's own password KEK block automatically too, when one
exists — a caller passing `password` never has to read back `crypto.getPasswordSalt()`,
build a `{ method, salt, iterations }` object, and encode it itself; `create()` already
knows all three by the time it writes `meta`, since deriving the salt is a side effect of
wrapping the data key a few lines earlier (see `MnemonadCrypto.getPasswordKek`'s own doc):

```javascript
const ev = await Mnemonad.create({
    ...params,
    encrypt: true,
    password: 'a strong passphrase',
    name: 'My Documents',
});
ev.streamMeta.kek; // { method: 'password', salt: '0x...', iterations: 600000 } — already there
```

Reading it back never needs a decode function either — `Mnemonad`/`MnemonadItem` expose the
decoded form as a getter:

```javascript
ev.streamMeta;                 // { name: 'My Documents', kek: {...} }
(await ev.itemAt(0)).itemMeta; // { name: 'photo.jpg', type: 'image/jpeg' }
```

Both getters decode fresh on every access (the underlying `meta` bytes are immutable once
committed, so there's nothing to cache) and tolerate whatever's actually on chain: a legacy
plain-text stream name from before this JSON format existed decodes into `{ name, kek: null
}` rather than throwing; an item's own `meta` never falls back to treating non-JSON bytes as
a name (unlike a stream's), since it's a genuinely free-form field other tools can put
anything into.

`meta`/`itemMeta` (raw `Uint8Array`) are still there as the low-level escape hatch — pass
either directly and it wins outright over `name`/`type`/the auto-built `kek`, for a caller
that wants full control over the on-chain bytes instead. `encodeStreamMeta`/`decodeStreamMeta`/
`encodeItemMeta`/`decodeItemMeta` are exported too, for that same case (or for decoding
metadata you only have the raw bytes for, with no live instance at hand) — both return
`undefined` for an empty object, so storing neither name nor type costs nothing on chain,
same as before this format existed.

The stream-level `kek` block is what `unlockWithPassword` needs and is exactly why this
metadata format exists at all: a password KEK isn't owner-bound, so its salt and iteration
count have to live somewhere public for a later reader to find before ever entering a
password. This is that place — `unlockWithPassword` itself stays agnostic about where those
two values come from, since not every caller will keep them here (see that method's own
doc), but `create()`/`streamMeta` make it the path of least resistance.

## Encryption

See [`../docs/encryption/encryption.md`](../encryption/encryption.md) for a shorter,
non-API overview of both methods below; this section is the fuller SDK reference.

A random AES-256-GCM data key is always generated at `create()` time and stored, wrapped,
on-chain in `encKeyWrapped`. What differs is only *how it gets wrapped* — the
key-encryption key (KEK). Two methods exist:

**Signature-based** — self-wrapped under a KEK derived from the owner's own signature over a
message binding the chain id, contract and stream id. Nothing to remember and nothing public
to protect, but strictly owner-bound: lose the wallet and the data is gone, and no other
wallet can ever read it.

```javascript
const ev = await Mnemonad.create({
    publicClient,
    walletClient,
    contractAddress,
    encrypt: true,
    signer: walletClient,     // anything with signMessage(); a viem Account works too
});
await ev.push(secret);       // encrypted before it leaves the process
await ev.at(0);              // decrypted transparently
```

Creating one asks the wallet **twice** — first for the key signature, then for the create
transaction. Rejecting the second leaves nothing behind, and a retry re-derives the identical
key.

**Password-based** — the KEK is derived via PBKDF2-HMAC-SHA256 from a plaintext password
plus a per-stream salt, instead of a signature:

```javascript
const ev = await Mnemonad.create({
    publicClient,
    walletClient,
    contractAddress,
    encrypt: true,
    password: 'a strong passphrase',
    // Omit passwordSalt to have one generated for you. It (and the iteration count) get
    // published automatically in this stream's own metadata — see Metadata above — so a
    // later reader has everything unlockWithPassword needs; ev.crypto.getPasswordSalt()
    // is still there directly too, for a caller persisting it somewhere else instead.
});
await ev.push(secret);
await ev.at(0);
```

`passwordIterations` overrides the iteration count (default
`MnemonadCrypto.DEFAULT_PBKDF2_ITERATIONS`, 600,000 — OWASP's 2023 floor for
PBKDF2-HMAC-SHA256). Persist whatever value was actually used alongside the salt: raising
the default later must not change what an existing stream needs to unwrap. A password is
rejected outright if empty — `crypto: password must not be empty` — rather than silently
treated as "no password."

Because stream ids are deterministic, the id is known *before* creation — so create + key +
first push happen in **one transaction** either way, with no round trip needed first to
learn what id a create call would produce.

A third option, `aesKey`, hands over an already-unwrapped plaintext data key directly —
skipping unwrapping entirely. It's how a second party reads without either credential (there
is no delegation otherwise in v1) and how a UI caches an already-unlocked key for the rest of
a session without re-deriving it on every read.

A UI commonly doesn't have either credential up front, though — a stream loads read-only
first (no `password`/`signer`/`aesKey` at all), and only later does an "enter password"
prompt or an "unlock with wallet" click supply one. `unlockWithPassword(password)` and
`unlockWithSignature(signer)` handle that sequence in place on an already-constructed
instance: derive, verify (a wrong password throws — the wrapped key's GCM tag fails to
check out, rather than silently unwrapping garbage), and adopt the key, so every read
through that same instance decrypts from then on:

```javascript
const ev = new Mnemonad({ publicClient, contractAddress, id }); // no password yet
await ev.at(0); // ciphertext — nothing to decrypt with

// Salt/iterations default to this stream's own streamMeta.kek — the block create()
// already published when the stream was made — so the password is all a caller needs.
const aesKey = await ev.unlockWithPassword(userTypedPassword);
await ev.at(0); // plaintext, from here on
```

Pass `{ passwordSalt, passwordIterations }` explicitly to override, for a caller keeping
those two values somewhere other than this metadata format.

`unlockWithSignature(signer)` is the same move for a signature-keyed stream — one wallet
prompt instead of a password, and the key lands on the same instance:

```javascript
const ev = new Mnemonad({ publicClient, contractAddress, id });
await ev.unlockWithSignature(walletClient);
await ev.at(0); // plaintext, from here on
```

Passing `signer` to the constructor works too, but then the *first read* triggers a wallet
prompt at whatever moment it happens — while rendering a list, say. Unlocking explicitly
keeps that an intentional step.

Both unlocks throw with `err.code === 'KEK_MISMATCH'` when the credential doesn't unwrap the
key — a wrong password, or (for a signature stream) a wallet that isn't the owner. Neither
gates on the stream's published method: stream metadata is written once at creation and can
never be corrected, while `setEncKeyWrapped` lets an owner rewrap under a different method
afterwards, so the GCM tag is the only authority on whether a credential is the right one.

**Which method a stream uses** is published in its metadata as `kek.method`
(`'password'` | `'signature'`), and read back with `kekMethodOf({ kek, encrypted })` — which
also covers streams created before that marker existed, where an encrypted stream with no
`kek` block at all means the signature method:

```javascript
import { kekMethodOf } from 'mnemonad';

const method = kekMethodOf({ kek: ev.streamMeta.kek, encrypted: await ev.isEncrypted() });
// → 'password' | 'signature' | null (not encrypted)
```

A password stream's `kek` block also carries the `salt` and `iterations` a reader needs
before it can even prompt; a signature stream has nothing to publish beyond the method
itself.

### Framed ciphertext

Each item is encrypted as a sequence of independently-decryptable 64 KiB frames rather than
one GCM message. Without this, one tag would cover the whole ciphertext, so reading a single
byte of a 4 MB item would mean fetching and authenticating all 4 MB — random access would
work for plaintext items and silently not for encrypted ones.

```
header:  version(1) || log2FrameSize(1) || baseNonce(8)
frame i: GCM(key, baseNonce || u32be(i), plaintext_i, aad_i)   // includes 16-byte tag
aad  i:  version || isFinal || u32be(i)
```

Overhead is 10 bytes plus 16 per frame — 26 bytes for a small single-frame item, ~1 KB for
4 MB. `MnemonadCrypto.ciphertextLengthFor(n)` computes it.

Two properties the AAD buys, which naive framing lacks:

- **No reordering or replay across positions** — the frame index is authenticated, so a
  frame is only valid where it was written.
- **No truncation** — the final-frame flag is authenticated, so dropping trailing frames
  leaves a reader expecting a final frame it never sees.

This is the STREAM construction, as used by age and libsodium's secretstream. A reader needs
only the 10-byte header plus the on-chain item size to locate any frame, so no scan or trial
decryption is involved.

Limitations to know:

- **Signer-based is owner-bound.** Only the wallet that wrapped the key can unwrap it. No
  delegation, and losing the signing key loses the data. Password-based is *not*
  owner-bound — anyone with the password can unwrap, regardless of wallet — but the salt
  and iteration count are necessarily public (a reader has to find them somewhere before
  ever entering a password), so the password's own strength plus the iteration count are
  the only defenses against an offline brute force of a stolen wrapped key.
- **Encrypted streams cannot be transferred**, regardless of KEK method. The contract
  blocks it unconditionally — `isEncrypted()` only checks whether a wrapped key exists at
  all, not which method produced it. Lifting this needs the propose/accept rewrap flow,
  which is **not in v1**.
- **Prepaying an off-chain upload is automatic through `push()`.** For an item too big for
  one transaction with no `{ onChain: true }`, `push()` prepays through the registry's
  wired upload gateway before uploading — encrypting first if the stream is encrypted, all
  internally. A caller never encrypts, hashes, or pays anything itself:

  ```javascript
  await ev.push(bigPayload); // encrypts (if needed), pays the gateway (if one is wired),
                              // uploads, and commits the pointer — one call
  ```

  This is required, not just convenient, whenever the offloading provider is a
  `MnemonadPresignProvider`: its sign server unconditionally refuses to issue an upload URL
  without a matching escrow already open (see `presign-server/src/routes/uploadUrl.js`).
  Pass `{ payGateway: false }` to skip this and pay the registry's flat EXTERNAL fee
  instead — only useful with a provider that doesn't itself require a paid escrow.

  `pushExternal`/`offloadCommitment` are still there as the low-level primitives, for a
  caller that wants explicit control over the commit/pay/upload sequence — e.g. showing a
  price quote before committing, via `ev.quoteOffloadUpload(size)` (`null` when no gateway
  is wired at all; rejects, same as the gateway's own `quote()`, when one is wired but
  can't currently price a stale/uncertain oracle). On an encrypted stream, calling
  `offloadCommitment`/`pushExternal` directly still needs the same one extra step `push()`
  does automatically: encrypt first, then commit to *that* ciphertext, since every
  encryption draws a fresh nonce and a hash computed over plaintext in advance would never
  match what actually gets uploaded.

  ```javascript
  const quote = await ev.quoteOffloadUpload(plaintext.length); // show this before committing
  const ciphertext = await ev.crypto.encryptItem(plaintext);
  const { hash, size } = await ev.offloadCommitment(ciphertext, { alreadyEncrypted: true });
  await gateway.payForUpload(hash, size);
  await ev.pushExternal(ciphertext, { alreadyEncrypted: true }); // same bytes, not re-encrypted
  ```

## IPFS offloading

```javascript
const ev = new Mnemonad({
    publicClient,
    walletClient,
    contractAddress,
    id,
    gatewayUrl: 'https://ipfs.io/ipfs/',
    pinningUrl: 'https://api.pinata.cloud/pinning/pinFileToIPFS',
    pinningJwt: process.env.PINATA_JWT,
});

await ev.push(largeFile);    // > maxChunkBytes → pinned, pointer stored on-chain
const data = await ev.at(0); // fetched and hash-verified
```

Or supply a custom transport: `ipfsClient: { put(bytes) => cid, get(cid) => bytes, getRange?(cid, start, len) => bytes }`.
`getRange` is optional — without it, ranged reads fall back to whole-payload fetches, which
is correct but not cheap. Gateways are used via HTTP `Range:` requests, falling back the
same way when a gateway answers 200 with the full body instead of 206.

**Reads are hash-verified.** An IPFS gateway is an untrusted intermediary, so the contract
stores a sha256 of the payload and every read checks it before returning.

### Off-chain storage providers

The params above build a plain `MnemonadIpfs` under the hood — the generic case, and the
right one for a self-hosted node or an unlisted pinning service. Named services get a
preset instead, so their endpoint URLs don't need typing out:

```javascript
import Mnemonad, { MnemonadPinataProvider } from 'mnemonad';

const ev = new Mnemonad({
    publicClient, walletClient, contractAddress, id,
    offloadingProvider: new MnemonadPinataProvider({ pinningJwt: process.env.PINATA_JWT_TOKEN }),
});
```

`offloadingProvider` takes over from `gatewayUrl`/`pinningUrl`/`pinningJwt`/`ipfsClient`
entirely when given. Both `MnemonadIpfs` and `MnemonadPinataProvider` extend
`MnemonadOffloadingProvider` — the base every backend (IPFS today; a future Filecoin or
Walrus provider, or your own) implements: `putBytes`/`readPointerBytes`/
`readPointerRange`/`verifyAvailability`/`repin`, plus a `static codec` reporting which
`Pointer.codec` value its pointers use (`Codec.IPFS` for anything CID-based, regardless of
which service pinned it — a genuinely different retrieval mechanism, like a raw Filecoin
deal, would need its own value). `attach(mnemonad)` — not a constructor param — is what lets
a provider be built and configured before a `Mnemonad` exists at all.

`MnemonadPinataProvider` adds two things beyond the base contract: `unpin(cid)`, matching
Pinata's own delete endpoint — not universal, most off-chain backends have no equivalent of
"delete", and this one deliberately doesn't pretend to reclaim anything on-chain, it only
stops Pinata from continuing to serve the content — and `mintUploadJwt`, below.

**Shipping a real, standing Pinata JWT in a frontend bundle is a real credential leak.**
`pinningJwtProvider` — resolved fresh before every upload instead of a static `pinningJwt`
— plus the `static mintUploadJwt` method implement Pinata's own documented signed-upload
pattern: a narrow, single-use-by-default key minted per upload, so intercepting one in
flight is worth at most one upload rather than standing access to the account.

```javascript
// server-only — adminJwt must never reach a browser bundle:
app.post('/api/pinata-temp-key', async (req, res) => {
    const jwt = await MnemonadPinataProvider.mintUploadJwt(process.env.PINATA_ADMIN_JWT);
    res.json({ jwt });
});

// frontend:
const provider = new MnemonadPinataProvider({
    pinningJwtProvider: () => fetch('/api/pinata-temp-key').then((r) => r.json()).then((j) => j.jwt),
});
```

`mintUploadJwt` itself is a plain `fetch` — nothing about the function stops it being called
from a browser, which is exactly the mistake this pattern exists to avoid. Its safety is
entirely about *where* it's called from, not what it does.

#### Browsers: `MnemonadPresignProvider`

Both options above still require a credential somewhere in reach of the client. For a
browser, use `MnemonadPresignProvider`, which holds none — it asks a server for a one-shot
upload URL per payload:

```js
import { MnemonadPresignProvider } from 'mnemonad';

const provider = new MnemonadPresignProvider({
    gatewayUrl: 'https://gateway.pinata.cloud/ipfs/', // reads need no credential
    requestUploadUrl: async ({ hash, size }) => {
        // Your server decides whether this caller has earned a URL. See
        // `presign-server/` in this repo, which gates on paid on-chain escrow.
        const res = await fetch('/api/upload-url', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hash, size }),
        });
        return await res.json(); // { url }
    },
});
```

The payload's sha256 is computed once and handed to the callback, because a server issuing
URLs against a content commitment needs that hash anyway — recomputing it would hash the
same bytes twice per push. Reads are inherited from `MnemonadIpfs` unchanged, including
hash verification.

### Ranged reads of off-chain items

Encrypted external items support real random access: the ciphertext length comes from the
on-chain pointer and only the 10-byte header plus the covering frames are fetched. A 2 KB
read of an 8 MB encrypted IPFS item transfers under 128 KB.

The integrity story splits, and the split is deliberate:

| Read | Verified by |
|---|---|
| Full read (`at()`) | The pointer's blob sha256 — fetched whole, then verified before its header is even consulted |
| Ranged read, **encrypted** | The frame's own GCM tag, with index and finality authenticated. The blob hash adds nothing a frame tag doesn't already give |
| Ranged read, **plaintext** | Nothing. So these fetch whole and verify by default; pass `allowUnverifiedRanges: true` to opt into cheap-but-unchecked partial fetches |

**Availability depends entirely on continued pinning.** There is no on-chain rent and no
expiry, so there is deliberately no on-chain-managed extension mechanism.
`offloadingProvider.verifyAvailability()` and `offloadingProvider.repin()` are the
substitutes — off-chain probes with no guarantee behind them.

## Reading large items

Reads are free — `eth_call`, no gas paid, no signature, no state change. But a single `at()`
allocates the whole item and the ABI return copies it, so it needs roughly **2× the item
size** in memory. Against Monad's 8 MB per-transaction cap that bounds a one-shot read near
3–4 MB, and the limit is memory, not gas.

So `at()` **pages automatically** above `readPageBytes` (default 512 KB) and reassembles the
result, which removes the ceiling entirely. For explicit control:

```javascript
const slice = await ev.readRange(0, offset, len);   // ranged read, on-chain or off
const ev2 = new Mnemonad({ ...params, readPageBytes: 128 * 1024 });
```

Encrypted items support the same random access, because their ciphertext is **framed** — see
below.

To consume an item without ever holding it whole:

```javascript
for await (const piece of ev.stream(0, { start: 0, len: 1024 })) { /* ... */ }
```

`stream()` yields one frame (encrypted) or one page (plaintext) at a time, so an item larger
than available memory can be walked end to end. `plaintextLengthAt(i)` gives the decrypted
length, which differs from the stored `itemSize` for encrypted items.

Read cost of `at()` on Monad testnet (simulated gas; nobody pays it, but the node meters it
against the `eth_call` cap — 200M on Monad's public RPCs):

| Item size | Chunks | Read gas | gas/byte |
|---:|---:|---:|---:|
| 391 B | 1 | 44,900 | 115 |
| 25 KB | 1 | 50,360 | 1.99 |
| 59 KB | 1 | 57,794 | 0.97 |
| 128 KB | 2 | ~106,000 | 0.81 |
| 512 KB | 8 | ~298,000 | 0.57 |

Single-chunk rows are cold reads of real items. Multi-chunk rows are estimates: measured
warm, plus the cold loads the single-chunk reads show (~42,000) and 10,000 per extra chunk
for its cold account access (full method in [gas on Monad testnet](../gas.md)).

A read costs a fixed ~42,000 of cold page and account loads, then about 0.25 gas/byte, so
the per-byte figure keeps falling with size. Monad prices memory linearly at half a gas per
32-byte word — a 1 MB buffer costs ~16,000 rather than Ethereum's quadratic ~2.2M — which is
why large reads stay cheap. Locally, EDR uses the Ethereum formula, so the SDK's own tests
see 1 MB reads near 9M gas; that's an artifact of the test node, not what Monad charges.

## Cost estimation

```javascript
const { gas, gasCost, fee, total } = await ev.estimatePushCost(data);
```

Worth calling before large writes. Monad charges the gas **limit**, not gas used, so a loose
estimate is a direct overcharge rather than a harmless margin.

## Version safety

The SDK reads `CONTRACT_VERSION` on first use and **refuses to operate** on a mismatch. This
is not defensive padding: the contract is immutable and testnet deployments are disposable,
so several versions will coexist, and an SDK that decoded a struct whose layout had moved
would return plausible nonsense. `ids.js` is keyed by `(network, version)`.

## Testing

```bash
pnpm test
```

Split by scale and by concern, because the interesting failures differ by size — "a few
items", "a lot of bytes" and "more bytes than one call can return" break in unrelated ways:

| Suite | Chunk ceiling | Covers |
|---|---|---|
| `base.test.js` | 2 KB (small, so the staged path is cheap to reach) | Tiers, packing, staged append, concat, truncate, burn, fees, access control, `estimatePushCost` (including its encrypt-first routing and itemMeta calldata), `streamMeta`/`itemMeta` getters, and the `create`/`push`/`estimatePushCost` `name`/`type` sugar (never calling `encode*Meta` directly, raw `meta`/`itemMeta` still winning when given) |
| `large_data.test.js` | 24 KB (realistic) | 1 MB staged on-chain across 44 chunks, 16 MB via IPFS, 60-item packed batch, 128-slot page boundary, staged-push `onProgress` |
| `huge_data.test.js` | 24 KB | 4 MB on-chain — past what one-shot reads can serve; paged reads and `readRange` slicing |
| `encrypted_small.test.js` | 2 KB | Key wrap/unwrap, per-stream derivation, wrong-signer rejection, nonce uniqueness, GCM tamper detection, tier crossings caused by the 26-byte framing overhead, every write path encrypting |
| `encrypted_password.test.js` | 2 KB | The password KEK method alongside `encrypted_small.test.js`'s signature one: derivation, salt/iteration handling, `unlockWithPassword` (defaulting to `streamMeta.kek` with just a password, an explicit-salt override, wrong password, no wrapped key, no salt anywhere), every write path still encrypting, and unlocking end to end using nothing but the password |
| `encrypted_large.test.js` | 24 KB | 256 KB staged encrypted, 1 MB encrypted via IPFS, chunk boundaries crossed by overhead alone |
| `encrypted_huge.test.js` | 24 KB | 4 MB encrypted — partial decryption, streaming, frame-integrity (reorder/truncation), ranged off-chain reads, 8 MB via IPFS |
| `mixed_tiers.test.js` | 2 KB | SLOT + CODE + multi-chunk + EXTERNAL interleaved in one stream: per-tier dispatch of `at`/`readRange`/`getItemRefs`, `binaryLength` across tiers, concat preserving tiers, and the same encrypted |
| `item_refs_batch.test.js` | 2 KB | `getItemRefsBatch`/`itemsAt` — matches N individual calls (order-preserving), collapses into exactly one client call, skips already-cached indices |
| `list_owned.test.js` | 2 KB | `Mnemonad.listOwned()` — empty case, multiple streams, cross-owner isolation, reflecting a transfer |
| `rate_limiter.test.js` | n/a | `MnemonadRateLimiter` — no-op default, throttling and FIFO ordering, `wrapClient`, and the constructor's `maxRPCRequestsPerSecond` sharing one budget across instances |
| `rate_limiter_retry.test.js` | n/a | The retry half of `MnemonadRateLimiter` — backoff schedule asserted with injected timing, not real waits |
| `shared_contract_constants.test.js` | default | `CONTRACT_VERSION`/`maxChunkBytes` read once per chain+contract, not once per `Mnemonad` instance |
| `custom_offloading_provider.test.js` | 2 KB | A from-scratch `MnemonadOffloadingProvider` subclass, unrelated to `MnemonadIpfs` — proves `offloadingProvider` wiring, a non-standard `codec`, oversized-push routing, and the inherited `_verify` hash check all work for a genuinely third-party provider, not just the SDK's own |
| `push_external_auto.test.js` | 2 KB | `push()`'s automatic gateway-payment for an oversized off-chain item (`_pushExternalAuto`) against a real deployed `MnemonadUploadGateway` — encrypt-then-commit ordering, `onProgress`, `{ payGateway: false }`, the no-gateway-wired fallback, and `quoteOffloadUpload` |
| `upload_gateway_chain.test.js` | n/a | Regression: the `chain` field reaching viem correctly on a gateway write (`undefined` vs `null` vs an explicit chain mean three different things to viem) |
| `write_gas_estimate.test.js` | n/a | Regression: `_write` always supplies an explicit, simulation-derived `gas` limit rather than trusting a connected wallet's own estimate |
| `chunk_cache.test.js` | n/a | Pure unit tests of `MnemonadChunkCache` itself against both backends (in-memory `Map` and a real IndexedDB via `fake-indexeddb`) — no chain, no node |
| `chunk_cache_wiring.test.js` | 2 KB | Proves the chunk cache is actually consulted end to end against a real node — on-chain and off-chain payloads, encrypted items via `at()`, the `readPageBytes` size cutoff, and that a genuinely partial `readRange()` stays uncached |
| `cache_is_safe.test.js` | 2 KB | The chunk cache's one hard invariant: never holds decrypted plaintext for an encrypted stream, across every tier and both read paths (`at()` and `itemAt().bytes()`) |
| `rpc_recorder.test.js` | n/a | `MnemonadRpcRecorder` — opt-in (`debug: true`) call log/count backing the explorer's RPC panel: pending-then-settled notifications, cross-instance sharing, the 2000-entry cap |
| `meta_codec.test.js` | n/a | Pure unit tests for `metaCodec.js`/`streamMeta.js`/`itemMeta.js` — the gzip-or-plain size choice (measured, not assumed), tolerant decoding of legacy plain-text and of a JSON array/non-object, and the `undefined`-for-empty convention |

Note what large-data testing **cannot** cover locally: EDR enforces EIP-170's 24,576-byte
code limit, so a single chunk never exceeds ~24 KB here. Monad allows 128 KB. Chunk count
and reassembly are proven locally; the per-chunk size ceiling is testnet-only.

Tests boot a Hardhat node as a child process, deploy a fresh registry, and exercise the SDK
against it. The IPFS layer runs against an in-memory transport, so **no network access is
needed** — with one deliberate exception:

```bash
pnpm test:real-ipfs
```

`real_ipfs.test.js` exercises the actual upload path against a real Pinata account —
round trip, a genuine ranged `206` fetch, `repin()`'s CID-determinism assumption, hash-
mismatch detection on real fetched bytes, an upload via `pinningJwtProvider` +
`mintUploadJwt`'s real signed-JWT flow, and confirmation that Pinata actually enforces a
minted key's `maxUses: 1` (a second upload with the same spent key really does fail) — none
of which an in-memory mock can prove. It's excluded from the default `pnpm test` glob (see
`vitest.config.js`) and needs its own config (`vitest.real-ipfs.config.js`) to be reachable
at all, so a machine with `PINATA_JWT_TOKEN` configured in `.env` never spends real quota
just by running the normal suite. Without that token it skips cleanly rather than failing —
safe for anyone else to run.

Each run picks a free port and boots its own node. To reuse one you already have running,
point the suite at it explicitly — auto-detection raced against nodes from previous runs:

```bash
cd ../contracts && npx hardhat node --port 18545
# then, in the js dir:
EV_TEST_RPC_URL=http://127.0.0.1:18545 pnpm test
```

After changing the Solidity sources, regenerate the ABI:

```bash
cd ../contracts && pnpm build && cd ../scripts && node sync_abi.js
```

## License

AGPL-3.0
