# Persistent Memory for AI Agents

AI agents often need to remember much more than a single conversation.

They may accumulate knowledge, maintain working state, generate files, build indexes, track tasks, or continue work across different sessions and devices. Mnemonad can act as a persistent storage layer for that state.

An agent keeps its memory in an ordinary local folder, and syncs that folder to a Mnemonad `Stream`. When the process ends, the memory stays on chain. Any later process, on any machine, can pull it back and resume from the same state.

The examples on this page use the [`mnemonad` CLI](../cli/README.md), which an agent can call like any other shell tool. An agent that runs in a browser or in its own Node process can use the [JS SDK](../js/README.md) and [monadsync](../monadsync/README.md) directly instead.

## What an agent can store

A Mnemonad-backed agent workspace may contain:

- conversation history
- long-term memory
- user preferences
- task state
- checkpoints
- prompts and configuration
- knowledge files
- embeddings and vector indexes
- SQLite databases
- generated images, documents, and other binary artifacts

For example:

```text
/agent/
  profile.json
  memory/
    long-term.md
    conversations/
      2026-10-01.jsonl
      2026-10-02.jsonl
  tasks/
    backlog.json
    completed.jsonl
  knowledge/
    notes.md
    docs/
  state/
    session.json
    checkpoint.bin
  memory.sqlite
  artifacts/
    report.pdf
    diagram.png
  search_index.db
```

