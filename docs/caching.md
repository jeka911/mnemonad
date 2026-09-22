# Item caching

The SDK caches everything about an item that's immutable once written — its metadata
(store/tier, size, chunk locations, off-chain pointer) and its payload bytes — so reading the
same item twice, even from a brand-new `Mnemonad` instance after a page reload, costs zero
RPC calls once it's been read once. This applies equally to an encrypted stream's items —
what's cached is always the ciphertext, decrypted fresh on every call (see the design rule
below) — with one size caveat: an on-chain item bigger than `readPageBytes` can't be fetched
in a single call at all, so it's paged instead and isn't cached (see "What's out of scope").

Implemented in [`js/MnemonadChunkCache.js`](../js/MnemonadChunkCache.js); wired into
[`js/Mnemonad.js`](../js/Mnemonad.js) and
[`js/offloading/MnemonadIpfs.js`](../js/offloading/MnemonadIpfs.js). See
[`encryption/encryption.md`](encryption/encryption.md) for how a stream gets encrypted in
the first place.

## The one rule that decides the whole design

**It stores bytes exactly as fetched from chain or IPFS, before any decryption.** Every read
that populates it hands it pre-decryption bytes — ciphertext for an encrypted stream,
plaintext for an unencrypted one — and `Mnemonad.at()` decrypts one layer above, on every
call, never storing the result. `MnemonadItem.bytes()` delegates to `at()` for its own actual
content (see `MnemonadItem.js`'s own doc) rather than reading the cache directly, so this
holds regardless of which of the two a caller reaches for — the only thing `MnemonadItem`
caches itself is the *decrypted* result, in memory, on that one instance (see `isLoaded`
below), never in the durable cache this file describes. Caching post-decryption plaintext
durably would mean decrypted content sitting in local storage (IndexedDB, specifically)
indefinitely, which is exactly the exposure encrypting a stream is meant to avoid. Caching the
as-stored bytes changes nothing security-wise: that data is already public on-chain or on
IPFS regardless of who caches a copy of it locally.

## What gets cached, and how each is keyed

| What | Where it's cached | Key scheme | Why that scheme |
|---|---|---|---|
| On-chain payload | `Mnemonad._readItemBytes` — the shared small-item fast path both `Mnemonad.at()` and `_atRaw()` (its unencrypted fallback) call into, within `readPageBytes`. `MnemonadItem.bytes()` reaches it only indirectly, by delegating to `at()` | `onchain:{chainId}:{contractAddress}:{streamId}:{index}` | Location-addressed — nothing on-chain gives a content hash cheaply *before* fetching, unlike an EXTERNAL item's pointer. |
| Off-chain (IPFS) payload | `MnemonadIpfs.readPointerBytes` | `ipfs:{pointerHash}` | Content-addressed — the pointer's sha256 is already known from the on-chain `Pointer` before ever touching IPFS. |
| Item refs (tier/size/chunk addresses) | `Mnemonad.getItemRefs` / `getItemRefsBatch` | `refs:{chainId}:{contractAddress}:{streamId}:{index}` | Location-addressed, immutable once committed — append-only; `concat`/`truncateFrom` never mutate an existing item's own record. |
| EXTERNAL pointer (the CID) | `Mnemonad.pointerAt` | `pointer:{chainId}:{contractAddress}:{streamId}:{index}` | Separate from the payload's own content-addressed key — this is what a caller needs *before* it can even look the payload up. |

All four share one cache instance and one key namespace, just with different prefixes, so
they can never collide with each other.

Together, this is what lets a fully-cached item — on-chain or off-chain — cost **zero** RPC
calls end to end: refs tell you the tier and size, the pointer (if EXTERNAL) tells you where
the bytes live, and the payload cache serves the bytes themselves. `itemAt()` and
`getItemRefsBatch()` both check the cache first and only ever fetch what's actually missing —
a batch request that's a mix of cached and uncached indices only asks the chain about the
uncached ones.

### A hit still gets verified — never blindly trusted

Off-chain payload reads run a cache hit through the exact same hash check a network fetch
gets (`MnemonadOffloadingProvider._verify`) before returning it. A corrupted or tampered local
cache entry is caught by the check that already exists for untrusted gateways, rather than
needing a separate one.

### One caller deliberately bypasses the cache

`offloadingProvider.verifyAvailability({ verify: true })` exists specifically to answer "is
this retrievable from the remote store *right now*" — a cache hit would answer a different,
useless question, since it says nothing about whether the remote copy still exists. It passes
an explicit `{ skipCache: true }` to `readPointerBytes` for exactly this reason; every other
caller goes through the cache normally.

## What's out of scope

Whole-item bytes only, and only up to `readPageBytes` (default 512 KB) for an on-chain item —
`_readItemBytes` is a single, unpaged contract call, and asking it for more than that risks
the call itself running out of gas, not just holding too much in memory. Above that size,
`Mnemonad.at()` falls through to the streaming frame-by-frame path (paging via `readRange`),
same as it did before whole-item on-chain caching existed for encrypted reads — genuinely
large items were never the target here, since the whole point of framing is to make them
readable without holding the whole thing in memory to begin with. Partial byte-range reads
(`readRange`, and `stream(i, {start, len})` for anything narrower than the whole item) are
not cached either, regardless of size — caching a range would mean coalescing overlapping
spans, real complexity this doesn't take on. Reading any part of an item still populates the
*whole-item* cache the first time it's read in full, same as always.

## Backend: IndexedDB in a browser, an in-memory Map elsewhere

Auto-detected via `typeof indexedDB !== 'undefined'`. In Node (scripts, the presign server,
tests against a local hardhat node) there's no IndexedDB, so it falls back to a plain `Map` —
same eviction rules, just not durable across a process restart. Worth it regardless: still a
free win within one script or test run instead of caching nothing at all there.

Both backends implement the same small interface (`getEntry`/`putEntry`/`deleteEntry`/
`touchEntry`/`listEntriesByAccess`/`clear`) so all the eviction/business logic lives once, in
`MnemonadChunkCache` itself, not duplicated per backend.

## Eviction

LRU by last access, tracked as a monotonically increasing counter rather than `Date.now()`
directly — two accesses inside the same millisecond are routine, and millisecond resolution
would make a touch indistinguishable from the original write, silently defeating the point of
touching an entry on read. The counter is seeded from `Date.now()` at module load so values
stay meaningful across a reload (a fresh session's counter starts at real current time, always
at least as large as anything the last session produced).

No separate running total is kept anywhere — both `stats()` and eviction recompute
`entryCount`/`totalBytes` by listing every entry. Deliberate: at the scale `maxEntries` is
designed for (a few hundred), a full scan costs nothing worth avoiding, and it sidesteps any
consistency question between an incremental counter and the entries it's supposed to describe.

- Over `maxEntries` or `maxTotalBytes` after a write → oldest-by-last-access entries are
  evicted until back under both.
- Over `maxEntryBytes` on its own → that entry is never cached at all. It does **not** evict
  anything else to make room for itself — a single huge item shouldn't be able to push
  everything else out of the cache.
- Any storage error (quota, private-browsing restrictions, whatever) → swallowed. Caching is a
  pure optimization; a failure here must never make a real read fail. `get()` resolves to
  `undefined` on any failure (a miss), `set()` resolves regardless of whether the write landed.

## Defaults, and how to override them

```js
{
  maxEntries: 300,
  maxTotalBytes: 50 * 1024 * 1024,  // 50 MB
  maxEntryBytes: 8 * 1024 * 1024,   // 8 MB — reuses the number Mnemonad.readPageBytes's own
                                     // comment already cites (Monad's per-tx memory cap),
                                     // rather than inventing an unrelated one
  namespace: 'default',
}
```

Passed via `new Mnemonad({ cacheOptions: { ... } })` — same `{...DEFAULTS, ...overrides}`
pattern `estimatePushCost`'s `bufferPercent` already uses.

`params.cache` on the `Mnemonad` constructor:

| Value | Effect |
|---|---|
| omitted | The shared default for whatever `cacheOptions` were given (see below). |
| `false` / `null` | Caching disabled entirely — every read hits the chain or IPFS. |
| an object with `get(key)`/`set(key, bytes)` | Used exactly as given, **not** shared with anything else. |

## Shared, not per-instance

Two `Mnemonad` instances configured with identical `cacheOptions` share one cache instance,
keyed by a canonicalization of those options (same pattern as the shared rate limiter,
`_getSharedRateLimiter`). This is deliberate: IndexedDB durability is the whole point, and a
cache scoped to one instance would defeat it by dying with that instance. Different options —
or an explicit `namespace` — get their own cache, letting an app isolate caches on purpose
rather than only by accident of differing options (tests do exactly this, giving each test its
own namespace).

## API

```js
import { MnemonadChunkCache, DEFAULT_CHUNK_CACHE_OPTIONS } from 'mnemonad';

const cache = new MnemonadChunkCache({ maxEntries: 500 });
await cache.get(key);           // Uint8Array | undefined, never throws
await cache.set(key, bytes);     // resolves either way
await cache.clear();             // drop everything — a "clear cache" UI action, or test cleanup
await cache.stats();             // { entryCount, totalBytes }
```

`get`/`set` are the only two methods `Mnemonad` itself calls — a custom `params.cache` object
only needs to implement those two.

## Testing

- Pure unit tests (`js/test/chunk_cache.test.js`) run against both backends — the in-memory
  Map directly, and a real IndexedDB via [`fake-indexeddb`](https://www.npmjs.com/package/fake-indexeddb)
  injected through `options.indexedDB` rather than polluting `globalThis`, so tests stay
  isolated from each other.
- Wiring tests (`js/test/chunk_cache_wiring.test.js`) run against a real local node, proving
  the cache is actually consulted — not just that the class works in isolation — by counting
  real `readContract` calls before and after a cache hit, for both on-chain and off-chain
  items, including the zero-RPC-call fully-cached case and the `verifyAvailability` bypass.
  A dedicated `describe('encrypted items via at()')` block covers the encrypted-on-chain
  path specifically: cache sharing with the unencrypted path (same key, ciphertext either
  way), a warm refs cache reducing a repeat `at()` call to zero RPC calls, the
  `readPageBytes` size cutoff still routing large items to the uncached paged path, and
  that a genuinely partial `readRange()` still isn't cached — the one true regression check
  in that list, confirming a documented-as-out-of-scope case didn't quietly change.
- Safety tests (`js/test/cache_is_safe.test.js`) prove the "one rule" above holds in
  practice, not just in the wiring above — the previous two files each prove a narrower
  thing (a hit skips the network; the class works in isolation) that would both stay green
  even if plaintext leaked into the cache. This file reaches directly into the cache
  backend after real reads, across every tier (SLOT, CODE, EXTERNAL) and both call sites
  that populate it (`at()` and `itemAt().bytes()`), and scans every entry byte-for-byte
  against every plaintext that went in — plus a deliberate control case on an *unencrypted*
  stream, where the same scan is expected to find a match, proving the technique itself
  isn't vacuously passing.
