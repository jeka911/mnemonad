# Synced Folders and App State

Many applications need to persist more than simple smart-contract state.

They may need configuration files, user-generated content, SQLite databases, media, game saves, generated artifacts, or complete directory structures that evolve over time.

Mnemonad can act as a decentralized persistence layer for that application state.

Instead of treating every file as a separate storage object, an application can keep its state in a folder and sync that folder to a Mnemonad `Stream`. Every sync appends a new version of the whole folder.

The examples on this page use the [`mnemonad` CLI](../cli/README.md), which does this sync for any folder on disk. An application can also do the same from its own code with the [JS SDK](../js/README.md) and [monadsync](../monadsync/README.md).

## What can be stored

A Mnemonad-backed application may store:

- configuration files
- JSON or binary state
- user-generated content
- SQLite databases
- documents
- images and media
- indexes
- logs
- game saves
- generated artifacts
- complete directory structures

For example:

```text
/app/
  config.json
  users/
    alice.json
    bob.json
  db/
    app.sqlite
  content/
    pages/
      home.md
      about.md
    images/
      hero.png
  state/
    session.json
    index.bin
  logs/
    events.jsonl
```

The whole structure can be treated as one logical piece of application state:

```bash
export MNEMONAD_KEY=0x...   # the account that will own the stream

mnemonad push /app --manifest
#   created: 0x68d9…a4b5
#   version 1 pushed (full snapshot, gzip compressed)
```

The first push creates the stream and prints its id. `--manifest` records the id in `/app/.mnemonad`, so later commands on the same folder need no id.

Caches and other files that the application can rebuild do not belong in the stream. Every pushed byte is paid for, and on-chain storage is not refundable:

```bash
mnemonad push /app --manifest --exclude cache,tmp
```

The CLI always leaves out `node_modules`, `.git`, `.env`, `.DS_Store`, `.mnemonad`, `.claude` and lockfiles.

