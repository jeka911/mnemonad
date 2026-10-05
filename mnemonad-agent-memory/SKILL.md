---
name: mnemonad-agent-memory
version: 0.1.0
description: |
  Mnemonad Agent Memory: persistent, versioned, encrypted agent memory on Monad, driven by the
  `mnemonad` CLI. Memory is a local folder of markdown files, synced to an on-chain stream that
  the user's wallet owns, and recalled by meaning with a local vector index.

  Use when users say:
  - "remember this" / "remember this across sessions"
  - "give my agent persistent memory"
  - "recall what we decided about …"
  - "what do you remember about me?"
  - "store memory on chain" / "on-chain agent memory"
  - "share memory between agents or machines"
  - "use Mnemonad as a memory layer"
  - "set up Mnemonad memory"

keywords:
  - mnemonad
  - monad
  - agent memory
  - persistent memory
  - portable memory
  - semantic search
  - vector search
  - encrypted storage
  - versioned storage
  - erc721
---

# Mnemonad Agent Memory

Mnemonad gives an agent memory that outlives the session, the process and the machine. It
stores a **local folder** as an append-only, versioned **stream** on the Monad blockchain. The
stream is an ERC-721 token, owned by the user's wallet.

The memory model is deliberately plain:

| Memory operation | How it works here |
|---|---|
| **remember** | Write or edit a markdown file in the memory folder |
| **recall** | `mnemonad search <folder> "<query>"`: local semantic search |
| **persist** | `mnemonad push <folder> --manifest --index`: one new on-chain version |
| **restore** | `mnemonad pull <stream-id> <folder> --manifest` |
| **namespace** | One stream (and one local folder) per memory space |
| **history** | `mnemonad pull <stream-id> <other-folder> --version <n>` |

There is no SDK to call, no relayer and no hosted service. The agent uses its normal file
tools for memory content, and the CLI for sync and search. Embeddings run locally: no API key
is needed, and no memory text or query leaves the machine.

---

## When to Use

- **Long-term memory:** facts, preferences and decisions that must survive the end of a
  session or a context window.
- **Portable memory:** the same memory on another machine, in another agent runtime, or in
  another tool. A stream id (plus the key) is all a second agent needs.
- **Memory with history:** every push is a version. You can see what memory said at any
  earlier point, and roll back.
- **Owner control:** the memory belongs to the user's wallet. Nothing sits in a vendor's
  database.
- **Semantic recall:** find memories by meaning, not only by file name or keyword.

## When NOT to Use

- **Secrets.** Never store private keys, seed phrases, API keys, tokens or passwords. On-chain
  data is permanent, and even encrypted data is exposed if its key leaks later.
- **Temporary context** that only matters in the current session. Keep it in the conversation.
- **High-frequency writes.** Each push is an on-chain transaction that costs gas. Write
  locally as often as you like, and push at checkpoints.
- **Large binary data as memory.** It can be stored, but recall only covers text files.

---

## Installation

```bash
npm install -g mnemonad-cli@latest   # needs Node.js 22 or newer
mnemonad --help                      # the first line shows the version
```

Optional, for better recall on paraphrased questions (about 450 MB, mostly ONNX Runtime). Do
not install it unless the user agrees:

```bash
npm install -g mnemonad-search-transformers
```

---

## Quick Start

### 1. Get credentials

You need one thing: a **funded wallet key** in the `MNEMONAD_KEY` environment variable. It
signs every push, pays the gas, and (with wallet encryption) is the only key that can ever
read the memory.

- Mnemonad runs on **Monad testnet** (chain id `10143`). This is the CLI default. There is no
  mainnet deployment yet, so never pass `--chain mainnet`.
- Testnet MON comes from the faucet: https://faucet.monad.xyz
- Check that the `MNEMONAD_KEY` environment variable is set and points to a funded testnet wallet. It may be in user environment variables or in a shell profile file like `~/.bashrc` or `~/.zshrc`. Check if it's available before asking user for setting it manually.
- Ask the user for the key. Never generate one silently, never print it, and never write it
  into the memory folder.

