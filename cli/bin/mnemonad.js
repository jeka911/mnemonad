#!/usr/bin/env node

// Intercept process.exit() calls from dependencies so they don't interrupt
// the top-level await before it settles. Converts them to thrown errors that
// our try/catch handles, then sets process.exitCode without calling exit().
// Defensive: harmless if nothing in the dependency chain ever actually calls
// process.exit() mid-await, but cheap insurance if something eventually does.
const _realExit = process.exit.bind(process);
process.exit = (code) => {
    const err = new Error(`process.exit(${code ?? 0})`);
    err._isProcessExit = true;
    err._exitCode = code ?? 0;
    throw err;
};

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { push, pull, info, diff, watch, compact } from '../lib/commands/index.js';
import defaultConfig from '../mnemonad.config.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
    } catch {
        return 'unknown';
    }
})();

// Project-wide operational defaults — see mnemonad.config.js's own comments for what each
// value means and why it's safe to commit. Precedence for every value it feeds
// (`gatewayUrl`, `presignUrl`): CLI flag > env var > that file > the hardcoded fallback
// below (kept in case the import above ever fails).
const CONFIG = defaultConfig || {};

// Same default the explorer dApp uses (explorer/src/mnemonad/presignProvider.js) — a
// public read gateway so pulling/diffing/inspecting a stream with IPFS-offloaded items
// works out of the box, with no setup, for anyone who didn't push it themselves.
const DEFAULT_IPFS_GATEWAY = CONFIG.gatewayUrl || 'https://gateway.pinata.cloud/ipfs/';

// The deployed presign server (presign-server/) this project runs by default — see its own
// README for what it does. Pushing an item too big to fit on-chain uses this automatically
// so a signer needs no Pinata credential of their own; --pinata-jwt still works as a direct
// alternative for anyone who'd rather supply their own.
const DEFAULT_PRESIGN_URL = CONFIG.presignUrl || null;

const USAGE = `mnemonad v${VERSION} — sync local folders to a versioned, diffed stream on Monad

Usage:
  mnemonad push [stream-id] <path> [options]     Sync a folder to a stream (creates if no id)
  mnemonad pull <stream-id> <path> [options]      Restore stream contents to a folder
  mnemonad info [stream-id] [path] [options]      Show stream metadata (path only needed with a stream-id)
  mnemonad diff <stream-id> <path> [options]      List local files added/modified/deleted vs the on-chain version
  mnemonad watch <stream-id> <path> [options]     Watch folder and auto-push/pull
  mnemonad compact <stream-id> <path> [options]   Truncate old history, push a fresh snapshot

<path> is always required wherever a command touches a folder — the CLI never assumes the
current directory. The only exception is \`mnemonad info\` with no stream-id, which just
checks your configured chain/wallet and needs no folder at all.

Options:
  --chain <name>            Chain: testnet, mainnet, local (default: testnet)
  --rpc-url <url>           Override the resolved RPC endpoint (e.g. a local Hardhat node)
  --contract-address <addr> Registry address to use instead of the chain's known deployment
                            (required with --chain local)
  --gateway-url <url>       IPFS gateway for reading externally-offloaded items
                            (default: https://gateway.pinata.cloud/ipfs/, or MNEMONAD_IPFS_GATEWAY env var)
  --presign-url <url>       Presign server for paid IPFS uploads with no Pinata credential
                            (default: the deployed server in mnemonad.config.js, or MNEMONAD_PRESIGN_URL env var)
  --key <privkey>           Monad private key (or set MNEMONAD_KEY env var)
  --phrase <mnemonic>       Mnemonic phrase
  --version <n>             Version to restore/compare (pull, diff, info; default: latest)
  --exclude <p1,p2>         Extra exclude patterns (comma-separated)
  --no-compress             Disable gzip compression
  --encrypt                 Create a new stream encrypted; only applies on creation
  --password <pw>           Password to encrypt a new stream with, or decrypt an existing one
  --pinata-jwt <jwt>        Pinata JWT for IPFS offload of large files (or PINATA_JWT env var)
  --manifest                Write/use .mnemonad manifest for faster change detection
  --force-snapshot          Push a full snapshot regardless of prior history (repairs corrupt streams)
  --poll-interval <s>       Watch: seconds between remote checks (default: 2)
  --debounce <ms>           Watch: ms quiet period before pushing after a change (default: 1000)
  --push-only               Watch: disable auto-pull
  --pull-only               Watch: disable auto-push
  --help                    Show this help
`;