`search_index.db` is the built-in vector index, written by `mnemonad index` (see [Searchable memory](#searchable-memory)).

Never put secrets in the workspace: API keys, private keys, tokens or passwords. On-chain data is permanent.

## Persistent across sessions

An agent writes its state into the folder during execution, and pushes it:

```bash
export MNEMONAD_KEY=0x...   # the account that owns the agent's memory

mnemonad push /agent --manifest --encrypt --encrypt-with wallet
#   created: 0x68d9…a4b5
#   version 1 pushed (full snapshot, gzip compressed)
```

The first push creates the stream. `--manifest` records its id in `/agent/.mnemonad`, so later pushes need no id:

```bash
mnemonad push /agent --manifest
#   version 2 pushed (diff, gzip compressed)
```

Every later push stores only a compressed diff of what changed.

Later, another process, CLI command, or agent instance can load the same stream and continue from where the previous one stopped:

```bash
mnemonad pull <stream-id> /agent --manifest
```

This allows agent state to survive:

- process restarts
- browser reloads
- device changes
- application upgrades
- migration between different agent runtimes

Each push is an on-chain transaction. Write to the local folder as often as needed, and push at checkpoints: at the end of a task step, or at the end of a session.

## Folder-shaped memory

Agent memory does not have to be represented as a single blob.

Mnemonad stores a whole folder of files and directories, so agents can organize memory in the same way they would use a local workspace.

This is useful for agents that operate on:

```text
memory/
knowledge/
tasks/
artifacts/
checkpoints/
```

rather than a single serialized object. The agent reads and writes these with its normal file tools. The CLI is only needed to pull at the start and push at checkpoints.

## Searchable memory

An agent can search its memory by meaning, not only by file name. The CLI builds a local vector index of the folder's text files:

```bash
mnemonad index /agent
mnemonad search /agent "what did the user say about deadlines?" -k 5
#   1. memory/long-term.md (chunk 3, distance 0.2871)
#      The user wants the report before Friday …
```

The embedding model runs locally. No API key is needed, and no text leaves the machine. The index is a plain file in the folder, so it is pushed with everything else. The next agent that pulls the stream can search at once, with no re-embedding:

```bash
mnemonad push /agent --manifest --index   # update the index, then push
```

See [Vector search](../search.md) for how the index works.

## Binary data

Agent memory is not limited to text.

Because Mnemonad stores arbitrary binary data, an agent can persist things such as:

- SQLite databases
- vector indexes
- images
- PDFs
- audio
- compressed datasets
- model-specific state
- application-specific binary formats

The agent does not need a separate storage system for each type of data.

Every pushed byte is paid for, and on-chain storage is not refundable. Large pushes go to IPFS automatically, with only their hash on-chain. Formats that are already compressed (images, audio, archives) do not diff well, so a changed file costs about its full size. Leave out what the agent can rebuild, with `--exclude`.

For a SQLite file, push a consistent copy (`sqlite3 memory.sqlite ".backup …"`), not a file that is open for writing.

## Encryption

Agent memory may contain private or sensitive information.

A stream without encryption is public. Anyone with its id can read it. Encrypted Mnemonad streams store memory with AES-256-GCM, and the same commands read and write it once it is unlocked.

Encryption is chosen once, when the stream is created. There are two methods:

- **A wallet** (`--encrypt --encrypt-with wallet`): only the owning account can read the memory. There is no password to leak, and there is no recovery if the key is lost.
- **A password** (`--encrypt --password "<password>"`): anyone with the password can read the memory, without the owner's key.

The owner, the version count and the sizes stay public. An encrypted stream cannot be transferred to another owner.

The explorer can also sign with a passkey (through Mera), and the CLI can use it with `--passkey`. That flow needs a person to confirm in a browser, so it is for humans, not for autonomous agents.

See [Encryption](../encryption/encryption.md) for how each method works.

## Shared memory

A Mnemonad stream can also become a shared source of state between multiple tools or agents.

For example:

```text
Agent A
   ↓
Mnemonad Stream
   ↑
Agent B

CLI  ←→  same state  ←→  dApp
```

One agent may collect information, another may analyze it, while a user interacts with the same data through a dApp or CLI.

Reading is easy to share: a public stream is open to everyone, and a password stream is open to everyone with the password. Writing has limits:

- **Only the owner, and addresses the owner approves, can push.** The CLI always pushes as the owner, so agents that write with the CLI share the owner's key. Approving other writers needs the SDK's `setWriterApproval`.
- **A push replaces the latest version of the folder.** If two agents push from different copies, the later push removes what the earlier one added from the latest version. Older versions keep it, but nothing merges. Let agents take turns: pull, write, push. Or give each agent its own stream, and let each one read the other's.

## Example: end-to-end research agent workflow

Consider an autonomous research agent asked to investigate a topic over several days and produce a final report.

### 1. Create a workspace

The agent creates a local workspace:

```text
/research-agent/
  config.json
  sources/
  notes/
  memory.sqlite
  tasks.json
  artifacts/
```

Then it creates the stream with the first push:

```bash
mnemonad push /research-agent --manifest --encrypt --encrypt-with wallet
```

The stream may be public or encrypted depending on the use case. Research on public sources can be public. Anything about the user should be encrypted.

### 2. Start the first session

The agent receives a task:

```text
Research decentralized storage options for AI agent memory.
```

It creates an initial task state in `tasks.json`:

```json
{
  "goal": "Research decentralized storage options for AI agent memory",
  "status": "in_progress",
  "completedSteps": [],
  "nextStep": "Collect primary sources"
}
```

### 3. Collect and persist knowledge

As the agent works, it stores source material and notes:

```text
/sources/ipfs.md
/sources/filecoin.md
/sources/walrus.md
/notes/storage-comparison.md
```

It may also maintain a SQLite database:

```text
memory.sqlite
```

containing extracted facts, metadata, citations, and relationships between sources.

All of this is written locally. The agent re-indexes after each batch of notes, so it can search what it just wrote. This is local and free:

```bash
mnemonad index /research-agent
```

### 4. Create a checkpoint

Before finishing the current execution, the agent updates `tasks.json`:

```json
{
  "completedSteps": [
    "Collected IPFS documentation",
    "Collected Filecoin documentation",
    "Compared persistence models"
  ],
  "nextStep": "Analyze cost and retrieval trade-offs"
}
```

Then it pushes the whole session as one version:

```bash
mnemonad push /research-agent --manifest --index
#   version 4 pushed (diff, gzip compressed)
```

The agent process can now terminate completely.

Its working state remains available through Mnemonad.

### 5. Resume later

A new agent process starts the next day:

```bash
mnemonad pull <stream-id> /research-agent --manifest
mnemonad search /research-agent "cost of storing data on IPFS" -k 5
```

It reads `tasks.json`, opens `memory.sqlite`, and immediately sees:

```text
Next step: Analyze cost and retrieval trade-offs
```

There is no need to replay the entire previous conversation or rebuild the research context from scratch.

### 6. Continue from another environment

The next execution does not have to happen on the same machine.

The same stream can be opened from:

```text
local CLI
    ↓
Mnemonad
    ↑
browser agent (JS SDK)
    ↑
server-side worker (CLI or JS SDK)
```

Each environment can work with the same persistent state. A wallet-encrypted stream needs the owner's key in each environment.

`pull` makes the folder match the stream exactly, and deletes local files that are not in it. An environment must push its changes before another one pulls.

### 7. Generate artifacts

The agent eventually produces:

```text
/artifacts/storage-comparison.csv
/artifacts/architecture.png
/artifacts/final-report.pdf
```

These files may contain arbitrary binary data and can live alongside the agent's structured memory and task state.

### 8. Hand off to another agent

A second agent can open the same workspace and perform a different role.

For example:

```text
Research Agent
    ↓
Mnemonad Stream
    ↓
Review Agent
```

The review agent pulls the stream, reads the accumulated sources, notes, SQLite database, and report, then adds:

```text
/notes/review.md
/artifacts/final-report-v2.pdf
```

and pushes a new version. For this, the research agent must have pushed its last changes, and the review agent must be able to push (see [Shared memory](#shared-memory)). The research agent pulls before it continues.

The workspace becomes a persistent collaboration layer between agents.

### 9. User inspects the same state

The user can open the stream in the [Mnemonad explorer](https://mnemonad.vercel.app), at `https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`, and browse the same workspace:

```text
sources/
notes/
tasks.json
memory.sqlite
artifacts/
```

The explorer shows the latest files and the number of versions. Older versions are read with `pull --version`. Because the workspace has `search_index.db`, the explorer also shows a search box for it. Anyone can browse a public stream. An encrypted stream opens only after it is unlocked: by the owner's wallet for a wallet-encrypted stream, or with the password for a password stream.

The user can also check the workspace from a terminal:

```bash
mnemonad info <stream-id> /research-agent    # owner, versions, size, sync status
mnemonad pull <stream-id> /review-copy --version 3
```

The data is not hidden inside the runtime of a particular agent framework.

It is an independently addressable piece of persistent state.

### 10. Continue indefinitely

The same stream can keep evolving as the agent:

- learns new information
- updates its memory
- creates new files
- receives additional tasks
- generates new artifacts
- hands work to other agents

The stream effectively becomes the agent's long-lived workspace. Every earlier version stays available with `pull --version`, unless the owner compacts the history with `mnemonad compact`.

## Why Mnemonad

Mnemonad gives AI agents a persistent state layer that is:

- independent of a particular machine
- accessible from different applications
- capable of storing arbitrary binary data
- appendable and versioned
- searchable by meaning, with a local model
- folder-shaped
- optionally encrypted
- backed by decentralized storage

The result is an agent whose memory, files, and working state do not disappear when the process that created them stops.