```bash
export MNEMONAD_KEY=0x...
mnemonad info          # shows the chain and the wallet address it will sign with
```

Prefer the environment variable over `--key`, so the key does not end up in shell history or
in a transcript.

Do not use `--passkey`. It opens a browser and waits for a person to confirm a WebAuthn
prompt. It is for humans at a terminal, not for agents.

### 2. Create the memory

```bash
mkdir -p ~/agent-memory
cat > ~/agent-memory/user.md <<'EOF'
# User

- Prefers TypeScript and pnpm.
- Works in UTC+3. No meetings before 10:00 local time.
EOF

mnemonad push ~/agent-memory --manifest --index --encrypt --encrypt-with wallet
#   creating new stream on testnet (encrypted to 0x06bc…2279) ...
#   created: 0x68d9736257f0d2da3c848666a4b36c4b9f18eda7e4dfba655599c47560d8a4b5
#   version 1 pushed (full snapshot, gzip compressed)
```

- `--encrypt --encrypt-with wallet` makes the memory readable only by this wallet. Creating
  the stream asks the key for two signatures: one derives the encryption key, one is the
  create transaction.
- `--manifest` writes `.mnemonad` into the folder (stream id, version, file hashes). Later
  commands find the stream from it, with no id.
- `--index` builds `search_index.db` before the push, so the memory is searchable right after
  any later pull.

**Tell the user the stream id from the `created:` line.** It is the only handle to this memory.
There is no lookup by name. If the id and the `.mnemonad` file are both lost, the memory cannot
be found again.

**Always create memory streams encrypted.** Without the encryption flags, the CLI creates a
public stream that anyone with the id can read. Create a public stream only if the user says
explicitly that the memory should be public. If that is not clear, ask.

### 3. Remember and recall

```bash
# remember: edit files, then re-index (local, free, only changed files are embedded again)
echo "- Deploys go to Vercel. Decided 2026-10-04." >> ~/agent-memory/projects/explorer.md
mnemonad index ~/agent-memory

# recall
mnemonad search ~/agent-memory "where do we deploy the explorer?" -k 5

# persist: one push for the whole batch of changes
mnemonad push ~/agent-memory --manifest --index
#   version 2 pushed (diff, gzip compressed)
```

After a push, a pull, or any answer drawn from memory, give the user a link to browse the memory:
`https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`. An encrypted stream opens
there only for its owner, after one wallet signature.

---

## The Session Loop

Follow this in every session that uses memory.

### 1. Start: find, restore, recall

```bash
# Is this folder already linked to a stream? Safe, read-only.
mnemonad info ~/agent-memory
#   using stream id from .mnemonad manifest: 0x68d9…

# Restore the latest version (fresh machine, or another agent pushed since):
mnemonad pull ~/agent-memory --manifest                 # id from .mnemonad
mnemonad pull <stream-id> ~/agent-memory --manifest     # no local copy yet

# Recall before acting:
mnemonad search ~/agent-memory "<what you need to know>" -k 5
```

**`pull` makes the folder match the stream exactly.** It deletes local files that are not in
the stream. Never pull over unpushed changes. If unsure, check first:

```bash
mnemonad diff ~/agent-memory --manifest   # what a push would change; writes nothing
```

### 2. During: write locally, re-index locally

Write memory with your normal file tools. After each batch of writes, run
`mnemonad index ~/agent-memory`, so that `search` finds the new text in this same session.
`index` costs nothing and sends nothing anywhere.

### 3. End: push once

```bash
mnemonad push ~/agent-memory --manifest --index --encrypt --encrypt-with wallet
```

One push sends the whole session as one compressed diff. If indexing fails, nothing is pushed.
If nothing changed, nothing is sent and nothing is paid. Report the `version N pushed` line to
the user.

