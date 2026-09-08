# Mnemonad Explorer

Vue 3 + Quasar app for browsing and creating Mnemonad streams: connect a wallet,
create a stream, push items across the SLOT/CODE/EXTERNAL tiers, and pay for
off-chain IPFS storage through the upload gateway. See the root
[`README.md`](../README.md) for what Mnemonad itself is.

## Running

```bash
cp .env.example .env      # see below for what each variable does
pnpm install
pnpm dev
```

The SDK is pulled in from the sibling [`../js`](../js) directory by path (see
`vite.config.js` for how its own dependencies resolve without a workspace link), so
`pnpm install` there too if it hasn't been already.

`.env` variables:

| | |
|---|---|
| `VITE_PRESIGN_URL` | The [presign server](../presign-server/) for paid IPFS uploads. Omit to disable that flow entirely. |
| `VITE_IPFS_GATEWAY` | Read gateway for IPFS content. Use a Pinata **dedicated** gateway, not the shared one — see `presignProvider.js` for why. |
| `VITE_ENABLE_LOCAL_SIGNER` | Adds a "connect with a private key" option, for testing without a browser wallet. See [Local Signer in dApp](../docs/testing/local-signer.md). |

## Stack

Vue 3 (Options API) + Quasar 2 + Pinia + vue-router, built with Vite 5.
`@wagmi/vue` + `@wagmi/core` + viem for the chain connection, single-chain config
built from whichever network is active (see `settings.js`). Pages self-register —
`pages/index.js` globs `./*.vue` and reads `path`/`title` off each default export,
so a new page needs no central route table entry.

Conventions (indentation, quoting, etc.) are covered in the root
[`README.md`](../README.md#conventions).