The pushed folder can also be browsed in the [Mnemonad explorer](https://mnemonad.vercel.app), at `https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`. Anyone can browse a public stream there. An encrypted stream opens for its owner after one wallet signature, or, for a password stream, for anyone with the password.

## Folder-shaped state

Applications often naturally organize data as files and directories.

Mnemonad allows that structure to be persisted without forcing every piece of data into a smart-contract-specific schema.

For example:

```text
cms/
  pages/
  assets/
  drafts/
  metadata.json
```

or:

```text
game/
  world.bin
  players/
  inventories/
  saves/
```

The application keeps working with plain files and directories. The CLI handles persistence underneath.

## Changing state

Application state changes constantly.

A user may:

- edit a document
- add an image
- update a profile
- modify a SQLite database
- generate a new artifact
- remove or rename a file

The stream itself is append-only. Nothing is overwritten. Each push appends a new version that records the folder as it is now, including deleted and renamed files. Only the first version is a full snapshot. Every later version is a compressed diff that carries only the changed bytes.

Conceptually:

```text
Version 1
/app/config.json
/app/db.sqlite

        ↓

Version 2
/app/config.json
/app/db.sqlite
/app/avatar.png

        ↓

Version 3
/app/config.json
/app/db.sqlite
/app/avatar.png
/app/report.pdf
```

The stream becomes the history of how the application's state evolved:

```bash
mnemonad diff /app --manifest                       # what a push would change now
mnemonad info <stream-id> /app                      # version count, owner, sync status
mnemonad pull <stream-id> /app-v2 --version 2       # the folder exactly as it was at version 2
```

To keep the stream in step with the folder automatically, use `watch`. It pushes after local changes settle, and pulls new versions from the stream:

```bash
mnemonad watch <stream-id> /app --debounce 5000
```

Each push is a transaction. For state that changes many times a minute, use a longer `--debounce`, or push from a scheduler instead.

## Arbitrary binary formats

A folder is not limited to text.

Because Mnemonad stores arbitrary binary data, the same application state can contain:

- JSON
- SQLite
- images
- video
- PDFs
- compressed archives
- protobuf data
- custom binary formats

This means the application does not need a different persistence mechanism for each type of content.

The diff works on content-defined chunks of each file, so a small edit to a large file pushes only the changed region. Formats that are already compressed (video, images, `.zip`) do not diff well: a changed file costs about its full size.

## SQLite as application state

One particularly useful pattern is storing an application's SQLite database inside Mnemonad.

For example:

```text
/app/
  db.sqlite
  settings.json
  uploads/
```

The application can continue using SQLite locally while Mnemonad provides persistence and synchronization for the database file.

Do not push the database file while the application writes to it. The copy can be inconsistent, and in WAL mode the recent changes are in a separate `-wal` file. Push a consistent copy:

```bash
sqlite3 /app/db.sqlite ".backup /sync/db.sqlite"
mnemonad push /sync --manifest
```

On another machine:

```bash
mnemonad pull <stream-id> /sync
```

This makes it possible to combine:

```text
local database semantics
        +
folder-shaped state
        +
decentralized persistence
```

without redesigning the entire application around blockchain-native data structures.

A pushed file replaces the earlier one in the next version. Two machines that change the same database and both push do not merge. The later push wins, and the other machine's changes stay only in the history. Keep one writer for a database.

## Storage backends

Not every byte needs to be stored the same way.

The CLI does not store each file as its own object. Each push becomes one diff document, which holds the changed parts of every changed file. The size of that diff decides where it goes:

```text
diff up to 64 KiB      → on-chain
larger diff            → IPFS, with its sha256 hash + CID on-chain
```

A push that only edits `config.json` stays on-chain. A push that adds `video.mp4` goes to IPFS, together with any small change in the same push.

From the application's point of view, all versions belong to the same logical Mnemonad stream. `pull` reads both kinds the same way, and checks every off-chain payload against its on-chain hash.

The CLI uploads to IPFS by default, with no setup. It pays through the upload gateway, and the [presign server](../presign-server/README.md) issues the upload URL. To use your own Pinata account instead, pass `--pinata-jwt`. An off-chain copy stays available only while it stays pinned.

## Encryption

Some application state may be public, while other data should remain private.

A stream is public unless you encrypt it, and encryption is chosen once, when the stream is created:

```bash
# Only the creating account can read it:
mnemonad push /app --manifest --encrypt --encrypt-with wallet

# Anyone with the password can read it:
mnemonad push /app --manifest --encrypt --password "<password>"
```

An application can use encrypted Mnemonad streams for things such as:

- private user files
- draft documents
- personal settings
- private databases
- encrypted backups

Do not store application secrets (API keys, private keys, tokens) in a stream, even an encrypted one. On-chain data is permanent. If the stream's key or password leaks later, every version ever pushed can be decrypted.

Once unlocked, the same commands read and write the data normally. A wallet-encrypted stream needs the owner's `MNEMONAD_KEY`. A password-encrypted stream needs `--password` to read, and the owner's key to push. The owner, the version count and the sizes stay public. An encrypted stream cannot be transferred to another owner.

See [Encryption](../encryption/encryption.md) for how each method works.

## Example: decentralized CMS

Consider a simple CMS backed by Mnemonad.

Its state may look like:

```text
/site/
  config.json
  pages/
    index.md
    about.md
    contact.md
  assets/
    logo.svg
    hero.jpg
  database/
    cms.sqlite
  drafts/
    next-release.md
```

A user edits `about.md`.

The application writes the change to its local folder and pushes the new version to Mnemonad:

```bash
mnemonad push /site --manifest
#   version 7 pushed (diff, gzip compressed)
```

Later, the user uploads a new image:

```text
/assets/team.jpg
```

The next push adds a version that contains that file as well.

The application does not need to maintain separate systems for:

```text
page storage
asset storage
database backups
state history
```

They can all live within the same Mnemonad-backed workspace.

The pages can also be made searchable. `--index` builds a local vector index of the text files before each push, and anyone who pulls the stream gets it ready to search:

```bash
mnemonad push /site --manifest --index
mnemonad search /site "pricing for teams"
```

The Mnemonad docs work this way. The explorer's `/docs` page renders them straight from a stream, with search. See [Vector search](../search.md).

## Example: persistent game state

A game may store:

```text
/game/
  world.bin
  settings.json
  players/
    0x123.json
    0x456.json
  inventories/
  maps/
  screenshots/
```

As players interact with the game, the state evolves.

The game can periodically append new state to Mnemonad, for example at save points:

```bash
mnemonad push /game --manifest
```

A player may later open the game from another device and restore the same world, inventory, and settings from the stream:

```bash
mnemonad pull <stream-id> /game --manifest
```

`pull` makes the folder match the stream exactly, and deletes local files that are not in it. Push from the first device before you pull on the second.

A single stream has a single owner who pushes it. If every player writes their own file, as in `players/`, give each player their own stream. Shared world state stays in a stream that the game server owns.

## Example: application migration

Because the data is not tied to a single application server, another application can read the same state.

For example:

```text
App v1
   ↓
Mnemonad Stream
   ↑
App v2
```

A new version of the application can reuse the same persistent data:

```bash
mnemonad pull <stream-id> /app-v2-data
```

The same principle allows data to be consumed by:

```text
web app
CLI
mobile app
AI agent
backend worker
```

The stream belongs to a wallet, not to any one of these clients. Any of them can read it (with the key or password, if it is encrypted). Only the owner, and the addresses that the owner approves, can push to it.

## Why Mnemonad

Mnemonad allows applications to treat decentralized storage less like a collection of isolated blobs and more like a persistent, evolving folder.

It provides:

- arbitrary binary storage
- folder-shaped organization
- versioned state with full history
- support for SQLite and other binary formats
- automatic on-chain and IPFS storage
- optional encryption
- access from multiple applications and environments

The result is application state that can outlive the process, device, backend, or frontend that originally created it.
