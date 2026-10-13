# Mnemonad and AI Agents

Mnemonad is built to be used by AI agents as much as by people. An agent can push a folder to Monad as a versioned, encrypted stream, pull any version of it back, see what changed, and search it by meaning, all from the command line, with no browser and no wallet extension.

**Tech demo video:** [youtube.com/watch?v=FPoEhaHUoSI](https://www.youtube.com/watch?v=FPoEhaHUoSI)

There are three ways for an agent to learn Mnemonad:

| Entry point | What it is | Best for |
|---|---|---|
| **The `mnemonad` skill** | A full agent guide to the CLI, installable as a Claude Code plugin | Any folder storage and sync task |
| **The `mnemonad-agent-memory` skill** | A guide to using a stream as the agent's own long-term memory | Memory that outlives the session |
| **`llms.txt` and the explorer** | A short reference that agents find on their own from any explorer link | Zero setup: just hand the agent a URL |

## Agents use the CLI, not the dApp

Writing through the [explorer dApp](https://mnemonad.vercel.app) needs a browser wallet extension to sign, which an agent generally can't operate. The [`mnemonad` CLI](../cli/README.md) does the same work headlessly:

```bash
npm install -g mnemonad-cli@latest
export MNEMONAD_KEY=0x...   # signs pushes, and reads wallet-encrypted streams
```

Reading a public stream needs no key at all. Every guide below steers agents to the CLI, and keeps the explorer for people: after a push or a pull, the agent gives the user a link to browse the stream there.

## Discover it from a link

The fastest way to get an agent started needs no install and no instructions. Give it an explorer link and ask what it is:

```text
Find out what https://mnemonad.vercel.app/stream/testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8/files
is, and pull it into ~/mnemonad-demo.
```

This works because the explorer explains itself to agents:

- **Every explorer page** carries a plain-text introduction, which an agent reads even without running JavaScript. It says what Mnemonad is, tells agents to use the CLI rather than the UI, shows the core commands, and links to the full guide and the quick reference.
- **The page header** points to the agent guide with `<link rel="help" href=".../SKILL.md">`.
- **[`llms.txt`](https://mnemonad.vercel.app/llms.txt)**, at the explorer's root, is the quick reference written for language models:
  - how to install the CLI, and to encrypt new streams to the wallet by default;
  - `--manifest`, and using `info` to find a folder's stream id;
  - semantic search with `index` and `search`;
  - the explorer's URL scheme, and the networks.

So from that one prompt, an agent typically:

1. Fetches the page and finds the agent section and `llms.txt`.
2. Installs the CLI with `npm install -g mnemonad-cli@latest`.
3. Looks the stream up, using the id straight from the URL. The CLI accepts the `testnet-0x…` form as-is and sets the network to match:

   ```bash
   mnemonad info testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8 ~/mnemonad-demo
   ```

4. Pulls it, after confirming the destination folder:

   ```bash
   mnemonad pull testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8 ~/mnemonad-demo --manifest
   ```

The same works with any agent that can read a web page and run shell commands, not just Claude Code. A stream that is encrypted still needs its owner's key (or its password) to read; the agent says so instead of guessing.

## The `mnemonad` skill

The skill is the full guide behind all of this: [`SKILL.md`](https://github.com/jeka911/mnemonad/blob/main/SKILL.md). For Claude Code it installs as a plugin from the Mnemonad marketplace:

```bash
claude plugin marketplace add jeka911/mnemonad
claude plugin install mnemonad@mnemonad-plugins
```

Inside a session, the same is `/plugin marketplace add jeka911/mnemonad` and `/plugin install mnemonad@mnemonad-plugins`. Start a new session afterwards. Other agents can read `SKILL.md` directly; it is plain markdown.

### What it teaches the agent

- **When to use Mnemonad, and when not to.** Good for private versioned backups, folder snapshots with full history, incremental sync between machines, and deliberately public datasets. Not for large binaries that change constantly, secrets that may need rotating, or data that may need to be erased: on-chain data is permanent.
- **Encrypt by default.** The CLI creates public streams unless told otherwise, and forgetting the flags gives no error. The skill makes the agent pass `--encrypt --encrypt-with wallet` on every stream it creates, unless the user asked for something public.
- **How to choose the key.** One of three ways, fixed when the stream is created:

  | Method | Who can read it | Use it when |
  |---|---|---|
  | **Wallet** (default) | Only the account that created it | Nothing needs to read it but this key |
  | **Password** | Anyone with the password | Another machine or person must read it without the key |
  | **Public** | Everyone | Publishing is the point, and the user confirmed it |

- **Never lose the stream id.** The id is the only handle to the data. The agent passes `--manifest` on every push and pull, which records the id in `.mnemonad` inside the folder, and runs `mnemonad info <folder>` before assuming a folder isn't synced yet.
- **Every command.** `push`, `pull`, `info`, `diff`, `watch`, `compact`, `burn`, `index` and `search`, with arguments and sample output.
- **Common workflows:**
  - create a stream and verify it by pulling into a scratch folder;
  - roll back with `pull --version`;
  - publish a public dataset;
  - share a folder with a password;
  - shorten a long history with `compact`.
- **How to behave:**
  - Run each `mnemonad` command on its own, so its output shows what happened on chain.
  - After every push, report the stream id and the version, and give the explorer link: `https://mnemonad.vercel.app/stream/testnet-<id>/files`.
  - Say plainly what was created: "Encrypted to your wallet — only this key can read it, and there's no recovery if it's lost."
  - Keep the private key in `MNEMONAD_KEY`, never on the command line, where it would land in shell history and transcripts.
  - Run `diff` before a push it is unsure about. It is free and read-only.
  - Never run `burn` speculatively, and never add `--yes` for the user. It is irreversible.
  - Treat "no changes, nothing to push" as success, not an error.
- **Troubleshooting:** each CLI error message, what causes it, and the fix.

### Example

```text
You:    Back up ~/research to Monad, privately.

Agent:  (checks `mnemonad info ~/research`: the folder isn't linked to a stream yet)
        (runs `mnemonad push ~/research --encrypt --encrypt-with wallet --manifest`)

        Created stream 0x68d9…a4b5 and pushed version 1, encrypted to your wallet:
        only this key can read it, and there's no recovery if it's lost.
        Browse it at https://mnemonad.vercel.app/stream/testnet-0x68d9…a4b5/files
        (it opens for your wallet only, after one signature).
```

## The `mnemonad-agent-memory` skill

The second plugin in the same marketplace turns a stream into the agent's own long-term memory: a folder of markdown notes it writes, searches by meaning, and pushes once per session.

```bash
claude plugin install mnemonad-agent-memory@mnemonad-plugins
```

See [Persistent memory for AI agents](persistent_ai_agents_memory.md) for how to set it up and what Claude does with it.

## Limits

- **Testnet only, for now.** Mnemonad runs on Monad testnet (chain id `10143`); testnet MON comes from the [faucet](https://faucet.monad.xyz).
- **Every push is a transaction.** It costs gas for the size of the change. Reading, `diff`, `info`, `index` and `search` are free.
- **Passkey-encrypted streams stay in the explorer.** The CLI can't unlock them yet, and `--passkey` needs a person to confirm in a browser. Agents use wallet or password encryption.
- **Encryption is chosen once**, when the stream is created, and an encrypted stream can't be transferred to another owner.

## Links

- **Agent guide:** [`SKILL.md`](https://github.com/jeka911/mnemonad/blob/main/SKILL.md)
- **Memory skill:** [`mnemonad-agent-memory/SKILL.md`](https://github.com/jeka911/mnemonad/blob/main/mnemonad-agent-memory/SKILL.md)
- **Quick reference:** [`llms.txt`](https://mnemonad.vercel.app/llms.txt)
- **CLI:** [`mnemonad-cli` on npm](https://www.npmjs.com/package/mnemonad-cli), and its [README](../cli/README.md)
- **Explorer:** [mnemonad.vercel.app](https://mnemonad.vercel.app)
- **Tech demo video:** [youtube.com/watch?v=FPoEhaHUoSI](https://www.youtube.com/watch?v=FPoEhaHUoSI)
