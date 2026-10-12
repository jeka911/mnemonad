# Signature encryption with a passkey-derived account

This page is about a passkey that *is* the wallet. To encrypt a stream to a passkey while
signed in with any wallet, see [passkey-based encryption](passkey.md) instead.

[Signature-based encryption](signature.md) asks whatever's connected for one `personal_sign`
— it doesn't care whether that's a browser extension, a raw key, or a
[passkey-derived account](../wallet/passkey-accounts.md). `toViemAccount` adapts Mera's
signing session into an ordinary viem `LocalAccount`, the same shape every other signer
already is, so `_deriveKekFromSignature`/`unlockWithSignature` work completely unchanged —
nothing here is passkey-specific in the SDK at all.

What *is* different is where the prompting happens. A wallet extension pops a confirm dialog
for every `signMessage` call, so creating an encrypted stream ("asks twice": once for the KEK
signature, once for the `create` transaction) means two separate approvals. A passkey account
only ever asks WebAuthn once — the sign-in that derives the secp256k1 key via PRF. Everything
after that is Mera's signing session holding that key in memory and signing with it directly;
the KEK-derivation signature and the create transaction both go out with no further prompt,
no second Face ID/fingerprint check. Same for unlocking an already-encrypted stream later —
one connect, then `unlockWithSignature` signs silently.

**That key only lives for the active session, though — Mera never persists it.** Close the
tab, reload the page, or start a new `--passkey` CLI run, and there's nothing cached to sign
silently with anymore. It's not lost: the same passkey re-derives the identical key on the
next sign-in (that's the whole point of PRF being deterministic), but the user has to go
through that sign-in again, once per session, the same as connecting fresh the first time.

From the CLI this composes exactly the way you'd expect: `push --encrypt --encrypt-with
wallet --passkey` opens one browser tab for one sign-in, and the bridge relays both signs
(the KEK message, then the create tx) over that same session — see
[cli-passkey.md](../wallet/cli-passkey.md) for the bridge itself.

The one thing worth being clear-eyed about: encrypting to a passkey account and connecting
*with* that same passkey account are the same single point of failure, not two stacked ones.
Lose the passkey and every synced copy of it, and both the account and the stream's key are
gone in the same stroke — no recovery path either way, exactly what
[passkey-accounts.md](../wallet/passkey-accounts.md) and [signature.md](signature.md) each
already say on their own.
