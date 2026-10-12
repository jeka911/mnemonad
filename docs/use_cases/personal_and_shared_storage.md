# Encrypted Personal and Shared Storage

Not every piece of decentralized data should be public.

Personal documents, private application state, agent memory, research data, and shared workspaces often need the persistence and portability of decentralized storage without exposing their contents.

Mnemonad provides encrypted streams for this purpose.

An encrypted stream keeps its contents unreadable to anyone who does not have the corresponding decryption key, while still preserving the same appendable and versioned storage model.

The examples on this page use the [`mnemonad` CLI](../cli/README.md), which syncs an encrypted folder with one command. Applications can also use the [JS SDK](../js/README.md) directly. Its snippets are marked "from code".

To browse a stream without the CLI, open it in the [Mnemonad explorer](https://mnemonad.vercel.app) at `https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`. Anyone can browse a public stream there. A wallet-encrypted stream opens only for its owner, after one wallet signature, and the owner can sign in with a wallet extension or a [passkey](#passkey-accounts). A password stream opens for anyone who enters the password.

## What can be stored

An encrypted Mnemonad stream may contain:

- personal documents
- private notes
- application data
- AI agent memory
- SQLite databases
- research datasets
- configuration files
- images and media
- private archives
- shared project files
- backups
- arbitrary binary data

For example:

```text
/private/
  profile.json
  notes/
    ideas.md
    journal.md
  documents/
    contract.pdf
  photos/
    private.jpg
  databases/
    personal.sqlite
  backups/
    laptop.tar.gz
```

```bash
export MNEMONAD_KEY=0x...   # the account that will own the stream

mnemonad push /private --manifest --encrypt --encrypt-with wallet
#   creating new stream on testnet (encrypted to 0x06bc…2279) ...
#   created: 0x68d9…a4b5
#   version 1 pushed (full snapshot, gzip compressed)
```

To anyone inspecting the underlying storage, the contents remain encrypted. This covers the on-chain bytes and the IPFS copies of large pushes alike, because data is encrypted before it leaves the machine.

Some things stay public, even on an encrypted stream:

- the owner's address
- the number of versions and items
- the size of each item
- the stream's `name` and each item's `name`/`type`, if the SDK sets them (the CLI does not set them: with the CLI, file names and paths are inside the encrypted diffs)

Do not store credentials (API keys, private keys, seed phrases) even in an encrypted stream. On-chain data is permanent. If the stream's key or password leaks later, every version ever pushed can be decrypted.

## Stream-level encryption

A Mnemonad stream is created as either:

```text
public
```

or:

```text
encrypted
```

That choice is made when the stream is created, with the first push:

```bash
mnemonad push /notes --manifest                                      # public
mnemonad push /notes --manifest --encrypt --encrypt-with wallet      # encrypted, wallet
mnemonad push /notes --manifest --encrypt --password "<password>"    # encrypted, password
```

A public stream stores readable bytes and may be inspected by anyone who has its id.

An encrypted stream stores encrypted data. Reading it and writing to it both require the stream to be unlocked first. Later pushes keep the stream's encryption and need no `--encrypt` flag.

Once a stream is encrypted, it remains encrypted. An encrypted stream also cannot be transferred to another owner.

`mnemonad info` shows which kind a stream is:

```bash
mnemonad info <stream-id> /notes
#   encrypted:       yes (owner wallet)
```

## AES-256-GCM encryption

Mnemonad uses AES-256-GCM for encrypted stream content.

Each stream has one randomly generated **data key**. Every item in the stream is encrypted with it.

That data key is then encrypted, or **wrapped**, using a separate **key-encryption key (KEK)**. The wrapped key is stored on-chain with the stream.

Conceptually:

```text
password / wallet
        ↓
       KEK
        ↓
wraps data key
        ↓
    data key
        ↓
AES-256-GCM
        ↓
encrypted content
```

Each item is encrypted in frames of 64 KiB, so a reader can decrypt part of a large item without downloading all of it.

This separation allows Mnemonad to support different methods of deriving or obtaining the KEK without changing how the actual stream data is encrypted.

## Password-based encryption

A stream can be protected using a password.

The password is used to derive the KEK using PBKDF2-HMAC-SHA256, with 600,000 iterations by default.

A unique salt is generated for each stream and stored in the stream metadata together with the PBKDF2 iteration count.

This means the user only needs to remember the password:

```bash
mnemonad push /shared --manifest --encrypt --password "<password>"   # create
mnemonad pull <stream-id> /shared --password "<password>"            # read, from anywhere, no wallet key
```

From code:

```javascript
const stream = new Mnemonad({ publicClient, contractAddress, id });

await stream.unlockWithPassword(password); // salt and iterations come from the stream metadata

const data = await stream.at(0);
```

Once unlocked, reads and writes happen through the normal Mnemonad API.

The salt and the wrapped key are public, and they stay public forever. Anyone can try passwords against them offline, and PBKDF2 only slows this down. Use a long, random password, not a memorable word.

## Wallet-based encryption

A stream may also derive its encryption key from a wallet signature.

Instead of asking the user to manage another password, the application asks the wallet to sign a deterministic message. The message names the chain, the contract and the stream id, so each stream has its own key.

That signature is then used as input for key derivation.

Conceptually:

```text
wallet
  ↓
sign message
  ↓
derive KEK
  ↓
unwrap data key
  ↓
decrypt stream
```

With the CLI, the signing account is the one in `MNEMONAD_KEY` (or `--key`/`--phrase`):

```bash
mnemonad push /private --manifest --encrypt --encrypt-with wallet   # create: two signatures, key + transaction
mnemonad pull <stream-id> /private                                  # read: needs the same MNEMONAD_KEY
```

From code:

```javascript
const stream = new Mnemonad({ publicClient, contractAddress, id });
await stream.unlockWithSignature(walletClient); // one wallet prompt
```

This allows encrypted storage to be tied to wallet access without exposing the wallet's private key.

Only the owner's account can derive the key. No other wallet can read the stream.

The wallet does not have to be a browser extension or a key in a file. A passkey can be the wallet. See the next section.

## Passkey accounts

You do not need a wallet extension or a seed phrase to own encrypted storage. In the [explorer](https://mnemonad.vercel.app), you can sign in with a passkey: Face ID, Touch ID, Windows Hello, a phone, or a password manager that stores passkeys.

The explorer uses [Mera](https://mera.category.xyz/) to turn the passkey into a normal Monad account. The passkey *is* the account. There is no separate key to store or to lose. The same passkey gives the same address on every device that it syncs to.

Conceptually:

```text
passkey (Face ID, Touch ID, …)
  ↓  WebAuthn PRF, through Mera
Monad account
  ↓  signs the stream's key message
KEK
  ↓
data key → decrypt stream
```

A passkey account encrypts with the wallet-based method, exactly like any other wallet. Nothing in the stream is passkey-specific. What changes is how often you are asked:

- **One prompt per session.** You confirm the passkey once, when you sign in. After that, Mera keeps the account's key in memory for the session. Creating an encrypted stream (a key signature and a transaction) and unlocking existing streams then need no more prompts.
- **Nothing is stored after the session.** Close the tab, reload the page, or start a new CLI command, and you sign in with the passkey again. The passkey derives the same account and the same keys every time.

From the CLI, `--passkey` signs with the same passkey account. It opens the explorer in your browser for the sign-in, and the browser signs for the CLI until the command ends:

```bash
mnemonad push /private --manifest --encrypt --encrypt-with wallet --passkey   # create, one sign-in
mnemonad pull <stream-id> /private --passkey                                  # read, one sign-in
```

A person must confirm each sign-in, so `--passkey` is for commands that you type, not for scripts or CI.

Before you rely on a passkey account, know these limits:

- **The passkey is the only key.** It is the account and the stream's encryption key at the same time. If you lose the passkey and every synced copy of it, you lose the account and the data. Use a passkey that syncs (iCloud Keychain, Google Password Manager, or a password manager), so that it exists on more than one device.
- **"Create" always makes a new account.** It cannot recover an old one. To get back to an existing account, use "Sign in".
- **The account belongs to the explorer's domain.** A passkey works only on the site that created it, so a passkey account exists only on [mnemonad.vercel.app](https://mnemonad.vercel.app).
- **The authenticator must support the WebAuthn PRF extension.** Not every one does: some password managers do not support it yet. When yours does not, the explorer says so, and you can use another authenticator, such as the passkey built into your device.

For details, see [Passkey-derived accounts](../wallet/passkey-accounts.md), [encryption with a passkey account](../encryption/passkey-account.md), and [CLI + passkey](../wallet/cli-passkey.md).

## Passkey-encrypted streams

You can also key one stream to a passkey while you stay signed in with your usual wallet. In the explorer, choose **New stream → Encrypt → With a passkey**. The passkey derives the stream's key; the wallet only signs and pays for the create transaction.

Conceptually:

```text
passkey (Face ID, Touch ID, …)
  ↓  WebAuthn PRF, with a salt computed from the stream
KEK
  ↓
data key → decrypt stream
```

This separates the data from the wallet:

- **Any wallet can read it, if you have the passkey.** Switch wallets, or open the stream with no wallet connected, and the passkey still unlocks it. Writing still needs the owner or an approved writer.
- **Each stream gets its own key.** The same passkey gives an unrelated key for every stream.
- **It works only in the explorer, on the site that made the passkey.** The CLI can't unlock passkey streams yet, and a stream encrypted on [mnemonad.vercel.app](https://mnemonad.vercel.app) opens only there.

The limits are the same as for passkey accounts: no recovery if the passkey is lost, and the authenticator must support PRF. See [Passkey-based encryption](../encryption/passkey.md).

## Same API after unlocking

Applications do not need separate read and write logic for every encryption method.

Once a Mnemonad instance is unlocked, the same API can be used normally:

```javascript
await stream.at(0)
await stream.push(data)
for await (const piece of stream.stream(0)) { /* … */ }
```

Encryption and decryption happen transparently underneath. The same is true for the CLI: `pull`, `push`, `diff`, `watch` and `search` work the same way on encrypted and public streams, once they have the password or the key.

This means application code can largely treat encrypted storage in the same way as public storage.

## Personal storage

A user could maintain an encrypted personal workspace:

```text
/user/
  documents/
  photos/
  notes/
  settings.json
  data.sqlite
```

```bash
mnemonad push /user --manifest --encrypt --encrypt-with wallet   # once
mnemonad push /user --manifest                                   # after each change
mnemonad pull <stream-id> /user --manifest                       # on another device, with the same key
```

The workspace can be accessed from different devices or applications while remaining encrypted in decentralized storage.

With a [passkey account](#passkey-accounts), the other device needs no key at all: sign in with the same synced passkey, and the account and its keys come back.

The user is not tied to a particular backend provider or application database.

`pull` makes the folder match the stream exactly, and deletes local files that are not in it. Push from one device before you pull on another.

## Shared storage

Password-based streams can also be used as simple shared encrypted workspaces.

For example:

```text
/project/
  brief.md
  research/
  design/
  dataset.csv
  report.pdf
```

A user can share the stream identifier and password with a collaborator.

Both users can then read the same encrypted dataset without sharing wallet signing keys:

```bash
mnemonad pull <stream-id> /project --password "<password>"
```

Conceptually:

```text
Alice
   ↓
 shared password
   ↓
Encrypted Mnemonad Stream
   ↑
 shared password
   ↑
Bob
```

The password gives read access only. Writing is a separate permission. Only the owner, and addresses that the owner approves, can push. The CLI pushes only as the owner. To let Bob write, Alice approves his address from code, and Bob writes with the password:

```javascript
await stream.setWriterApproval(bobAddress, true); // Alice, as owner
```

A push from the CLI replaces the latest version of the whole folder. If two people push from different copies, the later push removes the other's changes from the latest version. Take turns: pull, change, push.

Bob does not need the CLI to read. He can open the stream in the [Mnemonad explorer](https://mnemonad.vercel.app) and enter the password there.

Anyone with the password can decrypt the stream, so the password itself should be treated as the full credential.

Access cannot be taken back. A person who once had the password can keep the data key, and the data key never changes. They can read every past version and every future one.

## AI agent private memory

Encrypted streams are also useful for AI agents.

An agent may need persistent memory while keeping that memory private:

```text
/agent/
  profile.json
  memory.sqlite
  conversations/
  tasks/
  artifacts/
```

The agent can pull and unlock the stream at startup, use it throughout its execution, and push the updated state before shutting down:

```bash
mnemonad pull <stream-id> /agent --manifest   # start
mnemonad push /agent --manifest               # before shutdown
```

Another authorized instance can later unlock the same stream and continue from the same state.

This gives agents persistent memory without requiring that memory to remain publicly readable on-chain. See [Persistent memory for AI agents](persistent_ai_agents_memory.md) for the full workflow.

## Encrypted backups

Mnemonad can also be used for encrypted backups.

For example:

```text
/backups/
  documents.tar.gz
  database.sqlite
  app-config.json
  photos.zip
```

The data is encrypted before it is stored, on-chain or on IPFS, while the stream maintains its persistent identity and history.

A new machine or application can later retrieve and decrypt the same backup:

```bash
mnemonad pull <stream-id> /restore --version 12
```

See [Verifiable backups and data history](backups_and_data_history.md).

## Flexible key management

Mnemonad's encryption architecture does not depend on one specific authentication method.

Today, encrypted streams can use:

```text
password
wallet signature (including a passkey-derived wallet, through Mera)
```

The wallet method needs a wallet that returns the same signature for the same message every time. Standard ECDSA wallets do this.

The underlying model allows other KEK derivation methods to be added later.

For example:

```text
hardware security keys
multi-party access
wallet + password
application-specific key management
```

The storage and encryption layers remain the same.

## Security trade-offs

Encrypted decentralized storage changes where trust lives.

The storage backend does not need to be trusted with plaintext data, but the encryption credential becomes critical.

For password-based streams:

- anyone with the password can decrypt the data
- losing the password means losing access
- there is no password reset mechanism
- a weak password can be cracked offline, because the salt and the wrapped key are public
- sharing cannot be revoked

For wallet-based streams:

- access depends on the ability to reproduce the required wallet signature
- the wallet private key itself is never stored by Mnemonad
- losing the wallet means losing access, and no one else can recover the data
- only the owner can read, so the stream cannot be shared

For passkey accounts, the same rules apply, because a passkey account is a wallet:

- the passkey is the account and the encryption key, so it is a single point of failure
- a synced passkey survives the loss of one device; a passkey on one device only does not
- the account works only on the explorer's domain, where the passkey was created

For both:

- the owner, the sizes and the version count are public
- the stream cannot be transferred to another owner
- the ciphertext stays on chain for good, so a leaked credential exposes every past version

Applications should choose the key-management model that fits their users and recovery requirements.

## Why Mnemonad

Mnemonad combines decentralized persistence with application-level encryption.

It provides:

- AES-256-GCM encryption
- wallet-based key derivation
- passkey accounts, with no extension and no seed phrase
- password-based key derivation
- arbitrary binary storage
- folder-shaped organization
- appendable and versioned state
- automatic on-chain and IPFS storage
- transparent encryption in the CLI and the SDK

The result is decentralized storage that can remain portable and persistent without requiring its contents to be public.
