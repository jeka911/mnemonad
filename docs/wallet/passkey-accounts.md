# Passkey-derived accounts

A third way to connect a wallet in the explorer, next to a browser extension and the
dev-only Local Signer (see [`testing/local-signer.md`](../testing/local-signer.md)): a real
EVM account derived entirely from a WebAuthn passkey, via
[`@category-labs/mera`](https://github.com/category-labs/mera). No extension, no seed phrase
typed or written down anywhere — the passkey *is* the account.

Implemented in [`explorer/src/wallet/passkeyConnector.js`](../../explorer/src/wallet/passkeyConnector.js),
wired up the same way Local Signer is: an ad-hoc wagmi connector built and connected from a
card in the wallet-picker dialog, never registered in wagmi's static connector list. Gated
behind `VITE_ENABLE_PASSKEY_SIGNER` — not because the feature is less safe than the
alternatives (if anything, more: see "What this improves on Local Signer" below), but because
the library is still pre-1.0 and its own docs say the API may change.

## How the account is derived

The WebAuthn **PRF extension** gives a passkey a way to return 32 bytes that are a
deterministic function of `(credential, rp.id, salt)` — the same bytes every time, on every
device the passkey has synced to. Mera's `createSecp256k1SigningSession` accepts those 32
bytes directly as a secp256k1 private key — no HD derivation, no mnemonic step. (Mera's own
getting-started example runs the PRF output through `@scure/bip32`/`bip39` first; that's for
deriving *multiple* accounts from one passkey, which this connector doesn't need — one
passkey, one account.)

Two things about that derivation are pinned and must never change, because changing either
silently moves every existing user to a different address:

- **The PRF salt is the library's own fixed default** (`sha256("mera.prf.salt.v1")`),
  documented by Mera as stable across its versions. The connector never passes a custom
  `prfSalt` — there's nothing to gain from one at this single-account-per-passkey scope, and
  doing so would just be one more constant this project would then have to pin and never
  touch, alongside Mera's own.
- **`rp.id` is the page's live hostname** (`window.location.hostname`), not a fixed string.
  WebAuthn requires `rp.id` to equal, or be a registrable-domain suffix of, the calling
  origin — a hardcoded production hostname would make the ceremony fail outright (not just
  fragment accounts) on `localhost` and on every Vercel preview deployment, since
  `mnemonad-git-branch.vercel.app` doesn't share a registrable domain with
  `mnemonad.vercel.app` (`vercel.app` is a public-suffix boundary). The real consequence:
  **a passkey account is bound to whichever domain created it.** Moving the production
  deployment to a new domain later starts everyone's passkey account over — there is no
  migration path, by the nature of what `rp.id` is. Preview deployments and production
  therefore never share passkey accounts, which is fine: nothing of real value should be
  sitting on a preview URL anyway.

`toViemAccount` (from `@category-labs/mera/viem`) adapts the resulting signing session into
an ordinary `viem` `LocalAccount` — the exact same shape `privateKeyToAccount` produces for
Local Signer — so every existing write/sign call site (`getWalletClient`, `signTypedData`,
`_deriveKekFromSignature`/`unlockWithSignature` for signature-encrypted streams) works
completely unchanged.

## Create vs. sign in — genuinely two different ceremonies

- **Create** (`createPasskeyWithPrfOutput`) registers a brand-new, discoverable passkey with
  a fresh, internally-generated `user.id`. Every call makes a *new* passkey and therefore a
  new, unrelated account — running "create" again is not a way to get a lost account back.
  On an authenticator that doesn't evaluate PRF at creation time, this runs a second ceremony
  automatically (one more user-verification prompt) to get the PRF output anyway — the same
  "may ask twice" pattern the signature-encryption create flow already has. `displayName` is
  timestamped (`Account <date>`, matching Mera's own reference demo) rather than a fixed
  string, because every call makes a same-named entry otherwise — and even a *failed*
  ceremony after the creation step still leaves that passkey behind on the authenticator
  (confirmed live: testing across several browsers/providers left multiple identically-labeled
  entries in one password manager). Without the timestamp, "Sign in" had nothing to
  distinguish them by.
- **Sign in** (`getPasskeyPrfOutput`) reproduces an *existing* passkey's account with one
  assertion. Confirmed live: with more than one similarly-labeled passkey resident (see above),
  it can resolve to a *different* one each time, landing on a different address with no error
  at all — the actual cause of "it connects with a different address every time" the first
  time this got tested for real.

  The fix is [`passkeyIdentity.js`](../../explorer/src/wallet/passkeyIdentity.js): every
  successful connect remembers that credential's id in `localStorage`, and the next "sign in"
  passes it as an `allowCredential` hint, so the same browser lands on the same account every
  time once one has been used. It's a preference, never a filter with an invented fallback:
  a fresh browser (no stored id — the actual cross-device-recovery case, opening the account
  on a second device the passkey has synced to) still omits it and gets the open
  discoverable-credential picker, exactly as before. It's also never auto-retried on failure:
  WebAuthn's own privacy rules make "that credential isn't on this authenticator" and "the
  user cancelled" indistinguishable from the result alone (both surface as the same
  `NotAllowedError` — see below), so silently retrying without the hint would mean
  re-prompting someone who'd genuinely just declined. `PasskeyCard.vue`'s "Not this passkey?"
  link is the deliberate, explicit way out of a wrong pin instead — it forgets the stored id
  and immediately retries fully open.

  The same pin also decides what happens the moment this card opens: with one remembered,
  `PasskeyCard.vue` fires that "sign in" itself on mount, before either button is clicked —
  the click that opened the card (the fingerprint toggle in `WalletConnect.vue`) is still
  what satisfies WebAuthn's user-activation requirement, so no separate click is needed to
  actually trigger the browser's passkey prompt. A real ceremony still runs; this only skips
  making someone choose Create/Sign-in for an account this browser has already used. Any
  failure (declined, no matching credential, timed out) falls straight back to this card's
  normal two-button state — `run()` already resets `connectingMode` and surfaces `error` on
  its own, so there's nothing else gating that fallback.

## What this improves on Local Signer

Local Signer's raw private-key string just falls out of scope for garbage collection on
disconnect. Mera's signing session is a real, checked lifetime: `session.end()` actually
zeroes the key bytes (`.fill(0)`), and every signing call after that throws a typed
`SESSION_ENDED` error instead of silently using stale memory. The connector's own `connect()`
also ends the session on any failure partway through, so a failed connect never leaves a
live, unzeroed key sitting in the closure.

## What it doesn't solve — no recovery path

There is no independent backup. If the passkey and every device it's synced to (iCloud
Keychain, Google Password Manager) are gone, the account is gone — permanently, exactly the
same trade-off [`encryption/signature.md`](../encryption/signature.md) documents for
signature-encrypted streams: nothing to remember, nothing to protect beyond the passkey
itself, but only that exact passkey can ever derive the account back.