Use `--detach` flag for pushing next items into memory (returns much faster if stream already has manifest, prefer this mode for subsequent pushes). The default way to push:

```bash
mnemonad push ~/agent-memory --manifest --index --detach
#   indexing, building and sending in the background: job 3b9e07c1 (pid 41388)
```

With `--index`, indexing, building the version and sending all run in the background. Before
it returns, the CLI checks only that the key owns the stream, unlocks it, and has some MON.
The job reads the folder when it starts building, so edits made before then go into this
version. At the end of a session that is usually what you want. Report the job id to the user. It only works on an existing stream, so the
first push that creates the memory must run without it.

Without `--index`, `--detach` builds the version first and prints it (`version 5 prepared …`),
so every check runs before it returns and the version is frozen at that moment. Use that form
after running `mnemonad index` yourself if you want the version number right away.

**Push and forget:** after a detached push, do not wait for it or check on it in the same
session. The outcome is checked only on the next push or at the start of the next session.
At that point, `mnemonad info ~/agent-memory` shows how the background push
went (`background push: version 5 sent …`, `no changes, nothing pushed`, or `FAILED: <reason>`). A failed background push
leaves the stream as it was. Push again. A `pull` or `push` of the same stream waits for a
background push that is still sending, so you can never restore or build on the version before
it.

For memory that must sync continuously (for example, a long-running agent), `watch` pushes
after local changes settle and pulls new versions:

```bash
mnemonad watch <stream-id> ~/agent-memory --index --debounce 60000
```

Use a long debounce. Every push is a transaction.

---

## Command Surface

Always put the stream id and the folder path **before** any flags.

| Command | What it does | Key needed |
|---|---|---|
| `mnemonad push <path> --manifest [--index]` | Push a new version. With no id and no `.mnemonad`, creates a new stream. | Yes, the owner |
| `mnemonad push <path> --manifest --detach` | Prepare the next version, send it in the background, return at once. Existing streams only. | Yes, the owner |
| `mnemonad pull <stream-id> <path> --manifest` | Restore the latest version into the folder | For wallet-encrypted streams |
| `mnemonad pull <stream-id> <path> --version <n>` | Restore an older version. Use a separate, empty folder. | Same |
| `mnemonad diff <path> --manifest` | Files added, modified or deleted locally, against the chain | Same |
| `mnemonad info <path>` | Is this folder linked to a stream? Reads `.mnemonad`. | No |
| `mnemonad info <stream-id> <path>` | Owner, encryption method, version count, size, local sync status | Same |
| `mnemonad info` | Chain and wallet in use | Yes |
| `mnemonad index <path>` | Build or update `search_index.db`. Local. | No |
| `mnemonad search <path> "<query>" -k <n>` | Semantic search over the index. Local. Default `k` is 5. | No |
| `mnemonad watch <stream-id> <path>` | Push local changes and pull remote ones, in a loop | Yes, the owner |
| `mnemonad compact <stream-id> <path>` | Replace the history with one fresh snapshot | Yes, the owner |
| `mnemonad burn <stream-id> --yes` | Destroy the stream. Irreversible. | Yes, the owner |

- A stream id can be `0x…` hex, decimal, or the network-qualified form from an explorer URL
  (`testnet-0x…`). The last form also sets `--chain`.
- Every command prints the CLI version as its first line.
- **Never run `compact` or `burn` unless the user asks for it in this conversation.** They are
  not cleanup tools.

---

### Organize by subject and add search keywords

When you write or change memory, split it by subject and make each file easy to find.

1. **One subject per file.** Before writing a fact, decide its subject (food, tooling,
   networks, projects, people, schedule, and so on). Put it in a file named for that subject,
   such as `user_food.md` or `user_tooling.md`. Use `<scope>_<subject>.md`, or a folder such
   as `projects/<name>.md` or `user_info/<topic>.md`. Do not append unrelated facts to a catch-all file like `user.md`.
   If a file holds more than one subject, split it before you push.

