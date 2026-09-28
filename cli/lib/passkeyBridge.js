import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import open from 'open';
import { toAccount } from 'viem/accounts';
import { userError } from './commands/shared.js';
import { encodeForBridge } from './bridgeCodec.js';

const CONNECT_TIMEOUT_MS = 3 * 60 * 1000;

// One bridge per CLI process — `--passkey` resolves at most one signing account per
// invocation (see resolveAccount in chainClient.js), so there's nothing to key this by.
let active = null;

/** A one-line "what's this for" the browser tab shows while it waits — just the command
 *  shape, not the flags, so it stays short. */
function describeCommand(args) {
	const parts = ['mnemonad', args.command];
	if (args.streamId) parts.push(args.streamId);
	if (args.path) parts.push(args.path);
	return parts.join(' ');
}

/**
 * The CLI half of `--passkey`: opens the explorer's `/cli-auth` page in the system browser
 * to run the WebAuthn ceremony there (this process has no `navigator.credentials` — passkeys
 * only exist in a browser), then relays every signing request to that tab for the rest of
 * this command. The raw key never enters this process, only signatures do — see
 * docs/wallet/passkey-accounts.md's CLI section for why it has to be that domain specifically
 * (rp.id) and why this is a one-shot-per-command bridge rather than something that persists
 * across separate CLI invocations.
 *
 * @param {Object} args - parsed CLI args: `authOrigin` (the explorer deployment to open, e.g.
 *   https://mnemonad.vercel.app), plus `command`/`streamId`/`path` to build the one-line
 *   description the page shows while it waits.
 * @returns {Promise<Object>} a viem Account whose signMessage/signTransaction proxy to the tab
 */
export async function openPasskeyBridge(args) {
	if (active) return active.account;

	const token = randomBytes(24).toString('hex');
	// Read by /ping below — the one thing the page can't get from the WS (it doesn't exist
	// yet at that point, see docs/wallet/passkey-accounts.md's CLI section) but still wants
	// live: how much of the connect-timeout is actually left, and confirmation the CLI is
	// still there at all.
	const deadlineAt = Date.now() + CONNECT_TIMEOUT_MS;
	const httpServer = createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (url.pathname === '/ping' && url.searchParams.get('token') === token) {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				// The page is served from the explorer's own origin, not this loopback one —
				// an ordinary fetch() response is otherwise unreadable cross-origin. The token
				// above is what actually gates this, same as the WS connection itself; the
				// wildcard just matches that (no meaningful "origin" to restrict to when the
				// caller could be any explorer deployment this token was ever handed to).
				'Access-Control-Allow-Origin': '*',
			});
			res.end(JSON.stringify({ ttl: Math.max(0, Math.round((deadlineAt - Date.now()) / 1000)) }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	const wss = new WebSocketServer({ server: httpServer });

	await new Promise((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(0, '127.0.0.1', resolve);
	});
	const port = httpServer.address().port;

	const pending = new Map();
	let nextId = 1;
	let socket = null;

	const connected = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			// Nothing ever reached the point (below) that assigns `active`, so
			// closePasskeyBridge() has nothing to close on this path — without this, the
			// server/socket this function opened above would sit open forever, and the CLI
			// process would hang right after printing the error below rather than exiting.
			wss.close();
			httpServer.close();
			reject(userError(
				'Timed out waiting for the browser passkey sign-in. Complete the prompt in the\n' +
				'  tab that opened, or re-run with --passkey to try again.'
			));
		}, CONNECT_TIMEOUT_MS);

		wss.on('connection', (ws, req) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			if (url.searchParams.get('token') !== token) {
				ws.close(4001, 'bad token');
				return;
			}
			socket = ws;

			ws.on('message', (raw) => {
				let msg;
				try {
					msg = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (msg.type === 'hello') {
					clearTimeout(timer);
					resolve(msg.address);
				} else if (msg.type === 'sign-result' || msg.type === 'sign-error') {
					const p = pending.get(msg.id);
					if (!p) return;
					pending.delete(msg.id);
					if (msg.type === 'sign-result') p.resolve(msg.result);
					else p.reject(new Error(msg.error || 'signing failed'));
				}
			});

			ws.on('close', () => {
				if (socket === ws) socket = null;
				for (const p of pending.values()) p.reject(userError('Browser tab disconnected before signing finished.'));
				pending.clear();
			});
		});
	});

	const desc = describeCommand(args);
	const ttl = Math.floor(CONNECT_TIMEOUT_MS / 1000);
	// Lets the result screen turn a stream id in its summary line into a link to the
	// explorer's own stream page — only for a real deployment id (testnet/mainnet); --chain
	// local has no explorer route to link to, so the page just falls back to plain text.
	const network = args.chain === 'testnet' || args.chain === 'mainnet' ? `&network=${args.chain}` : '';
	const authUrl = `${args.authOrigin.replace(/\/$/, '')}/cli-auth?port=${port}&token=${token}&desc=${encodeURIComponent(desc)}&ttl=${ttl}${network}`;
	console.log('  opening', authUrl, 'to sign in with a passkey...');
	try {
		await open(authUrl);
	} catch {
		console.log('  could not open a browser automatically — open this URL yourself:', authUrl);
	}

	const address = await connected;
	console.log('  connected:', address);

	function request(type, payload) {
		if (!socket) {
			return Promise.reject(userError('Browser tab disconnected. Re-run with --passkey to reconnect.'));
		}
		return new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ type, id, ...payload }));
		});
	}

	const account = toAccount({
		address,
		async signMessage({ message }) {
			return request('sign-message', { message });
		},
		async signTransaction(transaction) {
			return request('sign-transaction', { transaction: encodeForBridge(transaction) });
		},
		async signTypedData() {
			// Not used anywhere in this codebase (personal_sign only — see the "Wallet-signature
			// encryption keys" plan's locked-in decision) — a real relay implementation would
			// need the same BigInt-safe encoding sign-transaction already has, not worth building
			// for a path nothing calls.
			throw userError('Signing typed data is not supported over --passkey.');
		},
	});

	active = { wss, httpServer, account };
	return account;
}

/**
 * Called once, at the very end of the CLI's command dispatch (bin/mnemonad.js), whether the
 * command succeeded or failed — a no-op when --passkey was never used. Tells the browser tab
 * it's done so it can end its session and zero the key, mirroring the explorer's own
 * disconnect() lifecycle instead of just abandoning the connection.
 *
 * `result` lets the tab show something more useful than a bare "done" before it closes —
 * whether the command actually succeeded, and the one line of output that says what
 * happened (bin/mnemonad.js captures its own last console.log line for this rather than
 * every command needing to return a summary explicitly).
 *
 * @param {{ok: boolean, summary: string}} [result]
 */
export function closePasskeyBridge(result) {
	if (!active) return;
	const { wss, httpServer } = active;
	active = null;
	const payload = JSON.stringify({ type: 'done', ok: result?.ok ?? true, summary: result?.summary || '' });
	for (const ws of wss.clients) {
		try {
			ws.send(payload);
		} catch {
			// Nothing to tell a socket that's already gone.
		}
		ws.close();
	}
	wss.close();
	httpServer.close();
}
