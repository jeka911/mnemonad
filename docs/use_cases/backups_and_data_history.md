# Verifiable Backups and Data History

Backups are useful only if they can be trusted.

Applications may need to preserve database snapshots, user files, logs, configuration, generated artifacts, or complete application state over long periods of time. In many systems, those backups live inside the same infrastructure that created them, which makes them vulnerable to accidental deletion, provider failure, or silent modification.

Mnemonad can be used as a decentralized backup and version-history layer.

A Mnemonad `Stream` gives data a persistent identity and allows new versions to be appended over time, creating a verifiable history of how that data changed.

The examples below use the [`mnemonad` CLI](../cli/README.md), which syncs a folder to a stream. An application can also use the [JS SDK](../js/README.md) directly, to push and read items from its own code.

## What can be backed up

A Mnemonad-backed backup stream may contain:

- database snapshots
- SQLite files
- application state
- configuration
- user files
- documents
- media
- logs
- generated artifacts
- archives
- datasets
- folder snapshots

For example:

```text
/backups/
  app.sqlite
  config.json
  uploads/
  reports/
  logs/
```

The same stream can evolve as new backups are added:

```bash
export MNEMONAD_KEY=0x...     # the account that owns the backups

mnemonad push /backups --manifest --encrypt --encrypt-with wallet
#   creating new stream on testnet (encrypted to 0x06bc…2279) ...
#   created: 0x68d9…a4b5
#   version 1 pushed (full snapshot, gzip compressed)
```

The first push creates the stream and prints its id. `--manifest` records the id in the folder, so the next push needs no id.

`--encrypt --encrypt-with wallet` encrypts the stream with a key derived from a signature of the owner's wallet. Only that account can decrypt it. Streams can also be public, which is the default when you leave these flags out. A public stream is readable by anyone who has its id. That is fine for open datasets or docs, but not for backups, so every example on this page uses an encrypted stream. Encryption is chosen once, when the stream is created. Later pushes keep it, and need no extra flags. See [Encrypted backups](#encrypted-backups) for the details.

## Versioned history

Instead of replacing the previous backup, each push appends a new version. Only the first version is a full snapshot. Every later version is a compressed diff against the one before it.

Conceptually:

```text
Version 1
  app.sqlite
  config.json

      ↓

Version 2
  app.sqlite
  config.json
  uploads/avatar.png

      ↓

Version 3
  app.sqlite
  config.json
  uploads/avatar.png
  reports/monthly.pdf
```

Each version becomes part of the stream's history:

```bash
mnemonad push /backups --manifest           # appends the next version
mnemonad info <stream-id> /backups          # version count, owner, size, local sync status
mnemonad diff <stream-id> /backups --version 2   # what changed locally since version 2
```

This makes it possible to inspect how state changed over time rather than keeping only the most recent copy.