function parseArgs(argv) {
    const args = {
        command: null,
        streamId: null,
        // No cwd fallback — every command that touches a folder requires it explicitly (see
        // shared.js's resolvePath(), which throws a friendly error if it's still null here).
        path: null,
        chain: 'testnet',
        rpcUrl: null,
        contractAddress: null,
        gatewayUrl: process.env.MNEMONAD_IPFS_GATEWAY || DEFAULT_IPFS_GATEWAY,
        presignUrl: process.env.MNEMONAD_PRESIGN_URL || DEFAULT_PRESIGN_URL,
        key: null,
        phrase: null,
        version: null,
        exclude: null,
        compress: 'gzip',
        encrypt: false,
        password: null,
        pinataJwt: process.env.PINATA_JWT || null,
        manifest: false,
        forceSnapshot: false,
        pollInterval: 2,
        debounce: 1000,
        pushOnly: false,
        pullOnly: false,
    };

    const raw = argv.slice(2);

    if (raw.length === 0 || raw.includes('--help')) {
        console.log(USAGE);
        _realExit(0);
    }

    args.command = raw[0];

    let i = 1;

    // Collect up to two positional args: [streamId] [path]. `path` is left null when it
    // isn't given here — never defaulted to cwd — so a command that needs one (every
    // command except a bare `info`) fails fast with a clear error instead of silently
    // operating on whatever directory the CLI happened to be run from.
    // A stream id is a decimal bigint or a 0x-prefixed hex string; anything else is a path.
    const isStreamId = (s) => /^\d+$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s);
    const positionals = [];
    while (i < raw.length && !raw[i].startsWith('--')) {
        positionals.push(raw[i]);
        i++;
    }
    if (positionals.length === 2) {
        args.streamId = positionals[0];
        args.path = positionals[1];
    } else if (positionals.length === 1) {
        if (isStreamId(positionals[0])) {
            args.streamId = positionals[0];
        } else {
            args.path = positionals[0];
        }
    }

    while (i < raw.length) {
        const flag = raw[i];
        if (flag === '--chain' && i + 1 < raw.length) {
            args.chain = raw[++i];
        } else if (flag === '--rpc-url' && i + 1 < raw.length) {
            args.rpcUrl = raw[++i];
        } else if (flag === '--contract-address' && i + 1 < raw.length) {
            args.contractAddress = raw[++i];
        } else if (flag === '--gateway-url' && i + 1 < raw.length) {
            args.gatewayUrl = raw[++i];
        } else if (flag === '--presign-url' && i + 1 < raw.length) {
            args.presignUrl = raw[++i];
        } else if (flag === '--key' && i + 1 < raw.length) {
            args.key = raw[++i];
        } else if (flag === '--phrase' && i + 1 < raw.length) {
            args.phrase = raw[++i];
        } else if (flag === '--version' && i + 1 < raw.length) {
            args.version = raw[++i];
        } else if (flag === '--exclude' && i + 1 < raw.length) {
            args.exclude = raw[++i];
        } else if (flag === '--no-compress') {
            args.compress = false;
        } else if (flag === '--encrypt') {
            args.encrypt = true;
        } else if (flag === '--password' && i + 1 < raw.length) {
            args.password = raw[++i];
        } else if (flag === '--pinata-jwt' && i + 1 < raw.length) {
            args.pinataJwt = raw[++i];
        } else if (flag === '--manifest') {
            args.manifest = true;
        } else if (flag === '--force-snapshot') {
            args.forceSnapshot = true;
        } else if (flag === '--poll-interval' && i + 1 < raw.length) {
            args.pollInterval = Number(raw[++i]);
        } else if (flag === '--debounce' && i + 1 < raw.length) {
            args.debounce = Number(raw[++i]);
        } else if (flag === '--push-only') {
            args.pushOnly = true;
        } else if (flag === '--pull-only') {
            args.pullOnly = true;
        }
        i++;
    }

    return args;
}

const args = parseArgs(process.argv);

console.log(`mnemonad v${VERSION}`);

// A ref'd interval keeps the event loop alive for the duration of the command, in case
// anything in the RPC/fetch stack unref's its own I/O (see the process.exit note above).
const keepAlive = setInterval(() => {}, 60_000);

try {
    if (args.command === 'push') {
        await push(args);
    } else if (args.command === 'pull') {
        await pull(args);
    } else if (args.command === 'info') {
        await info(args);
    } else if (args.command === 'diff') {
        await diff(args);
    } else if (args.command === 'watch') {
        await watch(args);
    } else if (args.command === 'compact') {
        await compact(args);
    } else {
        console.error('Unknown command:', args.command);
        console.log(USAGE);
        process.exitCode = 1;
    }
} catch (err) {
    if (err._isProcessExit) {
        process.exitCode = err._exitCode;
    } else if (err._isUserError) {
        // Expected, actionable failure — message only, no stack trace.
        console.error('Error:', err.message);
        process.exitCode = 1;
    } else {
        console.error('Error:', err.message);
        if (err.stack) console.error(err.stack);
        process.exitCode = 1;
    }
} finally {
    clearInterval(keepAlive);
}