## What Mera also offers that this doesn't use

Mera separately ships a **secret-vault** API (`createSecretVaultWithNewPasskey`,
`decryptSecretVaultWithPasskey`) that encrypts an arbitrary secret — an existing private key,
say — behind a passkey, storable as ordinary JSON. That's a different feature: "protect a key
you already have with Face ID/a PIN," not "the passkey is the key." It would need its own
storage lifecycle (the vault JSON has to live somewhere, e.g. `localStorage` — a deliberate
reversal of Local Signer's explicit stance of never persisting key material) and doesn't by
itself solve the recovery problem above either, unless the underlying key is *also* backed up
some other way. Worth a separate look if there's a concrete need for it; not built here.

## No capability pre-check

Mera exposes no `isSupported()`-style probe. `PasskeyCard.vue` does the one synchronous check
available — whether `navigator.credentials` and `window.PublicKeyCredential` exist at all —
to decide whether to show the buttons; actual PRF support on a given authenticator is only
knowable by attempting a ceremony, surfacing as Mera's typed `PRF_UNAVAILABLE` error if it
isn't there.

There is also no way to ask WebAuthn "does a passkey already exist for this site" without
running a real ceremony — deliberately: the working group considered and rejected exposing
that (see the [February 2026 public-webauthn
thread](https://lists.w3.org/Archives/Public/public-webauthn/2025Feb/0103.html)), since it
would let any site enumerate which of a list of domains a visitor has credentials on. What
the platform exposes instead (`PublicKeyCredential.getClientCapabilities()`,
`isUserVerifyingPlatformAuthenticatorAvailable()`) is device capability — "can this device do
a platform passkey at all" — not "does this browser have one of *ours*". So `PasskeyCard.vue`
uses the one honest signal it actually has — `hasRememberedCredential`, the same pin
[`passkeyIdentity.js`](../../explorer/src/wallet/passkeyIdentity.js) keeps for sign-in
disambiguation — to decide which button leads: "Sign in" first and filled once this browser
has pinned a credential, "Create" first otherwise.

## Real-world failures hit while testing this — none of them fixable from our side

Live testing turned up several distinct, well-documented platform failures. All of them are
genuine device/browser/authenticator-side issues, confirmed against current sources rather
than guessed — there was nothing wrong in this connector or in how it calls Mera in any of
these cases, and `describeError()` already surfaces the most detail the platform will ever
hand a webpage for any of them.

- **Android Chrome: `NotReadableError`, "An unknown error occurred while talking to the
  credential manager."** Chrome doesn't implement WebAuthn itself on Android — it hands the
  request to Google Play Services' Credential Manager and remaps whatever internal error code
  comes back into one of a handful of generic `DOMException`s, by design (so a page can't
  fingerprint device state from a fine-grained error). The real cause only exists in the
  device's own system logs — there's nothing more for us to extract. Commonly caused by more
  than one credential provider being registered on the device (Google Password Manager
  alongside Samsung Pass, Bitwarden, 1Password, …), outdated Google Play Services, or an
  Android version below 14 (the modern Credential Manager path). Worth trying: disable all
  but one credential provider, update Play Services, or just retry — some of these are
  transient. See [Android & Google Play Services Passkey Error Codes (2026) —
  Corbado](https://www.corbado.com/blog/google-play-services-passkey-error-codes) and
  [bitwarden/android#5384](https://github.com/bitwarden/android/issues/5384).
- **`PRF_UNAVAILABLE` with Bitwarden as the credential provider.** Bitwarden's own PRF support
  is real but incomplete and platform-dependent as of mid-2026 — their tracking issue
  ([bitwarden/discussions#13838](https://github.com/orgs/bitwarden/discussions/13838)) shows
  the underlying support landed in their `passkey-rs` fork but isn't fully wired through yet;
  one third-party compatibility survey measured 100% success on Linux/Firefox but 0% on
  iOS/Safari for the same feature. The ceremony completes (a credential is created) but no PRF
  output comes back with it — exactly what Mera's `PRF_UNAVAILABLE` check exists to catch.
  Practical fix: use the device's own built-in passkey manager (Google Password Manager,
  iCloud Keychain, Windows Hello) rather than Bitwarden — those are consistently reported as
  full support. See [Passkeys & WebAuthn PRF for End-to-End Encryption (2026) —
  Corbado](https://www.corbado.com/blog/passkeys-prf-webauthn).
- **Desktop-to-phone via QR code (the "hybrid transport"/caBLE flow) is just inherently less
  reliable**, independent of PRF or anything else. The Corbado Passkey Benchmark's Q1 2026
  data puts hybrid-transport completion at only 60–78% (Windows) / 66–86% (macOS) even under
  normal conditions, against high-90s for on-device flows. A `NotAllowedError` ("timed out or
  was not allowed") here is consistent with the multi-step ceremony (scan → unlock → biometric
  → relay back) simply not completing in time, not a capability gap — Chrome's PRF support
  does extend to the hybrid path. If this matters for real usage, prefer testing (and
  encouraging users to connect) directly on the device that holds the passkey, not via a
  desktop QR scan. See [WebAuthn Passkey QR Codes & Bluetooth: Hybrid Transport —
  Corbado](https://www.corbado.com/blog/webauthn-passkey-qr-code).
- **`assetlinks.json` is unrelated to any of the above.** Digital Asset Links'
  `delegate_permission/common.get_login_creds` is specifically for letting a *native Android
  app* share the same passkey as its associated website. Mnemonad has no native app, and none
  of the failures above involve one — every one of them happens entirely inside a browser
  talking to this website directly (or, for hybrid, to another browser). There is nothing to
  configure here for that reason.

## Using a passkey from the CLI (`--passkey`)

The CLI (`cli/`) is a Node process — there's no `navigator.credentials` there, so it can't run
a WebAuthn ceremony itself. `--passkey` works around that by borrowing a browser for it:

1. [`cli/lib/passkeyBridge.js`](../../cli/lib/passkeyBridge.js) starts a loopback WebSocket
   server on `127.0.0.1` with a random one-time token, and opens the explorer's
   [`/cli-auth`](../../explorer/src/pages/CliAuth.vue) page in the system browser at that
   deployment's own domain — has to be that exact domain, not a placeholder, since the
   ceremony's `rp.id` is whatever domain the page is actually served from (see above); a page
   served from anywhere else would either fail outright or produce an unrelated account. The
   URL also carries a one-line `desc` (e.g. `mnemonad push ~/my-data`, built by
   `describeCommand()` from the command name plus its stream id/path — no flags), so the tab
   says what it's actually signing in for rather than just "a CLI command." This is also the
   one structural way this differs from the usual CLI-auth-via-browser pattern (`gh auth
   login`, most OAuth loopback flows per RFC 8252 §7.3): those hand the whole auth UI to a
   *remote* provider and only ever touch localhost once, for a single redirect at the very
   end. There's no remote provider here — the ceremony is WebAuthn, running in the browser
   against this domain directly — so the page has to talk back to the loopback server itself.
2. Before running the ceremony, the page polls `GET /ping?token=…` on that same loopback
   server every 10s (and once immediately on load) — the one thing available before a real
   connection exists, since the WS below doesn't open until sign-in actually completes. A
   working pong doubles as "the CLI is still there" and hands back its authoritative view of
   how much of the connect-timeout is left, which the page uses to correct the countdown for
   whatever drift built up since either side started counting (the CLI's clock starts before
   the browser tab has even finished loading). A failing ping shows a plain "can't reach the
   CLI" instead of only finding that out after a completed passkey prompt.
3. `/cli-auth` runs the same sign-in ceremony `passkeyConnector.js` uses for the dApp (no
   "create" — this only ever signs in to a passkey that already exists), then opens
   `ws://127.0.0.1:<port>` back to the CLI's server and holds the resulting Mera session in a
   closure for as long as the tab stays open.
4. Every signature the CLI's command needs (a `personal_sign` for wallet-keyed-stream
   encryption, a transaction signature for any write) goes out over that socket as a request
   and comes back as just the signature — the raw key never leaves the browser tab, the same
   "session with a real, zeroed lifetime" property described above, just relayed instead of
   called in-process. `cli/lib/bridgeCodec.js` /
   [`explorer/src/wallet/bridgeCodec.js`](../../explorer/src/wallet/bridgeCodec.js) exist only
   to carry a transaction's `BigInt` fields (`value`, `gas`, the fee fields) across that JSON
   socket, which can't represent `BigInt` natively.
5. When the command finishes, `bin/mnemonad.js` tells the tab it's done — with whether it
   actually succeeded and a one-line result (the command's own last `console.log` line, the
   same thing the terminal itself just showed, or the error message on failure), so the tab
   shows what happened instead of a bare "done" before the page ends the session (zeroing the
   key) and the CLI closes the loopback server.

This is deliberately a one-shot bridge, scoped to a single command: no daemon, no state file,
nothing that persists once the command exits. The next `--passkey` command opens a fresh tab
and repeats the sign-in. That's a real tradeoff — a human has to be there to click through the
prompt every time, so it's a fit for someone running a command by hand, not for scripts or CI
(which should keep using `--key`/`MNEMONAD_KEY`) — but it keeps the whole thing to "one bridge,
one browser tab, one command" with nothing left running or stored anywhere after.
