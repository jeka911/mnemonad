# Encryption

Mnemonad streams can be either public, with data stored as plain bytes, or encrypted, with data protected using **AES-256-GCM**.

The encryption mode is chosen by the stream creator when the stream is created.

Public, unencrypted streams can be read by anyone, and their contents are fully visible on-chain. Encrypted streams are designed so that only an authorized holder of the encryption key can decrypt their contents or push new versions and chunks.

Once a stream is created as encrypted, it remains encrypted permanently. All subsequent read and write operations require the corresponding key.

Mnemonad currently implements two encryption methods:

    - Wallet signature — requires either a private key or a browser wallet adapter to sign a message used to derive the encryption key. See [signature.md](signature.md)
    - Password — uses a plaintext password to derive the encryption key. See [password.md](password.md)


The current contract and SDK architecture is designed to support additional encryption methods in the future.
Internally, Mnemonad generates a random AES-256-GCM data key for each encrypted item. That data key is then itself encrypted, or wrapped, using a separate key-encryption key (KEK) before being published on-chain.

Each stream declares which key-encryption method it uses through the kek block in its published metadata.

Both currently supported methods are implemented end to end across the SDK, CLI, and explorer dApp.

The CLI supports:

`--encrypt --password ...`
`--encrypt --encrypt-with wallet`

The explorer dApp exposes the same options through its create-stream dialog.

Once a Mnemonad instance has been unlocked, both encrypted and unencrypted streams use the same Mnemonad API. Methods such as at(), push(), and stream() handle encryption and decryption transparently, so callers do not need encryption-method-specific logic.