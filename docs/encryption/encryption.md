# Encryption

Mnemonad streams can be either public, with data stored as plain bytes, or encrypted, with data protected using **AES-256-GCM**.

The encryption mode is chosen by the stream creator when the stream is created.

Public, unencrypted streams can be read by anyone, and their contents are fully visible on-chain. Encrypted streams are designed so that only an authorized holder of the encryption key can decrypt their contents or push new versions and chunks.

Once a stream is created as encrypted, it remains encrypted permanently. All subsequent read and write operations require the corresponding key.

Mnemonad currently implements three encryption methods:

- Wallet signature — requires either a private key or a browser wallet adapter to sign a message used to derive the encryption key. See [signature.md](signature.md), or [passkey-account.md](passkey-account.md) for the passkey-derived-account case specifically
- Password — uses a plaintext password to derive the encryption key. See [password.md](password.md)
- Passkey — a passkey's WebAuthn PRF output derives the encryption key, whatever wallet is connected. See [passkey.md](passkey.md)


The current contract and SDK architecture is designed to support additional encryption methods in the future.
Internally, Mnemonad generates a random AES-256-GCM data key for each encrypted item. That data key is then itself encrypted, or wrapped, using a separate key-encryption key (KEK) before being published on-chain.

Each stream declares which key-encryption method it uses through the kek block in its published metadata.

Password and wallet signature are implemented end to end across the SDK, CLI, and explorer dApp. Passkey is in the SDK and the explorer; the CLI recognizes passkey streams but can't unlock them yet.

The CLI supports:

`--encrypt --password ...`
`--encrypt --encrypt-with wallet`
`--encrypt --encrypt-with wallet --passkey`

The explorer dApp exposes the same options through its create-stream dialog.

Once a Mnemonad instance has been unlocked, both encrypted and unencrypted streams use the same Mnemonad API. Methods such as at(), push(), and stream() handle encryption and decryption transparently, so callers do not need encryption-method-specific logic.

**Unlocking is per session, not persisted.** No method leaves the key cached anywhere between runs — reload the page, or start a new CLI invocation, and there's nothing to reuse: a password stream asks for the password again, a wallet-signature stream asks the connected signer to sign again — including a passkey-derived signer, which just means signing in with that passkey again — and a passkey stream asks for its passkey again. See [passkey-account.md](passkey-account.md) for exactly what does and doesn't get re-prompted in the passkey-account case.