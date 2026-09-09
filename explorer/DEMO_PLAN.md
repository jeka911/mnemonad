# Mnemonad demo — explorer integration plan

Plan for adding a Mnemonad demo surface to the Vue explorer app. Upload files or
text as chunks, browse the resulting on-chain structure, with every on-chain entity linked
out to the Monad block explorer.

Status: **plan only, nothing built.** The immediate next slice — home page: list the
connected wallet's streams, button to create one — is scoped in §1.6 below; everything else
(upload, browse, per-item detail) is unchanged future work.

Related: the root [`README.md`](../README.md) (contract + SDK overview).

---

## 0. What the app already is

| Aspect | Reality |
|---|---|
| Stack | Vue 3 + Quasar 2 + Pinia + vue-router, Vite 5 |
| Chain | `@wagmi/vue` + `@wagmi/core` + viem, single-chain config built from the active network |
| Component style | **Options API**, tabs for indent, single quotes, `methods: { name: function() {} }` |
| UI primitives | `GradientPanel` (variants: `fill` `beam` `pink` `teal` `corner` `streak`; flags `high` `dense` `inline` `always-expanded` `collapsible` `loading`), `GradientButton` (`label` `size` `icon` `loading` `disable` `round`), plus `themed_varmory` J-components |
| Routing | **Pages self-register.** `pages/index.js` globs `./*.vue` and reads `path` / `title` off the default export. No central route table. |
| Theming | Custom Monad theme, dark by default, CSS vars (`--q-text`, `--q-text-muted`, `--q-text-bright`, `--q-surface-border`, `--q-positive`, `--q-info`, `--font-mono`, `--font-display`) |
| Existing chain-read pattern | `stores/wallet.js` uses `@wagmi/core` actions (not composables) so state is usable anywhere; `BlockNumber.vue` is the reference read-and-display component |
| Not-deployed pattern | `Home.vue` already renders a `GradientPanel variant="beam"` fallback when `contractAddress` is null. Reuse it. |

Two details worth noting because they shape the work:

- **There is no nav menu.** The header holds only the logo plus status/wallet controls. `/docs`
  and `/showcase` are reachable by URL alone. A new page needs a nav entry, or a link from
  `Home.vue`, or nobody will find it.
- **`batch: false` is already set in `wagmi.js`**, with a comment that Monad's Multicall3
  reverts on expensive wrapped reads even when the same call succeeds unwrapped. Mnemonad's reads are also expensive (a `readRange` walks chunk addresses and does
  `EXTCODESIZE` per chunk), so this existing setting is load-bearing for us. Do not turn
  batching back on.

---

## 1. Blockers to clear first

### 1.1 Nothing is deployed — RESOLVED, but a redeploy is now needed

Mnemonad v1 was live on Monad testnet at `0x56648542A6246b0FfeD6E3e139aaF38b63D50157`
(block `59415578`). That deployment predates the `ERC721Enumerable` switch (§1.6.1) — its
bytecode has no `tokenOfOwnerByIndex`/`balanceOf`-based listing, so `Mnemonad.listOwned()`
needs a fresh deploy before this slice has anything real to talk to.
`scripts/deploy_testnet.js` / `scripts/deploy_mainnet.js` exist (see root `scripts/`
package) for that; `js/ids.js` gets overwritten with the new address the same way it was
the first time.

### 1.2 `settings.js` points at a different contract — RESOLVED

The MonopolyxCanvas leftovers are gone; `NETWORKS[*]` in `settings.js` carries no
`contractAddress` at all anymore, just `chain` and `faucetUrl`. There is nothing to
disambiguate from — the app reads the Mnemonad address straight from `js/ids.js` (see §1.6),
not from `settings.js`.

### 1.3 Wiring the SDK into the build

The SDK is **browser-safe as written** — verified: no `require`, no `process`, no `node:`
imports, no `Buffer`. It uses `crypto.getRandomValues`, `TextEncoder`, `fetch`, `FormData`
and `Blob`, all of which the browser has.

Two small build changes:

```js
// vite.config.js
resolve: {
    alias: { '@mnemonad': path.resolve(__dirname, '../js/index.js') },
},
```