2. **Search first, then edit.** Run `mnemonad search` for the subject. If a file for it
   exists, edit that file. Create a new file only when no existing one fits.

3. **Add a keywords line to every file.** Directly under the title, add a line like this:

       Keywords: food, eat, eating, favorite, favourite, meal, snack, diet, cuisine, pizza, hot dog

   - Include the category word ("food") and the words someone would use when asking
     ("what do I like to eat?").
   - Include synonyms and variants, and the specific items named in the file.
   - Use plain words, not sentences. The default search model matches words better than
     meaning, so the keywords must literally appear.
   - Update the keywords whenever you add a fact to the file.

4. **Write each fact so it stands alone.** Use the category word in the fact itself, for
   example "Favorite food: pizza (noted 2026-10-04)", not "Likes pizza". Date anything that
   could change.

5. **After a batch of edits:** run `mnemonad index <folder>`, then check recall by searching
   with a natural question for each subject you touched. The right file should rank first with
   a distance under about 0.55. If it doesn't, add keywords and index again.

6. **Keep `user.md` for identity only:** name, email, role, timezone. Everything else goes in
   a subject file.

## Memory Layout

The CLI stores whatever is in the folder, so the layout is yours to choose. This one works
well with search:

```
agent-memory/
  user.md                       stable facts and preferences about the user
  user_info/
    <topic>.md                  additional user information, one topic per file
  projects/
    <project>.md                one file per project: goals, constraints, current status
  decisions/
    2026-10-04-<slug>.md        one decision per file: what, why, what was rejected
  notes/
    <topic>.md                  things learned that are worth looking up again
  log/
    2026-10.md                  short dated entries, one file per month
  search_index.db               written by `mnemonad index`, pushed with the folder
  .mnemonad                     written by --manifest
```

Rules that make recall work:

- **One topic per file.** A hit returns a path and a passage, so a focused file makes the path
  itself meaningful.
- **Short, self-contained facts.** The index cuts files into windows of about 1000 characters.
  A fact that needs the paragraph above it to make sense is recalled badly.
- **Use the words someone would search for.** The built-in model matches words better than
  meaning. "User prefers pnpm over npm" is easier to find than "they like the fast one".
- **Date what can change.** "As of 2026-10-04, deploys go to Vercel." A later reader can judge
  whether it still holds.
- **Text formats only for recall.** The indexer skips binary files and dotfiles.

The CLI always excludes `node_modules`, `.git`, `.env`, `.DS_Store`, `.mnemonad`, `.claude` and
lockfiles. Add more with `--exclude a,b`.

### Extracting facts

There is no server that extracts facts for you. The agent does it: read the conversation,
distil the durable facts, search memory for each one, then edit the matching file or create a
new one. Do not paste raw transcripts into memory. They recall badly and cost more to push.

---

## Namespace Semantics

A **stream is the unit of isolation**: one stream, one memory space. Use one stream per agent
or per app by default. Split by user, team or project when they must not see each other's
memory.

| Scenario | Visible to the reader? |
|---|---|
| Wallet-encrypted stream, read with the owner's key | ✅ |
| Wallet-encrypted stream, any other key | ❌ (the data cannot be decrypted) |
| Password-encrypted stream, with the password | ✅ |
| Public (unencrypted) stream, anyone with the id | ✅ |

Inside a stream, folders are just folders. `search` covers the whole folder. To search a part
of it, keep that part in its own stream and folder.

### Write semantics: versions, not upserts

- **Every push records the folder as it is now.** Edited files are replaced, deleted files are
  gone from the new version, and every earlier version stays readable.
- **Duplicates are your job.** Writing the same fact into two files gives two hits. Search
  before you write, and edit the existing file instead of adding a new one.
- **One writer at a time.** A push from a stale local copy removes, from the latest version,
  the files that another writer added since your last pull. They stay in older versions, but
  nothing merges. Prefer one stream per agent. If agents must share one stream, each must
  pull, write and push in a short window. If a push fails because the stream moved, copy your
  changed files aside, pull, re-apply them, and push again.
