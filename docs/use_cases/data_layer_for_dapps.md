# Decentralized Data Layer for dApps

Many decentralized applications eventually need more than smart-contract state.

They may need to store user-generated content, application files, indexes, databases, media, configuration, AI-generated artifacts, or other data that does not fit naturally into contract storage.

Mnemonad can serve as a decentralized data layer for those applications.

Instead of combining several unrelated storage systems, a dApp can use Mnemonad as one persistent layer for arbitrary binary data, folder-shaped state, encrypted content, and evolving application data.

The samples on this page use the [JS SDK](../js/README.md) (`mnemonad` on npm), and [monadsync](../monadsync/README.md) for whole folders. The explorer at [mnemonad.vercel.app](https://mnemonad.vercel.app) is built on the same two packages. For scripts, CI and terminal work, the [`mnemonad` CLI](../cli/README.md) does the same folder sync without code.

## Setup

Every sample below starts from these clients. In a browser, the user's wallet signs:

```js
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { monadTestnet } from 'viem/chains';
import { Mnemonad } from 'mnemonad';

const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });

const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
const walletClient = createWalletClient({ account, chain: monadTestnet, transport: custom(window.ethereum) });

const contractAddress = 'monadTestnet'; // the SDK resolves the known deployment
```

Mnemonad is deployed on Monad testnet only, for now.

## What a dApp can store

A Mnemonad-backed dApp may store:

- user profiles
- application state
- JSON documents
- SQLite databases
- media files
- generated content
- indexes
- configuration
- logs
- game state
- AI memory
- datasets
- backups

For example:

```text
/dapp/
  config.json
  users/
  content/
  database.sqlite
  media/
  indexes/
  logs/
```

All of this can belong to the same logical application workspace: one stream.

```js
const stream = await Mnemonad.create({ publicClient, walletClient, contractAddress, name: 'my-dapp' });

await stream.push(
    new TextEncoder().encode(JSON.stringify({ theme: 'dark' })),
    { name: 'config.json', type: 'application/json' },
);

console.log(stream.id); // keep it: this is the stream's permanent address
```

Without `encrypt`, the stream is public: anyone with its id can read it. That fits public content. For private data, see [Encryption](#encryption).

## Beyond smart-contract state

Smart contracts are good at storing compact, consensus-critical state.

They are usually less convenient for things like:

```text
large files
documents
images
SQLite databases
application indexes
folder structures
AI-generated artifacts
```

Mnemonad complements contract state by providing a more general-purpose persistence layer.

A dApp can keep critical ownership and business logic in smart contracts while using Mnemonad for richer application data.

Conceptually:

```text
Smart contracts
    ↓
ownership, permissions, logic

Mnemonad
    ↓
files, databases, app state, media, history
```

Mnemonad is storage, not a query engine. Other contracts do not read a stream's contents, and a stream does not run queries. The client reads the bytes and does the work. A SQLite file, for example, is read whole and opened in the client (in the browser, with sqlite-wasm).

## One persistent layer

Without a dedicated data layer, a dApp may need to combine:

```text
contract storage
+
object storage
+
IPFS
+
database
+
backup system
+
encryption layer
```

Mnemonad provides one interface over several of these concerns.

From the application point of view, data is pushed and read through one API, while Mnemonad decides where each item is stored. The rule is size: up to 31 bytes go into a storage slot, larger items into on-chain data contracts, and items over the registry's chunk limit (64 KiB on the current deployment) go to IPFS. See [Terms](../terms.md) for the tiers.

## Arbitrary binary data

Mnemonad does not require application state to fit a predefined schema. An item is just bytes, with an optional name and MIME type.

A dApp can store arbitrary binary formats such as:

- JSON
- SQLite
- protobuf
- images
- audio
- video
- PDFs
- compressed archives
- custom application formats

```js
const bytes = new Uint8Array(await file.arrayBuffer()); // e.g. from an <input type="file">
await stream.push(bytes, { name: file.name, type: file.type });

const item = await stream.itemAt(0);
item.itemMeta;                    // { name: 'photo.jpg', type: 'image/jpeg' }
const data = await stream.at(0);  // Uint8Array
```

This makes it possible to persist existing application data without redesigning it around blockchain-specific structures.

Every byte is paid for, and on-chain storage is not refundable. Ask before you write:

```js
const cost = await stream.estimatePushCost(bytes); // gas + protocol fee
```

Items over the chunk limit need an offloading provider. In a browser, that is `MnemonadPresignProvider`, which asks a server for a one-time upload URL. See [IPFS offloading](../js/README.md#ipfs-offloading) in the SDK readme.

## Folder-shaped state

Many applications naturally operate on files and directories.

For example:

```text
/social-app/
  users/
  posts/
  media/
  indexes/
  settings.json
```

or:

```text
/game/
  world/
  players/
  saves/
  assets/
```

monadsync keeps a whole folder in one stream. Each push stores only the diff against the previous version:

```js
import { MonadSync, DoubleSyncMemoryFolder } from 'monadsync';

const root = new DoubleSyncMemoryFolder('social-app');
const alice = await root.ensurePath(['users', 'alice']);
await alice.addFile('profile.json', new TextEncoder().encode(JSON.stringify({ name: 'Alice' })));
await root.addFile('settings.json', new TextEncoder().encode('{}'));

const sync = new MonadSync({ mnemonad: stream, compress: 'gzip' });
await sync.push(root); // first push: full snapshot. Every later push: a diff.
```

Any client restores the same tree:

```js
const reader = new Mnemonad({ publicClient, contractAddress, id: streamId });
const folder = await new MonadSync({ mnemonad: reader }).restore();

const file = await folder.findByPath(['users', 'alice', 'profile.json']);
const profile = JSON.parse(new TextDecoder().decode(await file.getContent()));
```

That makes the storage model easier to reason about for both developers and AI agents.

To see what a stream holds without writing code, open it in the [Mnemonad explorer](https://mnemonad.vercel.app) at `https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`. Anyone can browse a public stream there. An encrypted stream opens for its owner after one wallet signature, or, for a password stream, for anyone with the password.

## Application state over time

dApp state is rarely static.

Users create content, update settings, modify profiles, upload files, generate new artifacts, and change application state continuously.

Mnemonad streams allow that state to evolve over time.

Conceptually:

```text
State 1
   ↓
State 2
   ↓
State 3
   ↓
State 4
```

Each update belongs to the same persistent stream rather than becoming an unrelated object:

```js
const versions = await sync.length();  // how many versions exist
const v2 = await sync.restore(2);      // the folder exactly as it was at version 2
```

This gives applications a natural model for:

- updates
- versioning
- synchronization
- recovery
- history

Each push is an on-chain transaction. Batch changes into one push rather than one per keystroke or per game tick. For many small items, `pushMany` packs them into one transaction and one storage chunk:

```js
await stream.pushMany([eventA, eventB, eventC]);
```

A stream is append-only. Nothing is updated in place. The owner can drop old items from reads with `truncateFrom()`, but this frees no storage and refunds nothing.

## Who can write

The owner of a stream can always write to it. The owner can also approve other addresses as writers:

```js
await stream.setWriterApproval(agentAddress, true);
await stream.canWrite(agentAddress); // true
```

A folder version is the whole folder. If two writers push from different copies, the later push removes what the earlier one added from the latest version. The contract rejects two pushes that race for the same slot, but it cannot merge folders. So:

- **Shared state with many writers:** give each writer its own stream (for example, one stream per user), or append separate items with `push`/`pushMany` instead of pushing whole folders.
- **State with one writer:** one folder stream, pushed by its owner, works well.

## Flexible decentralized storage

Different types of data have different storage requirements.

For example:

```text
small items  → on-chain
large items  → IPFS, with sha256 hash + CID on-chain
```

Mnemonad presents these as part of one logical data layer. `at()` returns the bytes the same way for every tier, and checks every off-chain payload against the hash that is stored on-chain.

The application does not need to expose storage backend details throughout its codebase.

IPFS is the only off-chain backend today. The SDK takes its offloading provider as a parameter, and the on-chain pointer has a codec field, so other backends (Arweave, HTTPS, Filecoin, Walrus) can be added without a contract redeploy. An off-chain copy stays available only while it stays pinned.

## Encryption

Some application data may be public while other data should remain private.

Encryption is chosen once, when a stream is created. With a wallet signature, only the creating account can read the stream:

```js
const privateStream = await Mnemonad.create({
    publicClient, walletClient, contractAddress,
    encrypt: true,
    signer: walletClient, // asks the wallet twice: once for the key, once for the create transaction
});
await privateStream.push(secretBytes); // encrypted before it leaves the browser
```

Later, in a new session, the stream loads locked. One wallet prompt unlocks it:

```js
const s = new Mnemonad({ publicClient, contractAddress, id: streamId });
await s.unlockWithSignature(walletClient);
await s.at(0); // plaintext from here on
```

With a password, everyone who has the password can read it:

```js
// Create (the salt and iteration count are published in the stream's metadata):
await Mnemonad.create({ publicClient, walletClient, contractAddress, encrypt: true, password });

// Read, from any client that knows the password:
const shared = new Mnemonad({ publicClient, contractAddress, id: streamId });
await shared.unlockWithPassword(password);
```

Mnemonad encrypted streams can be used for:

- private profiles
- personal documents
- private AI memory
- internal application state
- encrypted user backups

Encryption is per stream: one key for the whole stream, with no per-recipient keys. For this reason:

- **Wallet encryption** is private to one account. Data that a user must keep private, even from the dApp, belongs in a stream that the user owns and encrypts with their own wallet.
- **Password encryption** shares access with everyone who has the password. A conversation between two people, for example, needs a shared password, and the dApp must exchange it in some other way.
- **An encrypted stream cannot be transferred** to another owner.
- **The owner, version count and item sizes stay public.**

Once unlocked, applications use the same Mnemonad API for encrypted and public data. monadsync works on an encrypted stream unchanged.

This keeps encryption concerns separated from higher-level application logic. See [Encryption](../encryption/encryption.md) for how each method works.

## Example: social application

A decentralized social app may keep identity and ownership logic in smart contracts while storing richer data through Mnemonad.

For example:

```text
/social/
  users/
    alice/
      profile.json
      avatar.jpg
    bob/
      profile.json
      avatar.jpg

  posts/
    post-001.json
    post-002.json

  media/
    image-001.jpg
    video-001.mp4

  indexes/
    feed.sqlite
```

The smart contract may define:

```text
who owns the account
who can update it
which stream belongs to which user
```

while Mnemonad stores the actual application data.

The stream is the unit of ownership and write access. If Alice must control her own profile, `users/alice/` is her own stream, owned by her wallet. Streams are ERC-721 tokens, so a dApp can find a user's streams without its own registry:

```js
const owned = await Mnemonad.listOwned(publicClient, contractAddress, aliceAddress);
```

One shared `/social/` stream is right only for data that the app itself writes, such as `indexes/feed.sqlite`.

## Example: game

A game may keep ownership of characters or assets on-chain while storing its evolving world state in Mnemonad.

```text
/game/
  world.bin
  players/
  inventories/
  quests/
  saves/
  screenshots/
```

A player's wallet may own a character on-chain, while its larger persistent state lives inside a Mnemonad stream.

This allows the game to persist richer state without putting every byte into contract storage.

Write at save points, not on every tick:

```js
await saveSync.push(saveFolder); // one diff per save point
```

If a character is tradable, keep its stream public or password-encrypted. A wallet-encrypted stream cannot follow the character to a new owner.

## Example: AI-powered dApp

An AI application may need to persist:

```text
/ai-app/
  conversations/
  memory.sqlite
  knowledge/
  generated/
  preferences.json
```

The AI agent can read and update the same state that the user accesses through the dApp.

Conceptually:

```text
User
  ↓
dApp
  ↓
Mnemonad Stream
  ↑
AI Agent
```

Both the application and the agent operate on the same persistent data layer. The agent must be able to write: it signs as the owner, or as an address the owner approved with `setWriterApproval`. On a wallet-encrypted stream, only the owner's key can decrypt, so an agent with its own key needs a password-encrypted stream instead.

An agent usually runs outside the browser. The [CLI](../cli/README.md) gives it the same folder through `mnemonad pull` and `mnemonad push`, with no code.

This avoids keeping the agent's memory in a separate centralized backend. See [Persistent AI agent memory](persistent_ai_agents_memory.md) for a full agent workflow.

## Example: decentralized CMS

A CMS can store:

```text
/site/
  pages/
  assets/
  drafts/
  metadata/
  cms.sqlite
```

Editors update content through the UI.

AI agents may generate drafts or modify metadata.

The published website can consume the same persistent state.

```text
Editor
   ↓
Mnemonad
   ↑
AI Agent
   ↓
Website
```

Mnemonad becomes the shared data layer between all three.

Editors and agents must not push the same folder over each other (see [Who can write](#who-can-write)). A practical split is one stream for drafts, written by agents, and one for the published pages, written by editors. The website only reads the published stream:

```js
const site = await new MonadSync({
    mnemonad: new Mnemonad({ publicClient, contractAddress, id: publishedStreamId }),
}).restore();
```

The Mnemonad docs work this way: the explorer's `/docs` page renders them straight from a stream.

## Portable application data

Because Mnemonad data is not locked inside a single application backend, the same stream can be consumed by different clients.

For example:

```text
Web dApp
   ↓
Mnemonad
   ↑
Mobile app
   ↑
CLI
   ↑
AI agent
```

A new frontend or application can reuse the same underlying state. The data is in a public contract and an open format. Any client that can call a Monad RPC endpoint can read it. The JS SDK and the CLI are the ready-made clients today.

This makes application data more portable and reduces dependence on one specific backend implementation.

## Backend-independent applications

Traditional applications often bind data tightly to:

```text
one database
one cloud provider
one backend API
```

Mnemonad lets applications move some of that persistent state into an independently addressable decentralized layer.

The frontend may change.

The backend may change.

The AI agent may change.

The stored state can remain the same.

## Why Mnemonad

Mnemonad can serve as a general-purpose persistence layer for decentralized applications.

It provides:

- arbitrary binary storage
- folder-shaped state
- appendable and versioned data
- automatic on-chain and IPFS storage
- encryption
- support for SQLite and other existing formats
- shared access for users, applications, and AI agents
- portability across clients and environments

The result is a dApp whose data layer can be as decentralized and persistent as the smart contracts that power it.