```bash
pnpm add @noble/ciphers @noble/hashes
```

(viem is already a dependency, and it is the SDK's only peer.)

A pnpm workspace link is the alternative, but `explorer/pnpm-workspace.yaml` currently
declares only `allowBuilds` with no `packages` key, so adding one would restructure the
lockfile for little gain. The alias is smaller.

### 1.4 Bridging wagmi to the SDK's client params

`Mnemonad`'s constructor wants a viem `publicClient` and (for writes) a viem `walletClient`
(see `js/index.d.ts`'s `MnemonadParams`). The app has neither directly — it has a wagmi
`config` (`wagmi.js`) and a connected account (`stores/wallet.js`). The bridge already
exists in the dependency that's already installed:

```js
import { getPublicClient, getWalletClient } from '@wagmi/core';
import { config } from './wagmi';

const publicClient = getPublicClient(config);
const walletClient = await getWalletClient(config); // throws if no wallet connected
```

Both return real viem client objects bound to the active chain/account — no custom
`sendTransaction` adapter needed, no separate viem client to construct or keep in sync with
whatever the wallet is doing. Confirmed both functions exist in the installed `@wagmi/core`
version. This is the one fact that makes "tie the SDK to the explorer" mechanical rather than
speculative — everything in §1.6 below builds on it.

### 1.5 (superseded — see §1.6.1)

Originally: add a `deployedAtBlock` field to `js/ids.js` to bound a `StreamCreated`
`getLogs` scan. **No longer needed** — §1.6.1 below now uses `ERC721Enumerable`'s on-chain
index instead of an event-log scan, so there is no log range to bound.

---

### 1.6 Home page: owned streams + create button

This is the concrete next slice: replace `Home.vue`'s `todo` body with a list of the
connected wallet's streams and a button to create a new one. Everything else in this document
(upload, browse, per-item detail, `/mnemonad` page) is unchanged, later work — this section
answers §10's open question 5 (yes, home page, not a separate route) for this slice only.

### 1.6.1 Enumeration: `ERC721Enumerable` — decided and shipped

Originally scoped as an off-chain `StreamCreated` event scan (deterministic ids mean plain
`ERC721` has no `0..totalSupply` walk that finds them). **Superseded:**
after measuring the real cost (`create()` +89,563 gas/+169%, `transferFrom()` +24,009
gas/+76%, +928 bytes code, `push`/`pushMany`/`pushExternal` unaffected
for the full breakdown), the registry now inherits `ERC721Enumerable` instead. That trades a
one-time, permanent per-mint/transfer gas cost for a listing that is always exactly current
(no transferred-away/received-via-transfer drift to reason about, no log range to bound, no
reconciliation logic) — already live in `contracts/src/Mnemonad.sol` and wrapped by the SDK:

```js
const ids = await Mnemonad.listOwned(publicClient, contractAddress, owner);
// bigint[] — every stream `owner` currently holds, read straight from
// balanceOf/tokenOfOwnerByIndex, pinned to one block (see the method's own doc comment for
// why: viem caches getBlockNumber() for ~4s by default, so a naive pin can be stale without
// any sign of it — listOwned passes `cacheTime: 0` to avoid that).
```

`stores/mnemonad.js` (§1.6.3) calls this directly. No event scanning, no `deployedAtBlock`,
no per-id `ownerOf` reconciliation — `Mnemonad.listOwned()` is the whole enumeration step.

### 1.6.2 Components

Scoped down from §4's eventual eleven-component browse/upload surface — just what this slice
needs:

```
explorer/src/mnemonad/
  MyStreams.vue           # the list: disconnected / loading / empty / row states
  CreateStreamDialog.vue  # q-dialog, mirrors WalletConnect.vue's modal pattern
stores/
  mnemonad.js              # pinia store: SDK client wiring + stream list, mirrors stores/wallet.js
```

`Home.vue` changes from its current `todo` body to rendering `<MyStreams />` inside the
existing `GradientPanel`.

### 1.6.3 `stores/mnemonad.js`

Same shape as `stores/wallet.js` — plain `@wagmi/core` actions, not composables, so it's
usable outside component setup:

- `mnemonadAddress` read once from `js/ids.js` at module load (same pattern `wagmi.js` uses
  for `getActiveNetwork()`)
- `streams: []`, `loading`, `error` state
- `fetchOwnedStreams()` — calls `Mnemonad.listOwned()` (§1.6.1), keyed off the wallet store's
  `address`; re-run on `walletStore.connectionId` change (wallet or network switch)
- `createStream({ name, items })` — builds a random `salt`, calls
  `Mnemonad.create({ publicClient, walletClient, salt, meta, array: items })` (see
  `js/index.d.ts`'s `CreateParams`), awaits the receipt, appends the new id locally rather
  than re-running the whole log scan

### 1.6.4 Create-stream flow, v0 scope

- Button opens `CreateStreamDialog` (same `q-dialog` + `JPanel` shape as `WalletConnect.vue`)
- One optional text field ("name"), UTF-8 encoded into `streamMeta` — good enough to tell
  streams apart in the list before per-item browsing exists
- **No encryption toggle yet.** Encryption needs a `signer` adapting wagmi's `signMessage`
  (`js/index.d.ts`'s `MnemonadParams.signer`) plus copy explaining the signature prompt and
  that an encrypted stream can never be transferred — real scope, belongs with §8's
  encryption work, not this slice

  > **Shipped differently:** an encryption toggle now exists in `CreateStreamDialog.vue` —
  > password-based, not the wagmi-signer approach sketched above (see `MnemonadCrypto.js`'s
  > `password`/`passwordSalt`/`passwordIterations`). `streamMeta` is no longer a plain
  > UTF-8 name string either — see `explorer/src/mnemonad/streamMeta.js`, which encodes
  > `{ name?, kek?: { method, salt, iterations } }` as JSON (falling back to treating
  > non-JSON content as a legacy plain name, so nothing pushed under the old format breaks).
- Disabled + tooltip when `walletStore.wrongNetwork` is true, same guard the rest of the app
  already uses
- On success: close dialog, append the new stream to the list, no navigation (no detail page
  exists yet — see 1.6.5)

### 1.6.5 What a list row does when clicked

No per-stream detail page exists yet (that's §6's future work). For this slice, a row shows
id (truncated) + item count + an encrypted badge if `encKeyWrapped` is set, and links out to
the connected chain's block explorer token page rather than anywhere in-app — reusing §7's
already-flagged open question (Monadscan vs `testnet.monadexplorer.com` token URL shapes
differ and need verifying). Building `ExplorerLink.vue` now, minimal (`address` type only,
`token` type deferred until the shape is confirmed), still saves work later.

### 1.6.6 States

- **Disconnected** — reuse the `Home.vue` not-deployed-state visual language, but for
  "connect a wallet to see your streams," with a `WalletConnect` button inline
- **Loading** — skeleton rows, not a spinner (design skill §4.5)
- **Empty** (connected, zero streams) — friendly empty state, create button front and center
- **List** — rows per §1.6.5, create button stays visible (not just in the empty state)
- **Error** (RPC failure) — inline retry, not a toast (toasts are for transient events, not
  a failed initial load)

---

## 2. Where the design skill applies (and where it does not)

`design-taste-frontend` §13 puts **dashboards and dense product UI out of scope**, and that
is exactly what this is: an inspector with tables, per-item detail, hex dumps and
transaction progress. So its landing-page rules (hero discipline, eyebrow rationing,
section-layout variety) do not apply here.

What does carry over and will be honored:

- No em-dashes anywhere in visible strings (§9.G)
- One theme, one accent, one radius scale — inherit the app's existing Monad theme rather
  than introducing a second visual language (§4.11, §4.2, §4.4)
- Icons from an allowed library only. The app already ships
  `@quasar/extras/material-icons`, so use those (`open_in_new`, `upload_file`, `description`)
  and hand-roll nothing (§3.C, §9.E)
- Full interactive states: loading skeletons, empty state, error state (§4.5)
- Button and form contrast at WCAG AA (§4.5)
- `prefers-reduced-motion` honored on any progress animation (§6.B)

In effect this is a **"redesign - preserve"**: match `GradientPanel` / `GradientButton` /
Quasar grid conventions exactly, add no new design system.

---

## 3. The demo's actual point

A naive version would be a file input and a list of items. That hides everything
interesting. Mnemonad's substance is the **tier ladder** and the **staged append**,
and the headline fact for a Monad audience is:

> A `CODE`-tier chunk is a real deployed contract. Push a text file, then open the chunk
> address in Monadscan and read your own bytes back out of its bytecode.

That is the thing the explorer links make possible, and it should be the centerpiece rather
than a footnote. Everything below serves it.

---

## 4. Files

```
explorer/src/
  pages/
    Mnemonad.vue                  # page, path: '/mnemonad', title: 'Mnemonad'
  mnemonad/
    StreamPicker.vue             # load by id, or create a new stream
    StreamSummary.vue            # length, binaryLength, owner, version, encrypted, firstAvailableIndex
    ItemUploader.vue             # file drop + text mode, split control, pre-flight, push
    PushProgress.vue             # per-transaction progress for staged appends
    ItemList.vue                 # paginated item rows
    ItemDetail.vue               # one item expanded: tier, chunks, meta, payload preview
    ChunkTable.vue               # chunk-centric view: which items share which chunk
    PayloadPreview.vue           # hex dump / text / image / download
    ExplorerLink.vue             # the linking primitive
    TierBadge.vue                # SLOT / CODE / EXTERNAL / packed / multi-chunk
  stores/
    mnemonad.js                   # Pinia store wrapping the SDK
  includes/
    explorerUrl.js               # URL builders derived from chain.blockExplorers
    formatBytes.js               # 1.2 KB / 3.4 MB
    sniffMime.js                 # magic-byte sniff for preview mode
```

Eleven components rather than the one component asked for, because upload, browse and
per-item detail genuinely are separate concerns and `ItemUploader` alone is substantial. If
a single drop-in file is preferred, say so and it collapses to one `MnemonadDemo.vue`
of roughly 600 lines, at the cost of being unpleasant to edit.

---

## 5. Upload surface

### 5.1 Input

- **File** — `<input type="file">` plus a drop zone, read via `arrayBuffer()` → `Uint8Array`
- **Text** — textarea → `TextEncoder`

Filename and MIME type go into `itemMeta` as a small JSON blob, so the browse view can label
and preview items correctly. Worth stating in the UI that **meta is not encrypted**, which
is a property we deliberately tested.

### 5.2 "As chunks" — two distinct operations, both worth showing

The phrase is ambiguous and the ambiguity is interesting, so offer both:

| Mode | What happens | What it demonstrates |
|---|---|---|
| **One item** | Auto-tiered. Large payloads go staged multi-chunk or IPFS. | The tier ladder and staged append |
| **Split into N items** | Payload sliced into N pieces, pushed via `pushMany`. | **Packing** — all N share one deployed chunk, at different offsets |

Splitting into pieces that fit one chunk is the only way to see packing, and packing is
where the measured 30% gas saving comes from. A slider for piece size (or piece count) with
a live "→ N items, 1 chunk, 1 transaction" readout makes the mechanic legible.

### 5.3 Pre-flight panel

Before any transaction, show all four candidate routes for the current payload and highlight
the one that will be taken. Values come from chain (`maxChunkBytes`, `SLOT_MAX_BYTES`,
`feePerByte`, `externalFeeBytes`) plus `estimatePushCost`, never hardcoded:

| Route | Chunks | Transactions | Gas | Protocol fee |
|---|---|---|---|---|
| SLOT | - | 1 | … | … |
| CODE, single chunk | 1 | 1 | … | … |
| CODE, staged | `ceil(size / maxChunkBytes)` | `2 + chunks` | … | … |
| EXTERNAL (IPFS) | 0 | 1 | … | flat `externalFeeBytes × feePerByte` |

Greyed rows carry the reason they do not apply ("payload exceeds 31 bytes", "no IPFS
transport configured"). With the encrypt toggle on, the size used is
`MnemonadCrypto.ciphertextLengthFor(n)`, which visibly bumps some payloads into a
higher tier. That is a real mechanic worth surfacing rather than hiding.

### 5.4 The UX cliff, stated plainly

A staged upload is `2 + N` transactions and therefore **`2 + N` wallet confirmations**. A
1 MB file at 120 KB chunks is 11 prompts. There is no batching available without account
abstraction or EIP-7702, and the plan already notes 7702 delegation restrictions on Monad.

Mitigations, none of which remove the problem:

- Show the count in the pre-flight panel before the user commits
- `PushProgress.vue` shows `appendChunk 4 of 9` with each landed tx linked to the explorer,
  so the sequence is legible rather than a wall of popups
- Resume is real, not decorative: `appendChunk` validates its offset on-chain, so a
  cancelled upload can be picked up from where it stopped. The store should keep the
  `stagingId` and offer "resume"
- Cap the demo default at **1 MB** with a warning above it, since hex-encoding calldata in
  the browser is memory-heavy

---

## 6. Browse surface

### 6.1 Reads need no wallet

`publicClient` alone serves every read, so browsing must work fully disconnected. Only
pushing requires a wallet. The wallet store's existing `wrongNetwork` getter guards writes.

### 6.2 Item list

Paginated at 25 rows. Do **not** read every item on load: `length` may be large, and each
row costs 2 to 3 `eth_call`s (`itemStore`, `itemSize`, `itemMeta`). Fetch only visible rows.

| Column | Source |
|---|---|
| `#` | index |
| Tier | `itemStore` → `TierBadge` |
| Size | `itemSize`, or `plaintextLengthAt` when encrypted |
| Layout | `getItemRefs` → dedicated / packed at offset / N chunks |
| Chunks | chunk addresses, each an `ExplorerLink` |
| Meta | decoded filename if present |

Indices below `firstAvailableIndex` render as truncated and unreadable, which is the honest
representation of `truncateFrom`.

### 6.3 Item detail

- Full `getItemRefs` output: tier, offset, size, every chunk address linked
- For `CODE`: the note that the chunk's on-chain bytecode is `00` followed by the payload,
  so the explorer's bytecode view shows the data with a one-byte `STOP` prefix. Explains
  what the user is looking at when they follow the link
- For `EXTERNAL`: CID, recorded size, sha256, IPFS gateway link, and whether the fetched
  bytes verified against the hash
- `PayloadPreview`: hex dump by default, with text / image / download modes selected by
  magic-byte sniff. Range-read backed, so a large item previews its first 4 KB rather than
  downloading everything

### 6.4 Chunk-centric view

`ChunkTable.vue` inverts the relation: one row per deployed chunk, showing which item
indices live in it and at what offsets. This is the only view that makes packing visible,
and it is where the "several items, one contract" story lands.

---

## 7. Explorer links

Base URL derived from `getActiveNetwork().chain.blockExplorers.default.url` rather than
hardcoded. Currently that resolves to:

| Network | Explorer |
|---|---|
| Monad mainnet (143) | `https://monadscan.com` |
| Monad testnet (10143) | `https://testnet.monadexplorer.com` |

`ExplorerLink.vue` takes `type` (`address` / `tx` / `token` / `block`) and a value, renders
label plus an `open_in_new` icon, and always emits:

```html
<a :href="url" target="_blank" rel="noopener noreferrer">
```

`rel="noopener noreferrer"` alongside `target="_blank"`, not just the target — otherwise the
opened page gets a `window.opener` handle back into the app.

| Entity | Path | Confidence |
|---|---|---|
| Registry contract | `/address/{registry}` | universal |
| CODE chunk | `/address/{chunk}` | universal, and the payoff link |
| Transaction | `/tx/{hash}` | universal |
| Owner | `/address/{owner}` | universal |
| Stream id (ERC-721 token) | varies | **needs verifying per explorer** |
| EXTERNAL pointer | IPFS gateway, not Monad | n/a |

The token/NFT URL shape is the one real unknown: Monadscan is Etherscan-flavoured
(`/token/{contract}?a={tokenId}`), while `testnet.monadexplorer.com` is a different codebase
with its own routing. The builder should special-case by chain id and fall back to
`/address/{registry}` when unsure, rather than emitting a guessed URL that 404s.

---

## 8. Encryption and IPFS in the browser

**Encryption** works: adapt wagmi's `signMessage` into the shape the SDK's crypto companion
expects.

```js
const signer = { signMessage: ({ message }) => signMessage(config, { message }) };
```

Two things to surface in the UI: it triggers a wallet signature prompt (cache the unwrapped
key in the store so it happens once per session), and an encrypted stream **cannot be
transferred**, because the key is bound to the owner.

> **Shipped differently:** the encryption that actually landed is password-based (PBKDF2,
> not a wallet signature), so there's no signature prompt and it's *not* owner-bound — see
> `js/README.md`'s Encryption section for the full method-vs-method comparison. The
> unwrapped key is cached the same way this section anticipated, just in a dedicated
> `streamKeys.js` Pinia store (in-memory only, deliberately not persisted — a reload
> re-prompts for the password), rather than piggybacking on the wagmi-signer flow described
> above. `Stream.vue`/`ItemListItem.vue`/`ItemList.vue` carry the locked-state UI and the
> password-unlock dialog. The "cannot be transferred" restriction still holds, but
> unconditionally for *any* KEK method — the contract has no way to tell them apart.

**IPFS writes are the awkward one.** `pinningUrl` + `pinningJwt` in a browser exposes the
JWT to anyone who opens devtools. A shared demo key would be abuse-bait. So:

- Default to **gateway-only**: external items are readable and hash-verified, not creatable
- Optionally let the user paste their own Pinata JWT, kept in `localStorage`, clearly labelled
  as theirs and never sent anywhere but the pinning endpoint
- Do not ship a project key

That means the EXTERNAL tier demos read-side out of the box and write-side only for users
who bring a key. Worth being upfront about in the UI copy.

---

## 9. Phases

| # | Phase | Content |
|---|---|---|
| 0 | Unblock | Deploy to testnet (or add a localhost network entry), add `mnemonadAddress` to `settings.js`, vite alias, two deps |
| 1 | Store + page shell | `stores/mnemonad.js`, `pages/Mnemonad.vue`, `StreamSummary`, not-deployed state, nav entry |
| 2 | Links | `explorerUrl.js`, `ExplorerLink.vue`, `TierBadge.vue`. Verify token URL shapes against both explorers |
| 3 | Browse | `ItemList` paginated, `ItemDetail`, `PayloadPreview`, `ChunkTable`. Read-only, no wallet |
| 4 | Upload | `ItemUploader` with file + text modes, split control, pre-flight panel |
| 5 | Staged writes | `PushProgress`, per-tx links, resume from `stagingId` |
| 6 | Encryption + IPFS | encrypt toggle with wagmi signer, gateway reads, optional user JWT — *shipped as a password-based toggle instead; see §8* |
| 7 | Polish | loading skeletons, empty and error states, reduced-motion, mobile collapse, contrast audit |

Phases 1 to 3 are useful on their own: a working read-only browser for any deployed stream.

---

## 10. Open questions

1. **Which network for the demo?** Testnet is the sane choice, and `settings.js` already
   carries a `faucetUrl` for it. Mainnet writes cost real MON and the contract is unaudited.
   Recommend testnet-only for the demo page, even once mainnet exists.
2. **One component or eleven?** Asked for "a component"; the honest decomposition is eleven
   small ones. Happy to collapse to a single file if drop-in simplicity matters more than
   editability.
3. **Nav.** There is no nav menu to add a link to. Add one to the header, link from
   `Home.vue`, or leave the page URL-only like `/docs` and `/showcase`? Partly settled by
   #5 below for the owned-streams slice; still open for a future full browse/upload page if
   that ends up living at its own route.
4. **Demo size cap.** 1 MB proposed. Higher means more wallet prompts and heavier browser
   memory, not a different code path.
5. **Should this replace `Home.vue`?** **Decided for the owned-streams slice:** yes — see
   §1.6, `Home.vue` gets the stream list and create button directly, no separate route. Still
   open for the larger upload/browse surface (§3-§8): same home page, once it exists, or its
   own `/mnemonad` route as originally sketched in §4.
