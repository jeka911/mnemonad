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

import { push, pull, info, diff, watch, compact, burn, buildIndex, search } from '../lib/commands/index.js';
import { parseQualifiedStreamId } from '../lib/commands/shared.js';
import { closePasskeyBridge } from '../lib/passkeyBridge.js';
import { runPushJob } from '../lib/jobs.js';
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
const DEFAULT_IPFS_GATEWAY = CONFIG.gatewayUrl || 'https://azure-casual-firefly-850.mypinata.cloud/ipfs/';

// The deployed presign server (presign-server/) this project runs by default — see its own
// README for what it does. Pushing an item too big to fit on-chain uses this automatically
// so a signer needs no Pinata credential of their own; --pinata-jwt still works as a direct
// alternative for anyone who'd rather supply their own.
const DEFAULT_PRESIGN_URL = CONFIG.presignUrl || null;

// See mnemonad.config.js's own comment on why this has to be a real deployed domain, not a
// placeholder — --passkey opens it to run the WebAuthn ceremony there.
const DEFAULT_AUTH_ORIGIN = CONFIG.authOrigin || 'https://mnemonad.vercel.app';

const USAGE = `mnemonad v${VERSION} — sync local folders to a versioned, diffed stream on Monad

Usage:
  mnemonad push [stream-id] <path> [options]     Sync a folder to a stream (creates if no id)
  mnemonad pull <stream-id> <path> [options]      Restore stream contents to a folder
  mnemonad info [stream-id] [path] [options]      Show stream metadata (path only needed with a stream-id)
  mnemonad diff <stream-id> <path> [options]      List local files added/modified/deleted vs the on-chain version
  mnemonad watch <stream-id> <path> [options]     Watch folder and auto-push/pull
  mnemonad compact <stream-id> <path> [options]   Truncate old history, push a fresh snapshot
  mnemonad burn <stream-id> --yes [options]       Permanently destroy a stream (irreversible)
  mnemonad index <path> [options]                 Build/update a local vector-search index
                                                   for the folder (optional; see below)
  mnemonad search <path> <query> [options]        Search a folder's vector index

<path> is always required wherever a command touches a folder — the CLI never assumes the
current directory. The exceptions are \`mnemonad info\` with no stream-id (just checks your
configured chain/wallet) and \`mnemonad burn\`, which takes no folder at all.

<stream-id> also accepts the network-qualified form shown in the explorer's URLs —
testnet-0x648f18… — paste it straight out of a /stream/<id> link. It sets --chain to match;
pass --chain too only if it agrees, or the command refuses rather than guess which one you meant.

Options:
  --chain <name>            Chain: testnet, mainnet, local (default: testnet)
  --rpc-url <url>           Override the resolved RPC endpoint (e.g. a local Hardhat node)
  --contract-address <addr> Registry address to use instead of the chain's known deployment
                            (required with --chain local)
  --gateway-url <url>       IPFS gateway for reading externally-offloaded items
                            (default: this project's Pinata dedicated gateway, or MNEMONAD_IPFS_GATEWAY env var)
  --presign-url <url>       Presign server for paid IPFS uploads with no Pinata credential
                            (default: the deployed server in mnemonad.config.js, or MNEMONAD_PRESIGN_URL env var)
  --key <privkey>           Monad private key (or set MNEMONAD_KEY env var)
  --phrase <mnemonic>       Mnemonic phrase
  --passkey                 Sign with a passkey instead of --key/--phrase: opens the explorer
                            in your browser to sign in with WebAuthn, then relays signing
                            requests to that tab for this command. Interactive only — not for
                            scripts/CI. See docs/wallet/passkey-accounts.md
  --auth-origin <url>       Explorer deployment --passkey opens (default: this project's
                            explorer deployment, or MNEMONAD_AUTH_ORIGIN env var)
  --version <n>             Version to restore/compare (pull, diff, info; default: latest)
  --exclude <p1,p2>         Extra exclude patterns (comma-separated)
  --no-compress             Disable gzip compression
  --encrypt                 Create a new stream encrypted; only applies on creation
  --encrypt-with <method>   How to key it: password, or wallet (the --key/--phrase account
                            signs for it). Implied by --password; required otherwise
  --password <pw>           Password to encrypt a new stream with, or decrypt an existing one
  --pinata-jwt <jwt>        Pinata JWT for IPFS offload of large files (or PINATA_JWT env var)
  --manifest                Write/use .mnemonad manifest for faster change detection.
                            With no stream-id given, every command recovers it from an
                            existing .mnemonad in <path> instead of requiring it explicitly
  --force-snapshot          Push a full snapshot regardless of prior history (repairs corrupt streams)
  --detach                  push: build the next version here, send it from a background process,
                            and return right away. Existing streams only (an id, or --manifest).
                            Later pushes and pulls of that stream wait for it; \`mnemonad info\`
                            shows how it went
  --index                   push/watch: update the folder's search index (search_index.db)
                            before every push, so the stream is searchable right after a pull.
                            Takes --db/--model/--chunk-size/--chunk-overlap like \`index\`
  --poll-interval <s>       Watch: seconds between remote checks (default: 2)
  --debounce <ms>           Watch: ms quiet period before pushing after a change (default: 1000)
  --push-only               Watch: disable auto-pull
  --pull-only               Watch: disable auto-push
  --yes                     Required by burn — explicit opt-in for an irreversible action
  --db <name>               index/search: vector-index filename (default: search_index.db)
  --model <name>            index / --index: embedding model. \`potion\` (built in, the default for
                            a new index) or \`minilm\` (better on paraphrased queries; needs the
                            optional extension: npm install -g mnemonad-search-transformers),
                            or a full model id. Without it, an existing index keeps its own
                            model. \`search\` always uses the index's own model. All local —
                            no API key, nothing sent anywhere
  --rebuild                 index / --index: start the index over (the way to switch models);
                            the next push uploads the whole index again
  --chunk-size <n>          index: target characters per chunk (default: 1000)
  --chunk-overlap <n>       index: characters of overlap between chunks (default: 150)
  --limit, -k <n>           search: number of results (default: 5)
  --help                    Show this help

index/search are optional and independent of push/pull — a folder with no search_index.db
just has no search capability. \`index\` writes a plain (non-dot-prefixed) file at the
folder's root, so it rides through the next \`push\` like any other file: whoever pulls the
stream gets the index already built, with no re-embedding of their own. \`push --index\` and
\`watch --index\` run \`index\` for you before each push, and a plain \`push\` of a folder whose
index has fallen behind its files says so. See docs/search.md in the repository for how the
index works and stays diff-friendly on repeated pushes.
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
        passkey: false,
        authOrigin: process.env.MNEMONAD_AUTH_ORIGIN || DEFAULT_AUTH_ORIGIN,
        version: null,
        exclude: null,
        compress: 'gzip',
        encrypt: false,
        encryptWith: null,
        password: null,
        pinataJwt: process.env.PINATA_JWT || null,
        manifest: false,
        index: false,
        rebuild: false,
        forceSnapshot: false,
        detach: false,
        pollInterval: 2,
        debounce: 1000,
        pushOnly: false,
        pullOnly: false,
        yes: false,
        query: null,
        searchDb: null,
        model: null,
        chunkSize: null,
        chunkOverlap: null,
        limit: null,
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
    //
    // Also accepted: the network-qualified form the explorer's own URLs use —
    // `<network>-0x<hex>`, e.g. `testnet-0x648f18…` — since that's what an agent naturally
    // has in hand after pulling an id straight out of a /stream/<id> link. A qualified id
    // names the chain the same way the URL does; parseQualifiedStreamId (shared.js, same
    // split the explorer's own parseStreamRouteId does) records which one (chainFromId,
    // below) so it can settle --chain once flags are parsed too.
    const isStreamId = (s) => /^\d+$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s) || !!parseQualifiedStreamId(s);

    let chainFromId = null;
    // Strips a recognized `<network>-` prefix and records the network it named, so every
    // downstream command only ever sees the bare id it already knows how to parse
    // (formatStreamId, `new Mnemonad({id})`, etc. never learn this form exists).
    const takeStreamId = (arg) => {
        const qualified = parseQualifiedStreamId(arg);
        if (!qualified) return arg;
        chainFromId = qualified.network;
        return qualified.id;
    };

    // `-k` is the one short flag — it has to end the positionals too, or `search`'s
    // join-the-rest query below swallows it (`search ./f slow and steady -k 3` once searched
    // for "slow and steady -k 3").
    const isFlag = (arg) => arg.startsWith('--') || arg === '-k';
    const positionals = [];
    while (i < raw.length && !isFlag(raw[i])) {
        positionals.push(raw[i]);
        i++;
    }
    if (args.command === 'search') {
        // <path> <query...> — everything after the path is the query, joined back with spaces
        // so an unquoted multi-word query (`mnemonad search ./docs how does chunking work`)
        // works the same as a quoted one. Never a stream id — `search` doesn't take one.
        args.path = positionals[0] || null;
        args.query = positionals.length > 1 ? positionals.slice(1).join(' ') : null;
    } else if (positionals.length === 2) {
        args.streamId = takeStreamId(positionals[0]);
        args.path = positionals[1];
    } else if (positionals.length === 1) {
        if (isStreamId(positionals[0])) {
            args.streamId = takeStreamId(positionals[0]);
        } else {
            args.path = positionals[0];
        }
    }

    let sawChainFlag = false;
    while (i < raw.length) {
        const flag = raw[i];
        if (flag === '--chain' && i + 1 < raw.length) {
            args.chain = raw[++i];
            sawChainFlag = true;
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
        } else if (flag === '--passkey') {
            args.passkey = true;
        } else if (flag === '--auth-origin' && i + 1 < raw.length) {
            args.authOrigin = raw[++i];
        } else if (flag === '--version' && i + 1 < raw.length) {
            args.version = raw[++i];
        } else if (flag === '--exclude' && i + 1 < raw.length) {
            args.exclude = raw[++i];
        } else if (flag === '--no-compress') {
            args.compress = false;
        } else if (flag === '--encrypt') {
            args.encrypt = true;
        } else if (flag === '--encrypt-with' && i + 1 < raw.length) {
            args.encryptWith = raw[++i];
        } else if (flag === '--password' && i + 1 < raw.length) {
            args.password = raw[++i];
        } else if (flag === '--pinata-jwt' && i + 1 < raw.length) {
            args.pinataJwt = raw[++i];
        } else if (flag === '--manifest') {
            args.manifest = true;
        } else if (flag === '--index') {
            args.index = true;
        } else if (flag === '--rebuild') {
            args.rebuild = true;
        } else if (flag === '--force-snapshot') {
            args.forceSnapshot = true;
        } else if (flag === '--detach') {
            args.detach = true;
        } else if (flag === '--poll-interval' && i + 1 < raw.length) {
            args.pollInterval = Number(raw[++i]);
        } else if (flag === '--debounce' && i + 1 < raw.length) {
            args.debounce = Number(raw[++i]);
        } else if (flag === '--push-only') {
            args.pushOnly = true;
        } else if (flag === '--pull-only') {
            args.pullOnly = true;
        } else if (flag === '--yes') {
            args.yes = true;
        } else if (flag === '--db' && i + 1 < raw.length) {
            args.searchDb = raw[++i];
        } else if (flag === '--model' && i + 1 < raw.length) {
            args.model = raw[++i];
        } else if (flag === '--chunk-size' && i + 1 < raw.length) {
            args.chunkSize = Number(raw[++i]);
        } else if (flag === '--chunk-overlap' && i + 1 < raw.length) {
            args.chunkOverlap = Number(raw[++i]);
        } else if ((flag === '--limit' || flag === '-k') && i + 1 < raw.length) {
            args.limit = Number(raw[++i]);
        }
        i++;
    }

    if (chainFromId) {
        if (sawChainFlag && args.chain !== chainFromId) {
            console.error(
                `Error: the stream id names network '${chainFromId}', but --chain '${args.chain}' was\n` +
                `  also given — they disagree. Drop --chain to use the id's network, or pass\n` +
                `  --chain ${chainFromId} to match it.`
            );
            _realExit(1);
        }
        args.chain = chainFromId;
    }

    return args;
}

