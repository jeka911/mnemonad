# Mnemonad docs

Mnemonad is an infinite `bytes[]` on chain, one ERC-721 stream per `bytes[]`, with a
content-defined-chunking diff engine on top that turns a folder into a versioned stream: each
push stores only what changed since the last one.

These pages are themselves a Mnemonad stream. They're pushed from the repo's `docs/` folder by
`scripts/push_docs.js`, and this page reads them back from chain. They come with a search index,
so the search box above searches them by meaning.

## Start here

- [Terms](terms.md): what *stream*, *item*, *chunk*, *pointer* and *frame* mean here. They look
  interchangeable and aren't.

## Use cases

- [Verifiable backups and data history](use_cases/backups_and_data_history.md): encrypted,
  versioned backups of databases, files and app state, restorable at any earlier version.
- [Data layer for dApps](use_cases/data_layer_for_dapps.md): files, databases and media next to
  contract state, with SDK samples.
- [Synced folders and app state](use_cases/decentralized_app_state.md): an app's working folder
  synced to a stream with the CLI, version by version.
- [Persistent memory for AI agents](use_cases/persistent_ai_agents_memory.md): an agent's
  workspace that survives the process, searchable by meaning.
- [Encrypted personal and shared storage](use_cases/personal_and_shared_storage.md): private
  workspaces, and folders shared with a password.

## How it works

- [Passkey-derived accounts](wallet/passkey-accounts.md): a wallet-picker option in the
  explorer where the account itself, not just a stream's key, is derived from a passkey, via
  [Mera](https://mera.category.xyz/).
- [Encryption](encryption/encryption.md): public and encrypted streams, and how an encrypted
  stream's key is wrapped.
  - [Password-based](encryption/password.md): a key-encryption key derived from a password.
    It can be shared without handing over a wallet.
  - [Signature-based](encryption/signature.md): a key-encryption key derived from the
    owner's wallet signature. Nothing to remember, and no recovery if the wallet is lost.
  - [With a passkey-derived signer](encryption/passkey.md): the same signature method, but the
    signer itself is a [Mera](https://mera.category.xyz/) passkey account.
- [Item caching](caching.md): what the SDK caches, how each entry is keyed, and why only
  as-stored bytes are ever cached.
- [Vector search](search.md): how a folder's search index is built, shared, and searched from
  the CLI and in the browser.

## Research

- [IPFS CID math](research/ipfs-cid-math.md): whether a client can know a payload's CID before
  uploading it.
- [Upload method selection](research/upload-methods-optimization.md): which storage-tier choices
  the contract forces and which are left to the SDK.

## Testing

- [Local signer in the dApp](testing/local-signer.md): connecting the explorer with a raw
  private key, for testing multi-transaction flows without wallet popups.

## Subprojects

Each package's own README, copied in as-is (relative links rewritten to still resolve from
here — see `scripts/push_docs.js`'s `relinkReadme`) whenever this stream is pushed:

- [`mnemonad` (SDK)](js/README.md)
- [`monadsync`](monadsync/README.md)
- [`mnemonad-cli`](cli/README.md)
- [Contracts](contracts/README.md)
- [Presign server](presign-server/README.md)
- [Search transformers extension](mnemonad-search-transformers/README.md)
