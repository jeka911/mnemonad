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
  "may ask twice" pattern the signature-encryption create flow already has.
- **Sign in** (`getPasskeyPrfOutput`) reproduces an *existing* passkey's account with one
  assertion. It doesn't need to be told which credential — omitting `credential` lets the
  platform's own passkey picker choose among whatever's resident for this `rp.id`.

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
