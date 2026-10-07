# Mnemonad

##### TLDR:

On the base protocol layer, Mnemonad is an infinite bytes[] that lives entirely on-chain on Monad — append-only and unbounded in length, growing past what any single transaction could hold via chunked/staged writes — exposed as an ERC-721 NFT, so each "stream" is a token you own, can grant others write access to, and can optionally encrypt client-side. Storage auto-tiers by cost: packed slots → contract code → off-chain offload with just a hash+locator kept on-chain, paid for without ever putting a pinning-service credential in the browser. IPFS is the offload backend implemented today — the pointer format (codec + locator) is deliberately generic, so other backends (Arweave, HTTPS, Filecoin, Walrus, whatever comes next) can be added without a redeploy.

As we extend it — sets of streams, version control, sync, richer per-item structure, more offload backends — that base layer is what stays fixed underneath.

It ships as smart contracts, an SDK, a CLI, a dApp, and a set of supporting tools — not just a protocol spec.

## Try it

- **Explorer dApp:** [mnemonad.vercel.app](https://mnemonad.vercel.app) — browse streams, create
  and unlock them, push items, and read the [docs](https://mnemonad.vercel.app/docs), which are
  themselves a Mnemonad stream, rendered with search.
- **CLI:** sync any folder to a stream from a terminal:

  ```bash
  npm install -g mnemonad-cli
  export MNEMONAD_KEY=0x...     # a funded Monad testnet key
  mnemonad push ~/my-data --manifest --encrypt --encrypt-with wallet
  ```

- **AI agents:** [`SKILL.md`](SKILL.md) and the explorer's [`llms.txt`](https://mnemonad.vercel.app/llms.txt)
  explain the CLI to an agent; [`mnemonad-agent-memory/`](mnemonad-agent-memory/SKILL.md) is a
  skill for using a stream as an agent's long-term memory.

Published on npm:

| Package | Version | Source |
|---|---|---|
| [`mnemonad`](https://www.npmjs.com/package/mnemonad) | 0.0.1 | [`js/`](js/) — the SDK |
| [`monadsync`](https://www.npmjs.com/package/monadsync) | 0.0.2 | [`monadsync/`](monadsync/README.md) — versioned folder sync |
| [`mnemonad-cli`](https://www.npmjs.com/package/mnemonad-cli) | 0.3.3 | [`cli/`](cli/README.md) — the `mnemonad` command |

`mnemonad-search-transformers` (the optional MiniLM model for vector search) is not on npm yet.

## What's built

- **Streams:** append-only, unbounded, ERC-721-owned `bytes[]` with automatic storage tiers
  (slot, contract code, IPFS). See [`docs/terms.md`](docs/terms.md) for the vocabulary.
- **Encryption:** AES-256-GCM, chosen per stream at creation, with the key wrapped by either a
  **password** or the owner's **wallet signature**. See
  [`docs/encryption/encryption.md`](docs/encryption/encryption.md).
- **Passkey accounts:** sign in to the explorer with a passkey instead of a wallet extension,
  through [Mera](https://mera.category.xyz/); the CLI can borrow the same account with
  `--passkey`. See [`docs/wallet/passkey-accounts.md`](docs/wallet/passkey-accounts.md).
- **Folder sync:** a folder as a versioned stream, each push a content-defined-chunking diff —
  `push`, `pull`, `diff`, `watch`, `compact`, and `push --detach` to send in the background.
  See [`cli/README.md`](cli/README.md).
- **Vector search:** a local semantic index that travels with the folder, so a pulled stream is
  searchable at once, from the CLI or in the explorer. See [`docs/search.md`](docs/search.md).
- **Use cases:** backups, dApp data, app state, agent memory, and encrypted personal storage —
  see the [use cases](docs/README.md#use-cases).

## Layout

| Path | What |
|---|---|
| [`contracts/`](contracts/) | The Solidity registry contract + paid-upload gateway, Hardhat 3 project |
| [`js/`](js/) | The JavaScript/TypeScript SDK (`mnemonad` on npm) |
| [`monadsync/`](monadsync/README.md) | DoubleSync + Mnemonad: versioned folder-tree sync on-chain |
| [`cli/`](cli/README.md) | The `mnemonad` command: folder sync, encryption, passkeys, vector search |
| [`mnemonad-search-transformers/`](mnemonad-search-transformers/README.md) | Optional MiniLM embedding model for the CLI's vector search |
| [`explorer/`](explorer/README.md) | Vue 3 + Quasar block explorer / demo app, deployed at [mnemonad.vercel.app](https://mnemonad.vercel.app) |
| [`presign-server/`](presign-server/) | Issues Pinata upload URLs against paid on-chain escrow |
| [`docs/`](docs/README.md) | Documentation — published as its own stream and rendered at `/docs` |
| [`mnemonad-agent-memory/`](mnemonad-agent-memory/SKILL.md) | Agent skill: a stream as an AI agent's long-term memory |
| [`SKILL.md`](SKILL.md) | Agent skill: using the CLI |
| [`scripts/`](scripts/) | Deployment, ABI-sync, docs and sample-dataset publishing |
| [`sample_datasets/`](sample_datasets/) | Small example folders for the dataset scripts |


## Status

Test MVP, **live on Monad testnet** (not mainnet). 113 Solidity + 338 SDK + 172 CLI +
35 monadsync + 15 server + 4 search-extension tests passing. Current deployment is recorded in [`js/ids.js`](js/ids.js) — the deploy scripts
write it there, and the gateway address is read from the registry rather than recorded, so
the two cannot disagree.