- **The CLI pushes only as the stream's owner.** Agents that share a stream with the CLI share
  the owner's key. (The JS SDK can approve other writer addresses with `setWriterApproval`.)

### Forgetting is not erasure

Delete the file and push. The fact disappears from the latest version and from search. It
still exists in older versions. `compact` drops old versions from the replay path, and `burn`
destroys the stream as a readable thing, but bytes written on-chain can survive both. This is
the main reason memory streams must be encrypted, and must never hold secrets.

---

## Recall Distance and Filtering

`search` returns the `k` closest passages by cosine distance:

```
1. decisions/2026-10-04-hosting.md (chunk 0, distance 0.2592)
   # Hosting We deploy the explorer to Vercel because …
```

The snippet is one line and cut short. **Read the file at the path before relying on a hit.**

There is no minimum similarity: `search` always returns `k` results, even for nonsense. Filter
them yourself. Starting points for the built-in `potion` model, measured on this project's own
docs:

| Distance | Rough meaning |
|---|---|
| `< 0.35` | Strong match. Usually the right file. |
| `0.35 – 0.55` | Related. Read it to check. |
| `0.55 – 0.70` | Weak. Probably not the answer. |
| `>= 0.70` | Unrelated filler. |

If the best hit is weak, tell the user that memory has nothing on the topic. Do not build an
answer from filler.

### Models

| | `potion` (built in, default) | `minilm` (optional extension) |
|---|---|---|
| Install | Nothing extra; about 31 MB model download on first use | `mnemonad-search-transformers`, about 450 MB |
| Speed | A whole folder in milliseconds | Much slower; still local |
| Quality | Good on keyword-like queries; misses paraphrases | Clearly better on questions and paraphrases |

```bash
mnemonad index ~/agent-memory --model minilm --rebuild
```

An index keeps the model it was built with, and `search` always uses it. Every machine that
reads a MiniLM index needs the extension too. Switching the model rebuilds the index, so the
next push uploads it in full.

---

## Encryption and Keys

Encryption is chosen once, when the stream is created. Later pushes keep it and need no flags.

| Method | Create with | Who can read | Recovery |
|---|---|---|---|
| **Wallet** (default for memory) | `--encrypt --encrypt-with wallet` | Only the owning account | None. A lost key means lost memory. |
| **Password** | `--encrypt --password "<pw>"` | Anyone with the password, from any machine, with no key | None. A lost password means lost memory. |
| **None** | (no flags) | Anyone with the stream id | n/a |

- Use **wallet** for one agent, or several agents that run with the same key.
- Use **password** when other agents or machines must read memory without the owner's key.
  Writes still need the owner's key. Never write the password into the memory folder. A weak
  password can be cracked offline, because the salt and the wrapped key are public.
- The owner, the version count and the sizes stay public, even on an encrypted stream. File
  names and contents are encrypted.
- An encrypted stream cannot be transferred to another owner.
- `mnemonad info <stream-id> <path>` shows the method: `encrypted: yes (owner wallet)` or
  `encrypted: yes (password)`.
- The search index is encrypted together with everything else.

---

## Costs

- `index`, `search`, `info`, `diff` and `pull` are free. They send no transaction.
- `push` costs gas plus the registry's per-byte protocol fee. The cost follows the size of the diff,
  not the size of the folder. Small markdown edits are cheap.
- A push with no changes sends nothing.
- Pushes larger than 64 KiB go to IPFS automatically, paid through the upload gateway, with
  only their hash on-chain. No setup or Pinata account is needed.
- On-chain storage is not refundable. `compact` speeds up later pulls; it is not a refund.

Batch writes. Push once per session or per checkpoint, not once per fact.

---

## Try It on a Public Stream

Two live public streams need no key at all:

