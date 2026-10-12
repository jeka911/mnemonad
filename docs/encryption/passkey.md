# Passkey-based encryption

The key-encryption key comes from a passkey (Face ID, Touch ID, Windows Hello, a phone or a
password manager), not from a wallet. Whatever wallet is connected only signs and pays for
transactions: you can be signed in with a browser extension and still encrypt a stream to
your passkey.

This is a different thing from a [passkey-derived account](passkey-account.md), where the
passkey *is* the wallet and the stream uses the ordinary [signature method](signature.md).
Here the passkey keys the stream directly, and the wallet plays no part in it.

## How the key is derived

A passkey with the WebAuthn **PRF extension** returns 32 bytes that are a deterministic
function of the passkey, the site (`rp.id`) and a salt: the same bytes every time, on every
device the passkey syncs to.

- **The salt is computed from the stream:** `sha256` of
  `mnemonad:kek:passkey:v1\nchainId:<N>\ncontract:<address>\nstream:<id>`. One passkey
  therefore gives an unrelated key for every stream and every deployment, and nothing has to
  be stored to reproduce it (`MnemonadCrypto.passkeyKekSalt`).
- **The PRF output goes through HKDF-SHA256** (info `mnemonad:kek:passkey:v1`) to make the
  32-byte key that wraps the stream's random data key, as with the other methods.
- **The stream's metadata publishes** `kek: {method: 'passkey', rpId, credentialId}`. `rpId`
  says which site can run the passkey at all; `credentialId` lets the unlock prompt go
  straight to the right passkey instead of a picker. Neither is secret. The one thing they
  reveal is that two streams were encrypted with the same passkey, even if different wallets
  own them.

The same passkey can also be your passkey *account*: the account uses Mera's fixed salt, and
each stream uses its own, so the account key and the stream keys never coincide.

## In the explorer

**New stream → Encrypt → With a passkey** is two steps:

1. **Create encryption key** (the fingerprint button) runs the passkey. Like the Sign In
   dialog, it goes to the passkey this browser used last, and creates a new one when there
   isn't one; a link underneath picks another passkey instead. A new passkey can ask twice on
   authenticators that don't return the PRF value at creation.
2. **Create** then asks only the wallet, for the transaction.

The key can come first because stream ids are deterministic: the dialog picks the stream's
salt up front, works out the id the create will produce, and derives the key for that id.
Switch wallets in between and the key is dropped (another account means another id), so
step 1 runs again. The passkey remembered for stream keys is kept apart from the Sign In
dialog's, so using one here never changes which account a passkey sign-in opens.

To unlock, the stream page asks for that passkey. Any wallet, or none, works: whoever holds
the passkey can read the stream. Writing still needs on-chain write permission (the owner or
an approved writer). As with the other methods, the key lasts for the session and nothing is
stored.

## From the SDK

The SDK never calls WebAuthn. You pass a provider that runs the ceremony, which keeps the SDK
usable in Node and lets tests use a stand-in:

```javascript
const passkey = {
	rpId: location.hostname,
	credentialId: null,            // known when unlocking: streamMeta.kek.credentialId
	async evaluate(salt) {         // 32-byte salt → 32-byte PRF output
		const { prfOutput, credentialId } = await getPasskeyPrfOutput({ rpId: location.hostname, prfSalt: salt });
		return { output: prfOutput, credentialId };
	},
};

const ev = await Mnemonad.create({ publicClient, walletClient, contractAddress, encrypt: true, passkey });

// Later, any reader:
const reader = new Mnemonad({ publicClient, contractAddress, id });
const { rpId, credentialId } = reader.streamMeta.kek; // after initialize()
await reader.unlockWithPasskey({ rpId, credentialId, evaluate: /* same ceremony, with credentialId as the hint */ });
```

A different passkey fails with `err.code === 'KEK_MISMATCH'`, like a wrong password or a
wrong wallet. The explorer's own provider is
[`explorer/src/wallet/passkeyPrf.js`](../../explorer/src/wallet/passkeyPrf.js), built on
[Mera](https://mera.category.xyz/)'s `getPasskeyPrfOutput` / `createPasskeyWithPrfOutput`
with a custom `prfSalt`.

## From the CLI

Not yet. The CLI can't run a passkey ceremony for an encryption key, so `push --encrypt-with
passkey` is refused, and `pull`, `diff`, `watch`, `compact` and `push` on a passkey stream
stop with a message pointing at the explorer. `info` shows the method and its site. CLI
support would go through the same browser bridge `--passkey` uses
([cli-passkey.md](../wallet/cli-passkey.md)).

## Limits

- **The stream belongs to one domain.** A passkey only works on the site that created it, so
  a stream encrypted on [mnemonad.vercel.app](https://mnemonad.vercel.app) can only be
  unlocked there. A stream made on `localhost` or a preview deployment can only be unlocked
  there. If the explorer ever moves to a new domain, passkey-encrypted streams made on the old
  one can't be opened from the new one.
- **The authenticator must support PRF.** iCloud Keychain, Google Password Manager and recent
  Chrome and Safari do; some security keys, older Windows Hello and some password managers
  don't. There is no way to check in advance: the explorer tries, and says so if it fails.
- **No recovery.** Lose the passkey and every device it synced to, and the stream is
  unreadable for good. Use a passkey that syncs.