To look inside a backup without the CLI, open it in the [Mnemonad explorer](https://mnemonad.vercel.app) at `https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`. Anyone can browse a public stream there. An encrypted backup opens only for its owner: sign in with the owner's wallet, and one signature unlocks it in the browser.

Versions are numbered, not dated. The stream does not store a time for each version. The time is the time of the block that committed it, which you can read from the chain's event logs. If your restore process selects backups by time, write the time into the folder itself (for example, a `backup.json` with a timestamp) before each push.

## Append-only audit trail

Mnemonad streams are naturally suited to append-oriented workflows.

An application can use a stream to record:

```text
backup #1
backup #2
backup #3
backup #4
...
```

or:

```text
event #1
event #2
event #3
...
```

The CLI covers the first case: each `mnemonad push` is one more version of a folder. The second case, one item per event, uses the [JS SDK](../js/README.md) directly (`push` for one item, `pushMany` for a batch). Each push is an on-chain transaction, so batch events together rather than sending them one by one.

This makes Mnemonad useful not only for backups, but also for maintaining an audit trail of important changes.

Examples include:

- configuration changes
- database migrations
- model outputs
- generated reports
- release artifacts
- agent checkpoints
- application events

Nobody can edit or reorder a committed item, including the owner. The owner can still remove history from reads. `mnemonad compact` (the contract's `truncateFrom`) drops every version before the new snapshot, and `mnemonad burn` destroys the stream. Both are public, on-chain actions, and the truncation leaves an event behind. For an audit trail that the owner must not be able to shorten, keep the stream owned by an account that the audited party does not control.

## Verifiable state

Because stream metadata and state transitions are anchored through Monad, applications can verify that a particular version existed and belongs to the expected stream.

This allows backups to carry more context than a file stored in a random bucket.

A consumer can verify things such as:

- which stream the data belongs to
- in which block a version was committed
- which account controls the stream (`mnemonad info`)
- whether the expected content is still available (`mnemonad pull`)
- whether a local folder matches a stored version (`mnemonad info` and `mnemonad diff` compare tree hashes)
- whether data fetched from off-chain storage matches its recorded hash (checked automatically on read)

The blockchain becomes the durable reference point for the backup history.

## Database backups

One practical example is backing up an application's SQLite database.

The application may use:

```text
/app/
  database.sqlite
```

during normal operation.

At selected intervals, it can persist new versions through Mnemonad.

For example:

```text
09:00  database.sqlite
12:00  database.sqlite
18:00  database.sqlite
23:00  database.sqlite
```

Do not push a database file while the application writes to it. The copy can be inconsistent, and in WAL mode the recent changes are in a separate `-wal` file. Make a consistent copy first, then push the copy:

```bash
sqlite3 /app/database.sqlite ".backup /backups/database.sqlite"
mnemonad push /backups --manifest
```

A scheduler such as cron can run these two commands at each interval. If nothing changed since the last push, `push` sends nothing and costs nothing.

If the local database becomes corrupted or a bad migration is deployed, an earlier version can be restored:

```bash
mnemonad pull <stream-id> /restore --version 3
```

## Application snapshots

A backup does not have to be a single file.

An entire application workspace can be preserved:

```text
/snapshot/
  database.sqlite
  settings.json
  uploads/
  cache/
  generated/
```

That snapshot may represent the full recoverable state of the application at a specific point in time.

Leave out what the application can rebuild. Every pushed byte is paid for, and on-chain storage is not refundable:

```bash
mnemonad push /snapshot --manifest --exclude cache
```

This is useful for applications that need disaster recovery without depending entirely on their primary hosting provider.

## AI agent checkpoints

AI agents can use the same model for checkpointing.

An agent may periodically save:

```text
/agent/
  memory.sqlite
  tasks.json
  context/
  artifacts/
  checkpoint.bin
```

If the process crashes or is moved to another machine, it can restore the latest valid checkpoint and continue:

```bash
mnemonad pull <stream-id> /agent --manifest
```

Earlier checkpoints remain available as part of the same stream history, until the owner compacts or burns the stream.

This is especially useful for long-running autonomous tasks. For memory that an agent also needs to search, see [Persistent AI agent memory](persistent_ai_agents_memory.md).

## Logs and event history

Mnemonad can also store append-only logs.

For example:

```text
/logs/
  events-2026-10-01.jsonl
  events-2026-10-02.jsonl
  events-2026-10-03.jsonl
```

With the CLI, push the log folder like any other folder. A file that only grows becomes a small diff on each push.

To push automatically on each change:

```bash
mnemonad watch <stream-id> /logs --push-only --debounce 60000
```

`watch` pushes after each quiet period. Each push is a transaction, so use a long `--debounce` for logs that change often, or push on a schedule instead.

A single continuously growing event stream, with one item per event, uses the [JS SDK](../js/README.md) directly:

```text
event 1
event 2
event 3
event 4
...
```

This can be useful for:

- application auditing
- agent activity logs
- workflow history
- data processing pipelines
- operational records

The important property is that new state is appended rather than silently replacing the previous history. Removing history is possible only for the owner, and it is visible on chain (see "Append-only audit trail").

## Flexible storage backends

Not every backup needs to live directly on-chain.

Small items are stored on-chain. An item larger than the registry's chunk limit (64 KiB on the current deployment) is moved to IPFS automatically. Only its hash and location are stored on-chain.

For example:

```text
small diffs, metadata → Monad
large snapshot items  → IPFS, with sha256 hash + CID on Monad
```

The CLI does this by default and needs no setup. It pays for the upload through the upload gateway, and the [presign server](../presign-server/README.md) issues the upload URL. To upload with your own Pinata account instead, pass `--pinata-jwt`. You cannot choose per file what goes on-chain. The size of each item decides.

From the application's perspective, these still belong to the same Mnemonad stream. A reader checks every off-chain payload against the hash that is stored on-chain.

This allows backup history to remain verifiable while storage costs stay practical. The off-chain copy stays available only while it stays pinned on IPFS.

## Encrypted backups

Backups often contain private data.

Encrypted Mnemonad streams can protect:

- user databases
- private files
- configuration
- agent memory
- internal application state
- personal archives

Encryption is chosen when the stream is created. A stream without encryption is public. For backups, use wallet encryption:

```bash
mnemonad push /backups --manifest --encrypt --encrypt-with wallet
```

The CLI asks the wallet for two signatures here. The first one derives the stream's encryption key. The second one is the transaction that creates the stream. There is no password to store or leak. The same `MNEMONAD_KEY` that pushes the backups is also the only thing that can read them back. A restore therefore needs that key on the restoring machine:

```bash
export MNEMONAD_KEY=0x...
mnemonad pull <stream-id> /restore --version 43
```

If other people or machines must read the backups without the owner's key, a password-encrypted stream is the alternative: `--encrypt --password "<password>"`. Anyone with the password can then decrypt it.

The backup can remain publicly discoverable as an object while its contents stay unreadable without the corresponding key. The owner, the version count and the item sizes stay public.

Know two limits:

- **Wallet encryption has no recovery.** If the key is lost, the backup cannot be decrypted. Keep the key somewhere that does not fail together with the application.
- **An encrypted stream cannot be transferred** to another owner.

This is especially useful when the storage backend itself should not be trusted with plaintext data. Off-chain items are encrypted before upload, so IPFS only ever holds ciphertext. See [Encryption](../encryption/encryption.md) for how each method works.

## Example: disaster recovery workflow

Consider a small application using a local SQLite database and a directory of uploaded files.

Its working state looks like:

```text
/app/
  database.sqlite
  uploads/
  config.json
```

Every hour, the application creates a new Mnemonad-backed snapshot.

```text
10:00 → version 41
11:00 → version 42
12:00 → version 43
```

At 12:30, a faulty deployment corrupts the local database.

The application can:

```bash
# The stream is wallet-encrypted, so every step runs with the owner's key
export MNEMONAD_KEY=0x...

# 1. Read the stream history
mnemonad info <stream-id> /app

# 2–4. Restore version 43 (database.sqlite, uploads/, config.json) into a clean folder
mnemonad pull <stream-id> /restore --version 43

# 5. Swap /restore in for /app and restart from the last known good state
```

Restore into a separate folder. `pull` makes the target folder match the stored version exactly, and deletes files that are not in it.

The backup system is independent of the failed application instance.

## Example: release history

A project can also use Mnemonad to preserve release artifacts:

```text
/releases/
  v1.0.0/
    app.tar.gz
    checksums.txt
  v1.1.0/
    app.tar.gz
    checksums.txt
  v1.2.0/
    app.tar.gz
    checksums.txt
```

Each release adds a new folder, so each push carries only the new release. Compressed archives do not diff well against each other, so expect each new `app.tar.gz` to cost about its full size.

The stream becomes a persistent release history that can be independently inspected and verified.

## Example: reproducible datasets

Data-processing applications may periodically produce datasets:

```text
/datasets/
  snapshot-001.parquet
  snapshot-002.parquet
  snapshot-003.parquet
```

Each snapshot can remain associated with the same stream and historical sequence.

Parquet files are already compressed, so each new snapshot costs about its full size. Large files go to IPFS automatically (see "Flexible storage backends").

This helps with:

- reproducibility
- rollback
- model evaluation
- auditability
- comparing data across time

## Why Mnemonad

Mnemonad turns backups from isolated files into persistent, versioned data streams.

It provides:

- appendable history
- persistent stream identity
- arbitrary binary storage
- folder snapshots
- decentralized storage backends
- optional encryption
- restore points
- blockchain-backed provenance

The result is a backup history that can survive the application, machine, or provider that originally created it.
