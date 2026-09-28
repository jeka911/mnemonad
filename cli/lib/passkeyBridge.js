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

/**
 * The CLI half of `--passkey`: opens the explorer's `/cli-auth` page in the system browser
 * to run the WebAuthn ceremony there (this process has no `navigator.credentials` — passkeys
 * only exist in a browser), then relays every signing request to that tab for the rest of
 * this command. The raw key never enters this process, only signatures do — see
 * docs/wallet/passkey-accounts.md's CLI section for why it has to be that domain specifically
 * (rp.id) and why this is a one-shot-per-command bridge rather than something that persists
 * across separate CLI invocations.
 *
 * @param {string} authOrigin - the explorer deployment to open, e.g. https://mnemonad.vercel.app
 * @returns {Promise<Object>} a viem Account whose signMessage/signTransaction proxy to the tab
 */
export async function openPasskeyBridge(authOrigin) {
	if (active) return active.account;

	const token = randomBytes(24).toString('hex');
	const httpServer = createServer((_req, res) => {
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

	const authUrl = `${authOrigin.replace(/\/$/, '')}/cli-auth?port=${port}&token=${token}`;
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
 */
export function closePasskeyBridge() {
	if (!active) return;
	const { wss, httpServer } = active;
	active = null;
	for (const ws of wss.clients) {
		try {
			ws.send(JSON.stringify({ type: 'done' }));
		} catch {
			// Nothing to tell a socket that's already gone.
		}
		ws.close();
	}
	wss.close();
	httpServer.close();
}
