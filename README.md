# Mnemonad

Mnemonad is a decentralized data layer on Monad for storing and syncing files, folders, and filesystem-like state through versioned streams(NFT-backed on-chain containers that represent a folder or other mutable data state over time). It uses snapshots and incremental CDC-based diffs, keeping small chunks on-chain and allowing larger data to be offloaded while preserving verifiable hashes on Monad. Streams, and the filesystems they represent, can be accessed from the dApp, CLI, SDK, or by AI agents, with support for encryption, vector search, and persistent agent memory.

##### Core:

At the protocol layer, Mnemonad is an unbounded bytes[] that lives entirely on-chain on Monad, growing past what any single transaction could hold via chunked/staged writes — exposed as an ERC-721 NFT, so each "stream" is a token you own, and can optionally encrypt client-side. Storage auto-tiers by cost: packed slots -> contract code -> off-chain offload with just a hash+locator kept on-chain, paid for without ever putting a pinning-service credential in the browser. IPFS is the offload backend implemented today, but the pointer format (codec + locator) is deliberately generic, so other backends (Arweave, HTTPS, Filecoin, Walrus, whatever comes next) can be added without a redeploy.

## Try it

- **Tech demo video:** [youtube.com/watch?v=FPoEhaHUoSI](https://www.youtube.com/watch?v=FPoEhaHUoSI) - a walkthrough of Mnemonad in action.

- **Explorer dApp:** [mnemonad.vercel.app](https://mnemonad.vercel.app) - create and browse Mnemonad streams either as raw binary state or through a familiar file-and-folder explorer interface, with support for encryption, media browsing, drag-and-drop uploads, and live sync.

- **Docs** [https://mnemonad.vercel.app/docs](https://mnemonad.vercel.app/docs) - detailed architecture and implementation documentation, itself stored as a set of MD files inside a Mnemonad stream on Monad. The docs are versioned and searchable through vector indexing, serving both as the project’s documentation hub and as a real-world example of the Mnemonad SDK in use.

- **CLI:** [mnemonad-cli](https://www.npmjs.com/package/mnemonad-cli) - the Mnemonad command-line interface for quickly syncing folders to and from the Monad blockchain. It is fully compatible with the Mnemonad file explorer in the dApp, so both interfaces operate on the same streams and filesystem state. Designed for both humans and AI agents.

- **Public Demo Stream** - an unencrypted public Mnemonad stream you can explore in the dApp either as a [browsable filesystem](https://mnemonad.vercel.app/stream/testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8/files) or as its underlying [binary structure](https://mnemonad.vercel.app/stream/testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8)

- **AI agents:** - [`SKILL.md`](https://github.com/jeka911/mnemonad/blob/main/SKILL.md), and the explorer's [`llms.txt`](https://mnemonad.vercel.app/llms.txt) explain how agents can use Mnemonad, while [`mnemonad-agent-memory/`](https://github.com/jeka911/mnemonad/blob/main/mnemonad-agent-memory/SKILL.md) provides a purpose-built skill for using Mnemonad as long-term, cross-session agent memory. Each installs into Claude Code as its own plugin:

  ```bash
  claude plugin marketplace add jeka911/mnemonad
  claude plugin install mnemonad@mnemonad-plugins                # the CLI skill
  claude plugin install mnemonad-agent-memory@mnemonad-plugins   # agent memory
  ```

- **SDK** [npmjs.com/package/mnemonad](https://www.npmjs.com/package/mnemonad) and [npmjs.com/package/monadsync](https://www.npmjs.com/package/monadsync) - JavaScript SDKs for building applications with Mnemonad. `mnemonad` handles blockchain interactions, storage and gas-cost optimizations, encryption, and storing arbitrary binary data on Monad. `monadsync` is a higher-level library that adds file and filesystem abstractions for storing and syncing files, folders, and other filesystem-like state.

- **mnemonad-search-transformers** [mnemonad-search-transformers](https://github.com/jeka911/mnemonad/tree/main/mnemonad-search-transformers) - the Mnemonad CLI and dApp support natural-language search over stream contents using a vector database stored inside the stream itself. This package extends mnemonad-cli’s built-in embedding model, potion-base-8M, with the more capable Xenova/all-MiniLM-L6-v2, while remaining lightweight enough to use as part of a normal build process and compatible with both Node.js and browser environments.

## Take a look at

- **mnemonad smart contracts** [mnemonad/contracts](https://github.com/jeka911/mnemonad/tree/main/contracts) - Mnemonad’s smart contracts manage binary streams on-chain as ERC-721 tokens, including ownership, write permissions, versioned appends, merges, truncation, and deletion. They also handle storage placement, staged writes for larger data, encrypted stream metadata, and integration with the off-chain upload gateway.