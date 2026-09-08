# Local Signer in dApp

This is what helps with testing and debugging with coding AI agents: a wallet-picker
option that connects with a raw private key instead of a browser extension, so a
transaction signs and sends immediately — no confirmation popup per step, and no
browser-extension UI for an agent to click through. It exists for two things a real
wallet makes tedious: driving the paid-upload path (create → push → pay → offload →
settle) through several transactions in a row while testing, and letting a script or
agent operate the explorer as an unattended account.

**Testnet only, off by default, and it never holds a real key.** Treat every key you
type into it as a burner. See [Security model](#security-model) before using this
against anything that isn't Monad testnet.

## Enabling it

```bash
# explorer/.env
VITE_ENABLE_LOCAL_SIGNER=true
```

Unset (the default) removes the feature from the build entirely — not just hidden
behind a flag check, but never fetched. See [What "off by default" actually
does](#what-off-by-default-actually-does).

## Using it

**From the UI:** open the wallet picker → "Use a private key instead" → paste a key
→ the derived address renders live so a typo is visible before it signs anything →
"Connect with this key".

**From the browser console, or from a script driving the page:**

```js
const address = await window.mnemonadConnectWithKey('0x...');
// ... drive the app, or call SDK writes directly — see below ...
await window.mnemonadDisconnect();
```

Both globals only exist when the flag is on. `mnemonadConnectWithKey` accepts the key
with or without a `0x` prefix and returns the connected address; it rejects
immediately if the app isn't on Monad testnet or the key isn't 32 bytes of hex.

Once connected, every existing call site — `getWalletClient(config)`,
`signTypedData(config, ...)`, the SDK's own `Mnemonad._write` and
`MnemonadUploadGateway._write` — works completely unchanged. Nothing needed to know
the account wasn't a browser extension.

## Verified end to end

Connected with a funded testnet key and drove a real session with zero wallet
popups: create a stream, `pushMany` five items, then the full paid-IPFS path —
gateway quote, `payForUpload` escrow, presign-server upload, `pushExternal`
settlement. Confirmed independently of the UI's own success message: the returned
CID was fetched directly from the IPFS gateway and matched byte-for-byte, and the
gateway contract's `revenue`/`escrowed` fields showed the payment settled rather than
sitting stuck in escrow.

## Security model

- **Testnet-only, enforced in one place.** [`connectLocalSigner.js`](../../explorer/src/wallet/connectLocalSigner.js)
  checks the active chain before doing anything else, and both the card and the
  console helper call through it — so neither can end up with a different rule than
  the other.
- **Never persisted.** The key lives only in the card component's local state and the
  connector's closure, for as long as that connection lasts. Not written to Pinia,
  `localStorage`, `sessionStorage`, or a URL. Confirmed by inspecting `localStorage`
  after connecting: wagmi's own persisted state holds only the address, chain id, and
  connector id/name — no key material.
- **Doesn't survive a reload, on purpose.** The connector is never added to wagmi's
  static connector list — it's built ad hoc, per connect call. wagmi's own
  reconnect-on-mount logic can only rebuild connectors from that static list, so even
  though it remembers "there was a session with connector `local-signer`", it has
  nothing to reconstruct one from. Confirmed: reloading mid-session does not
  auto-restore the account.
- **Disconnect goes through the same path a real wallet's does.** wagmi can replace a
  connector that was never in its static list with a storage-rehydrated stub
  (`{id, name, type, uid}`, no methods) — a pre-existing quirk `stores/wallet.js`
  already defends against for extension wallets. `window.mnemonadDisconnect` reuses
  that same store action rather than calling wagmi's disconnect directly, so it
  inherits the defense instead of needing its own copy.

## What "off by default" actually does

`WalletConnect.vue` loads the card via `defineAsyncComponent(() => import(...))`
rather than a static import. A static import would still bundle the component
into the main chunk regardless of the env check — Rollup sees it referenced in
`components: {}` and keeps it either way. The dynamic import puts it in its own
chunk that's fetched only if the toggle is ever clicked; with the flag off, the
toggle doesn't render, so the chunk is never requested. Confirmed in a production
build: the main entry chunks were within 0.01 kB of a build with the flag off, and
`LocalSignerCard-*.js` appeared as a separate ~2.5 kB chunk. The two `window.*`
globals follow the same pattern — each dynamically imports its own dependencies
inside the function body, only defined at all when the flag is on.

## Files

| File | What |
|---|---|
| [`explorer/src/wallet/localSignerConnector.js`](../../explorer/src/wallet/localSignerConnector.js) | The wagmi connector. `getClient()` returns a real local-account `WalletClient`, which wagmi's `getConnectorClient` prefers over building one from a provider — that's what makes every existing call site work unchanged. |
| [`explorer/src/wallet/connectLocalSigner.js`](../../explorer/src/wallet/connectLocalSigner.js) | The shared connect path (testnet gate + `connect()` call) used by both the card and the console helper. |
| [`explorer/src/wallet/LocalSignerCard.vue`](../../explorer/src/wallet/LocalSignerCard.vue) | The input UI: password field, live derived-address preview, warning copy. |
| [`explorer/src/WalletConnect.vue`](../../explorer/src/WalletConnect.vue) | Wallet picker — the toggle, the lazy import, and the "connected via local signer" badge. |
| [`explorer/src/main.js`](../../explorer/src/main.js) | Registers `window.mnemonadConnectWithKey` / `window.mnemonadDisconnect`. |
