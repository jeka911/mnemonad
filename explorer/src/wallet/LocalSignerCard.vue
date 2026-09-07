<template>
	<div class="local-signer-card">
		<p class="warning">
			Burner keys only. This key is used exactly as typed to sign real transactions on
			{{ activeNetwork.label }} — anyone who can read this page's memory can read it too.
			Never paste a key that holds anything you'd miss.
		</p>

		<q-input
			v-model="privateKeyInput"
			label="Private key"
			type="password"
			dense
			outlined
			autocomplete="off"
			spellcheck="false"
			:disable="connecting"
			:error="!!error"
			:error-message="error"
			@keyup.enter="connect"
		/>

		<p v-if="derivedAddress" class="derived">
			Signs as <span class="address">{{ derivedAddress }}</span>
		</p>

		<p v-if="!isTestnet" class="warning warning--blocking">
			Local signing only works on Testnet. Switch networks before connecting.
		</p>

		<GradientButton
			label="Connect with this key"
			loading-label="Connecting..."
			:loading="connecting"
			:disable="!canConnect"
			@click="connect"
		/>
	</div>
</template>

<script>
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import GradientButton from '../components/GradientButton.vue';
import { connectLocalSigner } from './connectLocalSigner.js';
import { getActiveNetwork } from '../settings.js';

/**
 * The local-signer half of the wallet picker: paste a private key, sign with it directly,
 * no extension popups. The actual connect (and its testnet-only gate) lives in
 * `connectLocalSigner.js`, shared with the `window.mnemonadConnectWithKey` console helper
 * (see `main.js`) so this UI and that shortcut can never enforce the gate differently. This
 * component owns only the key itself and never lets it leave this file.
 *
 * A separate component (rather than inlined into `WalletConnect.vue`) so the input, its
 * validation, and — most importantly — its lifetime are all in one place a reviewer can
 * check in isolation: nothing here writes the key to Pinia, localStorage, or a URL, and nothing
 * outside this file ever holds a reference to the raw string.
 */
export default {
	name: 'LocalSignerCard',
	components: { GradientButton },
	emits: ['connected'],
	data() {
		return {
			privateKeyInput: '',
			connecting: false,
			error: null,
			activeNetwork: getActiveNetwork(),
		};
	},
	computed: {
		isTestnet: function() {
			return this.activeNetwork.chain.id === monadTestnet.id;
		},
		// Derived live so a typo is visible before the transaction that reveals it. Errors
		// silently render nothing rather than fighting the "Private key" field's own
		// error state over an in-progress, not-yet-complete paste.
		derivedAddress: function() {
			if (!this.privateKeyInput.trim()) return null;
			try {
				return privateKeyToAccount(this.normalizedKey).address;
			} catch (e) {
				return null;
			}
		},
		normalizedKey: function() {
			const key = this.privateKeyInput.trim();
			return key.startsWith('0x') ? key : `0x${key}`;
		},
		canConnect: function() {
			return this.isTestnet && !!this.derivedAddress && !this.connecting;
		},
	},
	methods: {
		async connect() {
			if (!this.canConnect) return;
			this.connecting = true;
			this.error = null;
			try {
				await connectLocalSigner(this.normalizedKey);
				// The one thing this component promises: once connected, the key itself is
				// dropped. The connector already closed over the derived *account* (keys and
				// signing capability, not the string) — clearing the input and this
				// component's own copy is what actually removes the last string reference.
				this.privateKeyInput = '';
				this.$emit('connected');
			} catch (e) {
				this.error = e?.shortMessage || e?.message || 'Failed to connect with this key.';
			} finally {
				this.connecting = false;
			}
		},
	},
	// Belt-and-suspenders alongside the click-driven clear above: however this component
	// stops existing — navigation, the dialog closing, a parent re-render — the input
	// string goes with it rather than lingering in a detached component instance.
	beforeUnmount() {
		this.privateKeyInput = '';
	},
};
</script>

<style scoped>
.local-signer-card {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.warning {
	font-size: 12px;
	line-height: 1.5;
	opacity: 0.85;
	margin: 0;
}

.warning--blocking {
	color: var(--q-negative, #e57373);
	opacity: 1;
}

.derived {
	font-size: 12px;
	opacity: 0.8;
	margin: 0;
	word-break: break-all;
}

.address {
	font-family: monospace;
	opacity: 1;
}
</style>
