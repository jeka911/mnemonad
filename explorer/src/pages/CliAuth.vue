<template>
	<div class="cli-auth-page">
		<JPanel accent="header" icon="terminal" iconColor="var(--q-primary)" title="Sign in for the CLI">
			<div class="q-pa-md cli-auth-body">
				<template v-if="!supported">
					<p class="warning">
						Passkeys aren't supported in this browser. Open this link in a recent
						Chrome, Edge, or Safari instead.
					</p>
				</template>
				<template v-else-if="!bridgeParams">
					<p class="warning">
						This page needs to be opened by the <code>mnemonad</code> CLI (it's missing
						the connection details a direct visit wouldn't have) — run a command with
						<code>--passkey</code> instead of opening this URL directly.
					</p>
				</template>
				<template v-else-if="status === 'done'">
					<p v-if="resultOk !== null" class="hint" :class="resultOk ? 'hint--ok' : 'hint--fail'">
						{{ resultOk ? '✓' : '✗' }} {{ resultPrefix }}<router-link
							v-if="resultStreamLink"
							:to="resultStreamLink"
							class="result-link"
						>{{ resultStreamIdShort }}</router-link><template v-else-if="resultStreamIdShort">{{ resultStreamIdShort }}</template>{{ resultSuffix }}
					</p>
					<p v-else class="hint">Disconnected.</p>
					<p class="hint hint--small">You can close this tab.</p>
				</template>
				<template v-else>
					<p class="hint">
						A <code>mnemonad</code> CLI command on this machine is waiting to sign in
						with your passkey. Nothing is sent anywhere except back to that command,
						running locally. Powered by
						<a href="https://mera.category.xyz/" target="_blank" rel="noopener noreferrer">Mera</a>.
					</p>
					<p v-if="description" class="hint hint--small"><code>{{ description }}</code></p>
					<p
						v-if="countdownLabel && (status === 'idle' || status === 'signing')"
						class="hint hint--small"
						:class="{ 'hint--fail': remainingSeconds <= 30 }"
					>
						The CLI gives up waiting in {{ countdownLabel }} — sign in before then, or
						just re-run the command if it's too late.
					</p>

					<GradientButton
						v-if="status === 'idle' || status === 'signing'"
						label="Sign in with your passkey"
						loading-label="Waiting for your passkey..."
						:loading="status === 'signing'"
						:disable="status === 'signing'"
						@click="signIn"
					/>

					<template v-else-if="status === 'connected'">
						<p class="hint hint--small">
							Connected as <strong>{{ address }}</strong>. Keep this tab open while the
							CLI command runs — it'll close this connection when it's done.
						</p>
						<GradientButton label="Disconnect" outline @click="disconnect" />
					</template>
				</template>

				<p v-if="error" class="error">{{ error }}</p>
			</div>
		</JPanel>
	</div>
</template>

<script>
import { JPanel } from 'themed_varmory';
import GradientButton from '../components/GradientButton.vue';
import { getPasskeyPrfOutput, createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { describeError } from '../wallet/passkeyConnector.js';
import { decodeFromBridge } from '../wallet/bridgeCodec.js';
import { formatStreamId } from '../includes/formatStreamId.js';
import { streamPath } from '../includes/streamRoute.js';

const STREAM_ID_RE = /0x[0-9a-fA-F]{64}/;

/**
 * The browser half of `mnemonad ... --passkey` (see cli/lib/passkeyBridge.js and
 * docs/wallet/passkey-accounts.md's CLI section). The CLI opens this page pointing at a
 * loopback WebSocket server it just started; this page runs the same WebAuthn sign-in
 * ceremony `passkeyConnector.js` uses for the dApp, then relays signing requests to it for
 * the lifetime of the tab — the raw key never leaves the browser, only signatures do.
 *
 * Deliberately not wired through `passkeyConnector.js`/wagmi at all: this isn't a wallet
 * connection for this page's own session, it's a one-off signer for someone else's process.
 * Sign-in only (no "create") — a CLI-driven ceremony still has to run on this exact domain
 * (rp.id is bound to it, same as everywhere else in this feature), so it only ever makes
 * sense against a passkey that already exists.
 */
export default {
	name: 'CliAuth',
	// Static route metadata read by pages/index.js to self-register this page.
	path: '/cli-auth',
	title: 'CLI Sign-in',
	components: { JPanel, GradientButton },
	data() {
		// Read once at mount, straight off the URL the CLI opened this page with — never
		// re-derived later, so a copy/pasted link without them just shows the "open this from
		// the CLI" message below instead of half-working.
		const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
		const port = searchParams?.get('port');
		const token = searchParams?.get('token');
		// How long cli/lib/passkeyBridge.js will wait for `hello` before giving up on the
		// whole command — shown as a live countdown below so someone doesn't wander off
		// mid-prompt with no idea there's a clock running at all.
		const ttlSeconds = parseInt(searchParams?.get('ttl'), 10);
		return {
			supported: typeof navigator !== 'undefined' && !!navigator.credentials && !!window.PublicKeyCredential,
			bridgeParams: port && token ? { port, token } : null,
			// What the waiting CLI command actually is (`mnemonad push ~/my-data`) — cli/lib/
			// passkeyBridge.js's own `describeCommand()` builds this into the URL it opens.
			description: searchParams?.get('desc') || null,
			remainingSeconds: Number.isFinite(ttlSeconds) ? ttlSeconds : null,
			// 'testnet' | 'mainnet' | null (--chain local, or an older CLI that predates this
			// param) — which network to link a stream id in the result to. Never guessed: a
			// wrong network in the link would be worse than no link at all.
			network: searchParams?.get('network') || null,
			status: 'idle', // idle | signing | connected | done
			address: null,
			error: null,
			ws: null,
			session: null,
			// Set from the CLI's own `done` message (null for a manual Disconnect click,
			// which has no result to report — see disconnect()).
			resultOk: null,
			resultSummary: '',
		};
	},
	computed: {
		countdownLabel() {
			if (this.remainingSeconds == null) return null;
			const m = Math.floor(this.remainingSeconds / 60);
			const s = this.remainingSeconds % 60;
			return `${m}:${String(s).padStart(2, '0')}`;
		},
		// Every command that leaves a stream behind (push, burn, compact, …) already ends its
		// own console output with a line naming it in full — `resultSummary` is just whatever
		// that line was (see bin/mnemonad.js). Rather than every command learning to hand back
		// structured data for this one page, the full 64-hex-digit id is just picked back out
		// of that text and, when it's there, rendered as a compact link instead of the raw
		// hex — same elision `formatStreamId` already gives every stream id elsewhere in the
		// app, so a result here reads the same as everywhere else.
		resultStreamMatch() {
			return this.resultSummary?.match(STREAM_ID_RE) || null;
		},
		resultStreamIdShort() {
			return this.resultStreamMatch ? formatStreamId(this.resultStreamMatch[0]) : '';
		},
		// Only a link when the CLI also told us which network — see `network` in data().
		resultStreamLink() {
			if (!this.resultStreamMatch || !this.network) return null;
			return streamPath(this.resultStreamMatch[0], { networkId: this.network });
		},
		resultPrefix() {
			if (!this.resultStreamMatch) return this.resultSummary;
			return this.resultSummary.slice(0, this.resultStreamMatch.index);
		},
		resultSuffix() {
			if (!this.resultStreamMatch) return '';
			return this.resultSummary.slice(this.resultStreamMatch.index + this.resultStreamMatch[0].length);
		},
	},
	mounted() {
		// Only meaningful before the CLI actually connects — the bridge's own timeout is
		// specifically for that `hello` round trip (see passkeyBridge.js), not the command as
		// a whole, so this stops itself the moment `status` moves past idle/signing.
		if (this.remainingSeconds != null) {
			this._countdownTimer = setInterval(() => {
				if (this.status !== 'idle' && this.status !== 'signing') {
					clearInterval(this._countdownTimer);
					return;
				}
				this.remainingSeconds = Math.max(0, this.remainingSeconds - 1);
				if (this.remainingSeconds === 0) clearInterval(this._countdownTimer);
			}, 1000);
		}
	},
	beforeUnmount() {
		clearInterval(this._countdownTimer);
		this.teardown();
	},
	methods: {
		async signIn() {
			this.status = 'signing';
			this.error = null;
			try {
				const result = await getPasskeyPrfOutput({ rpId: window.location.hostname });
				const { prfOutput } = result;
				this.session = createSecp256k1SigningSession({ privateKey: prfOutput });
				prfOutput.fill(0);
				const account = toViemAccount(this.session);
				this.address = account.address;
				this.connectBridge(account);
			} catch (e) {
				this.session?.end();
				this.session = null;
				this.status = 'idle';
				this.error = describeError(e)?.message || 'Failed to sign in with a passkey.';
			}
		},
		connectBridge(account) {
			const { port, token } = this.bridgeParams;
			const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`);
			this.ws = ws;

			ws.addEventListener('open', () => {
				ws.send(JSON.stringify({ type: 'hello', address: account.address }));
				this.status = 'connected';
			});

			ws.addEventListener('message', (event) => {
				let msg;
				try {
					msg = JSON.parse(event.data);
				} catch {
					return;
				}
				if (msg.type === 'sign-message') {
					this.respond(msg.id, () => account.signMessage({ message: msg.message }));
				} else if (msg.type === 'sign-transaction') {
					this.respond(msg.id, () => account.signTransaction(decodeFromBridge(msg.transaction)));
				} else if (msg.type === 'done') {
					this.resultOk = msg.ok;
					this.resultSummary = msg.summary || '';
					this.status = 'done';
					this.teardown();
				}
			});

			ws.addEventListener('close', () => {
				if (this.status !== 'done') {
					this.status = 'done';
					this.teardown();
				}
			});

			ws.addEventListener('error', () => {
				this.error = 'Lost the connection to the CLI.';
			});
		},
		async respond(id, run) {
			try {
				const result = await run();
				this.ws?.send(JSON.stringify({ type: 'sign-result', id, result }));
			} catch (e) {
				this.ws?.send(JSON.stringify({ type: 'sign-error', id, error: e?.message || 'signing failed' }));
			}
		},
		disconnect() {
			try {
				this.ws?.send(JSON.stringify({ type: 'done' }));
			} catch {
				// Nothing to tell the CLI if the socket's already gone.
			}
			this.status = 'done';
			this.teardown();
		},
		/** Actually zeroes the key (see docs/wallet/passkey-accounts.md) and drops the socket —
		 *  run on every way this page's job can end: disconnect, the CLI saying it's done, the
		 *  bridge dropping, or the tab itself closing. */
		teardown() {
			this.session?.end();
			this.session = null;
			this.ws?.close();
			this.ws = null;
		},
	},
};
</script>

<style scoped>
.cli-auth-page {
	max-width: 480px;
	margin: 48px auto;
	padding: 0 16px;
}

.cli-auth-body {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.hint {
	font-size: 13px;
	line-height: 1.5;
	opacity: 0.85;
	margin: 0;
}

.hint--small {
	font-size: 12px;
	opacity: 0.7;
}

.hint--ok {
	color: var(--q-positive, #66bb6a);
}

.hint--fail {
	color: var(--q-negative, #e57373);
}

.result-link {
	color: inherit;
	text-decoration: underline;
	text-underline-offset: 2px;
}

.warning {
	color: var(--q-negative, #e57373);
	font-size: 13px;
	margin: 0;
}

.error {
	color: var(--q-negative, #e57373);
	font-size: 12px;
	margin: 0;
}

code {
	font-size: 0.9em;
	opacity: 0.9;
}
</style>
