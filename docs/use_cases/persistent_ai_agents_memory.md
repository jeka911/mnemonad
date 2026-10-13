# Persistent Memory for AI Agents

An AI agent forgets everything when its session ends. Mnemonad gives it memory that outlives the session, the process and the machine.

The memory is an ordinary local folder of markdown files. Mnemonad syncs that folder to a `Stream` on Monad: an encrypted, versioned, on-chain record that the user's wallet owns. Any later session, on any machine, can pull the memory back and search it by meaning.

**Tech demo video:** [youtube.com/watch?v=FPoEhaHUoSI](https://www.youtube.com/watch?v=FPoEhaHUoSI)

For Claude Code, all of this comes as a plugin: install it once, and Claude handles memory on its own.

## How it works

| Memory operation | What happens |
|---|---|
| **Remember** | Claude writes or edits a markdown file in the memory folder |
| **Recall** | `mnemonad search` runs a semantic search over a local vector index |
| **Persist** | `mnemonad push` records the folder as one new on-chain version |
| **Restore** | `mnemonad pull` brings the latest version onto any machine |
| **History** | every push is a version, and any earlier one can be pulled back |

There is no hosted service and no API key. Claude uses its normal file tools for the memory itself, and the [`mnemonad` CLI](../cli/README.md) for sync and search. Embeddings run locally, so no memory text or search query leaves the machine.

## Before you install

1. **Node.js 22 or newer**, and the CLI:

   ```bash
   npm install -g mnemonad-cli@latest
   mnemonad --help   # the first line shows the version
   ```

2. **A funded testnet wallet.** Its private key signs every push, pays the gas, and is the only key that can read the memory. Mnemonad runs on Monad testnet, and testnet MON comes from the [faucet](https://faucet.monad.xyz). Put the key in the `MNEMONAD_KEY` environment variable, for example in `~/.bashrc` or `~/.zshrc`:

   ```bash
   export MNEMONAD_KEY=0x...
   ```

   Then check it:

   ```bash
   mnemonad info   # shows the chain, the wallet address and its MON balance
   ```

   Use a wallet made for this, not one that holds anything of value. Claude never prints the key and never writes it into memory.

## Install the plugin

The Mnemonad repository is a Claude Code plugin marketplace. Add it once:

```bash
claude plugin marketplace add jeka911/mnemonad
```

Then install the memory plugin:

```bash
claude plugin install mnemonad-agent-memory@mnemonad-plugins
```

The same marketplace has a second plugin, `mnemonad`, with the general CLI skill: pushing, pulling and restoring any folder, not just memory. Install it too if you want Claude to work with other streams:

```bash
claude plugin install mnemonad@mnemonad-plugins
```

Inside a Claude Code session, the same steps are `/plugin marketplace add jeka911/mnemonad` and `/plugin install mnemonad-agent-memory@mnemonad-plugins`. Start a new session afterwards, so Claude picks up the skill.

## Use it

You don't have to call the skill. Claude loads it when you say things like:

- "Remember this across sessions."
- "Give my agent persistent memory." / "Set up Mnemonad memory."
- "What do you remember about me?"
- "Recall what we decided about the deploy."
- "Share this memory with my other machine."

You can also start it directly with `/mnemonad-agent-memory:mnemonad-agent-memory`.

## What Claude will do

The skill gives Claude a fixed routine. This is what to expect.

### The first time

1. **Check the setup.** It confirms the CLI is installed and `MNEMONAD_KEY` is set, looking in your environment and your shell profile before asking you. It never generates a key on its own.
2. **Create the memory folder**, `~/agent-memory`, with your first facts.
3. **Create the stream, encrypted to your wallet.** It always creates memory encrypted, unless you say the memory should be public:

   ```bash
   mnemonad push ~/agent-memory --manifest --index --encrypt --encrypt-with wallet
   #   created: 0x68d9…a4b5
   #   version 1 pushed (full snapshot, gzip compressed)
   ```

   Creating it asks the key for two signatures: one derives the encryption key, the other is the create transaction.
4. **Give you the stream id.** It is the only handle to this memory. `--manifest` also records it in `~/agent-memory/.mnemonad`, so later commands find the stream without it.

### At the start of a session

1. **Find the memory.** `mnemonad info ~/agent-memory` reads the stream id from `.mnemonad`, and shows whether the folder matches the latest version.
2. **Restore it if needed.** On a new machine, or after another agent pushed, it pulls the latest version. A pull makes the folder match the stream exactly, so Claude checks for unpushed local changes first.
3. **Recall before acting:**

   ```bash
   mnemonad search ~/agent-memory "what package manager does the user prefer?" -k 5
   ```

   It reads the file behind each hit before relying on it. A weak match (a distance above about 0.55) means memory has nothing on the topic, and Claude says so instead of guessing.

### During a session

- **One subject per file.** Facts go into files named for their subject, such as `user_food.md`, `user_tooling.md` or `projects/<name>.md`. `user.md` holds identity only: name, email, role, timezone.
- **Search first, then edit.** If a file for the subject exists, Claude edits it, so the same fact never ends up in two places.
- **Standalone, dated facts.** For example: "Package manager preference: prefers pnpm over npm (noted 2026-10-04)".
- **A keywords line in every file**, with the words someone would search for, so recall finds it.
- **Re-index after each batch of edits.** `mnemonad index ~/agent-memory` is local and free, and makes new facts searchable right away.

### At the end of a session

Claude pushes once, in the background:

```bash
mnemonad push ~/agent-memory --manifest --index --detach
#   indexing, building and sending in the background: job 3b9e07c1
```

The whole session goes up as one compressed diff, and the command returns at once. Claude reports the job id and moves on, without waiting for it. At the start of the next session, `mnemonad info` shows how that push went: `version N sent`, `no changes`, or `FAILED` with the reason. If it failed, Claude pushes again.

### Whenever it answers from memory

Claude ends the answer with a link to the memory in the explorer, `https://mnemonad.vercel.app/stream/testnet-<stream-id>/files`, where you can browse and edit it. An encrypted stream opens there only for your wallet, after one signature.

### What it will not do

- Store secrets: private keys, seed phrases, API keys, tokens or passwords. On-chain data is permanent.
- Paste raw transcripts into memory. It distils the durable facts instead.
- Push after every fact. Each push is a transaction, so it writes locally and pushes at the end.
- Run `compact` or `burn` unless you ask for it in the conversation.
- Use `--passkey`, which needs a person to confirm in a browser.

## Example

```text
You:    What do you know about me?

Claude: (runs `mnemonad info ~/agent-memory`: the folder matches version 18 of 18,
        then reads the memory files)

        Here's what your memory holds. Everything was recorded on 2026-10-04.
        - Tooling: you prefer pnpm over npm, and you don't like Python.
        - Networks: Monad testnet for testing, mainnet for production.
        - Work: your projects live under ~/www/monad.
        - Food: pizza, hot dogs and sushi.

        You can browse and edit this memory in the explorer:
        https://mnemonad.vercel.app/stream/testnet-0x1f29…3d53/files
```

```text
You:    Remember that we deploy the explorer to Vercel.

Claude: (searches memory for "deploy", finds no file for it, writes
        projects/explorer.md with a keywords line and a dated fact, runs
        `mnemonad index`, and at the end of the session pushes in the background)
```

## Memory layout

```text
agent-memory/
  user.md                    identity only: name, email, role, timezone
  user_<subject>.md          one subject per file: food, tooling, networks, …
  projects/<project>.md      goals, constraints, current status
  decisions/<date>-<slug>.md one decision per file: what, why, what was rejected
  notes/<topic>.md           things worth looking up again
  search_index.db            written by `mnemonad index`, pushed with the folder
  .mnemonad                  the stream id, written by --manifest
```

The index is a plain file in the folder, so it travels with the memory. Another machine that pulls the stream can search at once, with no re-embedding. See [Vector search](../search.md) for how the index works.

## Encryption and sharing

Memory streams are encrypted to the owner's wallet by default. Only that wallet can read them, and there is no recovery if the key is lost. The owner, the version count and the sizes stay public; file names and contents are encrypted. See [Encryption](../encryption/encryption.md).

To share memory with another agent or machine:

- **Same key:** give the other machine the same `MNEMONAD_KEY` and the stream id. It pulls, works and pushes like the first one.
- **Read-only, without the key:** create the stream with a password (`--encrypt --password "<pw>"`) instead of the wallet. Anyone with the password can read it, from anywhere. Writing still needs the owner's key.

Only one writer should push at a time. A push records the folder as it is, so a push from a stale copy removes, from the latest version, what another writer added. Older versions keep it, but nothing merges. Pull, write and push in a short window, or give each agent its own stream.

## Costs and limits

- `index`, `search`, `info`, `diff` and `pull` are free. They send no transaction.
- A push costs gas for the size of the diff, not the size of the folder. Small markdown edits are cheap, and a push with no changes sends nothing.
- On-chain storage is not refundable. Deleting a file and pushing removes the fact from the latest version and from search, but older versions still hold it.
- Recall covers text files only.

## Other agents

For the general `mnemonad` skill, and for agents that discover Mnemonad on their own from an explorer link, see [Mnemonad and AI agents](ai_agents.md).

The memory is not tied to Claude Code. Any agent that can run shell commands can follow the same routine with the CLI:

- [`mnemonad-agent-memory/SKILL.md`](https://github.com/jeka911/mnemonad/blob/main/mnemonad-agent-memory/SKILL.md): the memory skill itself, readable by any agent.
- [`SKILL.md`](https://github.com/jeka911/mnemonad/blob/main/SKILL.md): the general CLI skill.
- [`llms.txt`](https://mnemonad.vercel.app/llms.txt): a short agent-facing overview.

An agent that runs in a browser or in its own Node process can use the [JS SDK](../js/README.md) and [monadsync](../monadsync/README.md) directly.

## Links

- **Tech demo video:** [youtube.com/watch?v=FPoEhaHUoSI](https://www.youtube.com/watch?v=FPoEhaHUoSI)
- **Explorer:** [mnemonad.vercel.app](https://mnemonad.vercel.app)
- **CLI on npm:** [mnemonad-cli](https://www.npmjs.com/package/mnemonad-cli)
- **Source:** [github.com/jeka911/mnemonad](https://github.com/jeka911/mnemonad)
- **Testnet faucet:** [faucet.monad.xyz](https://faucet.monad.xyz)