const args = parseArgs(process.argv);

console.log(`mnemonad v${VERSION}`);

// A ref'd interval keeps the event loop alive for the duration of the command, in case
// anything in the RPC/fetch stack unref's its own I/O (see the process.exit note above).
const keepAlive = setInterval(() => {}, 60_000);

// --passkey's browser tab shows a result line when the command finishes (see
// closePasskeyBridge()) rather than a bare "done" — commands don't return a summary
// explicitly, so this captures their own last console.log line instead, the same thing this
// terminal already sees. Only wired up when --passkey is in play; every other run's
// console.log is untouched.
const logLines = [];
const originalConsoleLog = console.log;
if (args.passkey) {
    console.log = (...parts) => {
        originalConsoleLog(...parts);
        logLines.push(parts.join(' '));
    };
}
let succeeded = true;
let errorMessage = null;

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
    } else if (args.command === 'burn') {
        await burn(args);
    } else if (args.command === 'index') {
        await buildIndex(args);
    } else if (args.command === 'search') {
        await search(args);
    } else if (args.command === '__push-job') {
        // The detached half of `push --detach` (lib/jobs.js) — never typed by a person.
        await runPushJob(args.path);
    } else {
        console.error('Unknown command:', args.command);
        console.log(USAGE);
        process.exitCode = 1;
    }
} catch (err) {
    if (err._isProcessExit) {
        process.exitCode = err._exitCode;
        succeeded = err._exitCode === 0;
    } else if (err._isUserError) {
        // Expected, actionable failure — message only, no stack trace.
        console.error('Error:', err.message);
        process.exitCode = 1;
        succeeded = false;
    } else {
        console.error('Error:', err.message);
        if (err.stack) console.error(err.stack);
        process.exitCode = 1;
        succeeded = false;
    }
    errorMessage = err.message;
} finally {
    console.log = originalConsoleLog;
    // No-op when --passkey was never used — see passkeyBridge.js. Runs whether the command
    // succeeded or failed, so a browser tab left open on a failed push doesn't linger.
    closePasskeyBridge({
        ok: succeeded,
        summary: succeeded ? (logLines.filter(Boolean).pop() || 'Done.') : (errorMessage || 'Failed.'),
    });
    clearInterval(keepAlive);
}
