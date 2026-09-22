<template>
	<q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" position="standard">
		<JPanel accent="header" icon="terminal" iconColor="var(--q-primary)" title="Clone this stream" style="min-width: 420px;">
			<div class="dialog-content q-pa-md">
				<p class="hint">
					Pull every version of this stream onto disk with
					<a
						class="npm-link"
						href="https://www.npmjs.com/package/mnemonad-cli"
						target="_blank"
						rel="noopener noreferrer"
						draggable="false"
					>mnemonad-cli<q-icon name="open_in_new" size="12px" class="npm-link__icon" /></a>
					— its README there covers every command, this is just the one you need right now.
				</p>

				<div class="clone-step">
					<span class="clone-step__label">1. Install it globally</span>
					<CopyableCommand :command="installCommand" />
				</div>

				<div class="clone-step">
					<span class="clone-step__label">2. Pull this stream</span>
					<CopyableCommand :command="pullCommand" />
				</div>

				<p v-if="encrypted" class="hint hint--warning">
					This stream is encrypted{{ kekMethod === 'password' ? ' with a password' : " to its owner's wallet" }} —
					<template v-if="kekMethod === 'password'">add <code>--password &lt;password&gt;</code> to the command above,</template>
					<template v-else>run the pull using the account that created it,</template>
					or it comes down still encrypted.
				</p>
				<p v-else class="hint">
					Re-running the same command later only downloads what changed since your last pull.
				</p>
			</div>

			<template #header-action>
				<q-btn flat round icon="close" size="sm" v-close-popup />
			</template>
		</JPanel>
	</q-dialog>
</template>

<script>
/**
 * "Clone" on the file browser header — mnemonad-cli's own `pull` is the one thing this dApp
 * can't do for you (a real local folder to keep syncing against, not a browser tab), so this
 * just hands over the exact command for *this* stream rather than a generic "read the docs".
 *
 * `streamId`/`networkId` are enough to build the command; `encrypted`/`kekMethod` are
 * optional polish (the CLI would fail with its own clear error either way if omitted) —
 * see FileBrowser.vue for where all four come from.
 */
import { JPanel } from 'themed_varmory';
import CopyableCommand from '../components/CopyableCommand.vue';
import { fullStreamIdHex } from '../includes/formatStreamId.js';

export default {
	name: 'CloneStreamDialog',
	components: {
		JPanel,
		CopyableCommand,
	},
	props: {
		modelValue: {
			type: Boolean,
			default: false,
		},
		streamId: {
			type: [String, BigInt],
			required: true,
		},
		/** 'testnet' | 'mainnet' — matches the CLI's own `--chain` values exactly. */
		networkId: {
			type: String,
			required: true,
		},
		encrypted: {
			type: Boolean,
			default: false,
		},
		/** 'password' | 'signature' | null — only meaningful when `encrypted`. */
		kekMethod: {
			type: String,
			default: null,
		},
	},
	emits: ['update:modelValue'],
	computed: {
		installCommand() {
			return 'npm install -g mnemonad-cli';
		},
		pullCommand() {
			// Hex, not decimal: matches what the CLI itself prints for every id (see
			// cli/lib/commands/shared.js's own formatStreamId), so a command copied from
			// here reads the same as one copied from a `pull`/`push` the CLI just ran.
			return `mnemonad pull ${fullStreamIdHex(this.streamId)} ./${this.folderName} --chain ${this.networkId}`;
		},
		// A folder name that's both a valid path segment and recognizably *this* stream,
		// without the full "0x00…00ab" the command above uses — that's precise, but 64
		// hex digits is not a name you'd want mkdir (or a file explorer) to see verbatim.
		folderName() {
			const hex = BigInt(this.streamId).toString(16).padStart(64, '0');
			return `stream-${hex.slice(0, 8)}`;
		},
	},
};
</script>

<style scoped>
.dialog-content {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin: 16px 0;
}

.clone-step {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.clone-step__label {
	font-size: 12px;
	font-weight: 600;
	color: var(--q-text-muted, #8a94a6);
}

.hint {
	margin: 0;
	font-size: 12px;
	opacity: 0.75;
	line-height: 1.5;
}

.hint code {
	font-family: var(--font-mono, monospace);
	font-size: 0.95em;
}

.hint--warning {
	color: var(--q-negative, #e57373);
	opacity: 1;
}

.npm-link {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	color: var(--q-primary);
	text-decoration: none;
}

.npm-link:hover {
	text-decoration: underline;
}

.npm-link__icon {
	opacity: 0.8;
}
</style>
