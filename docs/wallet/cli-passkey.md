# CLI + passkey

`mnemonad push/pull/diff/watch/compact/burn --passkey` signs with a passkey instead of
`--key`/`--phrase`/`MNEMONAD_KEY`. No raw key on the machine running the CLI — just a browser
tab for the moment it's needed.

## Why a browser at all

The CLI is a Node process. There's no `navigator.credentials` there, and passkeys only exist
in a browser. So `--passkey` borrows one: it opens the explorer's own domain (has to be that
exact domain — a passkey is bound to whichever domain created it), runs the same WebAuthn
sign-in the dApp itself uses (via [Mera](https://mera.category.xyz/), which turns the passkey
into the signing key), then relays signatures back over a local WebSocket for the rest of that
one command. The raw key never leaves the tab.

Sign-in only, no "create" — this only ever works against a passkey that already exists.

## One command, one bridge

No daemon, no state file. The CLI opens a loopback server + a browser tab, the tab connects,
signs whatever that command needs, and both close together when it's done. The next
`--passkey` command repeats the whole thing — a fresh tab, a fresh sign-in. That's the
tradeoff: a human has to be there to click through it every time, so it's for someone running
a command by hand, not for scripts or CI (those keep using `--key`/`MNEMONAD_KEY`).

## What the tab actually shows

- What it's for — the command itself (`mnemonad push ~/my-data`), not just "a CLI command."
- A countdown to when the CLI gives up waiting, kept honest by pinging the CLI directly
  rather than trusting a number computed once at page load.
- The result when the command finishes — success or failure, and whatever the CLI itself
  printed last, with a stream id in there turned into a real link to browse it.

See [passkey-accounts.md](passkey-accounts.md) for the account derivation itself and the
rest of this feature; this page is just the CLI half of it.