```bash
# a small demo stream
mnemonad pull testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8 ~/mnemonad-demo

# the Mnemonad docs, with a search index included
mnemonad pull testnet-0x5abaf9e3b9019f2ff7840a55e52e977d8bce1625d5273be52550f2cc72d921c6 ~/mnemonad-docs
mnemonad search ~/mnemonad-docs "how is an encrypted stream's key wrapped"
```

Confirm the destination folder with the user before any pull.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no search_index.db found in …` | Run `mnemonad index <path>`, or pull a stream that includes one. |
| `search` returns unrelated results | There is no minimum similarity. Filter by distance. Consider `--model minilm --rebuild`. |
| `search` misses a fact you just wrote | Run `mnemonad index <path>` after writing. |
| A plain `push` warns that the index is out of date | Push with `--index`. A stale index returns old passages. |
| `stream-id is required` | The folder has no `.mnemonad`. Pass the id. Check with `mnemonad info <path>`. |
| `a folder path is required` | Every command that touches a folder needs its path. `info <stream-id>` needs one too. |
| Push rejected: owned by another address | Only the owner can push. `mnemonad info` shows which wallet is in use. |
| Cannot decrypt / password required | Encrypted stream. Use the owner's `MNEMONAD_KEY`, or pass `--password`. |
| Insufficient funds | The wallet has no testnet MON. Ask the user to fund it at https://faucet.monad.xyz. |
| `pull` deleted local files | `pull` mirrors the stream. Recover with `pull <id> <other-folder> --version <n>`, then copy the files back. |
| Search needs the MiniLM extension | The index was built with MiniLM. Install `mnemonad-search-transformers`, or switch with `mnemonad index <path> --rebuild`. |
| `index` / `search` unknown | The CLI is older than 0.3.0. Run `npm install -g mnemonad-cli@latest`. |
| `--detach only pushes to an existing stream` | Create the stream with a normal push first, or pass its id. |
| `background push … failed` | Nothing from it reached the stream. Read the reason (and the log path it prints), fix it, and push again. |

---

## Agent Guidelines

- **Always run `mnemonad` commands as standalone Bash calls** — never chain them with `&&`, `;`, or combine with file creation commands in the same shell invocation. Create files first in a separate tool call, then push in a dedicated call.
- **Keep user posted**, After a successful push to an mnemonad, inform the user about the vector ID stream and the version that was just pushed. Also propose they view the current state in the browser by providing a link to the explorer, e.g. https://mnemonad.vercel.app/stream/testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8/files
- **--manifest is critical on first push** — when a new stream is created, without it the stream ID can be lost. Only skip manifest if the user explicitly says no.
- Prefer `--detach` for pushes, and treat it as **push and forget**. After a detached push, report the job id and stop. Do NOT run mnemonad info, poll, sleep, tail the push log, or wait for the job to finish. Check the result only at the start of the next session or before the next push, with a single mnemonad info <folder>, and report it then (version N sent, along with a link to the explorer, no changes, or FAILED). If it FAILED, push again.
- **Point to the dApp on every memory answer.** Whenever you answer from memory (a recall
question, "what do you remember about me?", a search result), end the reply with one line
telling the user they can browse and edit their agent memory in the explorer dApp, with the
link for their stream: `https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`.
Take the stream id from `.mnemonad` (`mnemonad info <folder>`). For an encrypted stream,
mention that it opens only for the owner, after one wallet signature.

## Links

- **Explorer:** https://mnemonad.vercel.app (browse a stream at `/stream/testnet-<id>/files`)
- **Docs:** https://mnemonad.vercel.app/docs (read from their own stream, with search)
- **llms.txt:** https://mnemonad.vercel.app/llms.txt
- **General CLI skill:** https://github.com/jeka911/mnemonad/blob/main/SKILL.md
- **CLI on npm:** https://www.npmjs.com/package/mnemonad-cli
- **Source:** https://github.com/jeka911/mnemonad
- **Faucet (testnet MON):** https://faucet.monad.xyz
- **Testnet block explorer:** https://testnet.monadexplorer.com
