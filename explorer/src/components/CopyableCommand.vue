<template>
	<div class="copyable-command">
		<code class="copyable-command__text">{{ command }}</code>
		<q-btn
			flat
			round
			dense
			:icon="justCopied ? 'check' : 'content_copy'"
			size="sm"
			class="copyable-command__btn"
			:aria-label="`Copy: ${command}`"
			@click="copy"
		/>
	</div>
</template>

<script>
/**
 * A one-line shell command with a copy button — every "run this" moment in the app (so far
 * just CloneStreamDialog) wants the same shape: monospace, scrolls instead of wrapping, one
 * click to the clipboard. Pulled out on its first second use rather than its first, since a
 * single caller doesn't prove the shape is actually shared yet.
 */
export default {
	name: 'CopyableCommand',
	props: {
		command: {
			type: String,
			required: true,
		},
	},
	data() {
		return {
			justCopied: false,
			_copiedTimer: null,
		};
	},
	beforeUnmount() {
		clearTimeout(this._copiedTimer);
	},
	methods: {
		async copy() {
			try {
				await navigator.clipboard.writeText(this.command);
			} catch {
				// Clipboard API needs a secure context/permission that isn't guaranteed
				// (older browsers, some embedded webviews) — the command is still selectable
				// text either way, so this degrades to "copy it by hand" rather than an error.
				this.$q.notify({
					type: 'negative',
					message: "Couldn't copy automatically — select the command and copy it manually.",
					position: 'top',
				});
				return;
			}
			this.justCopied = true;
			clearTimeout(this._copiedTimer);
			this._copiedTimer = setTimeout(() => { this.justCopied = false; }, 1500);
		},
	},
};
</script>

<style scoped>
.copyable-command {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 8px 6px 8px 12px;
	border-radius: 8px;
	background: rgba(140, 120, 200, 0.06);
	border: 1px solid rgba(140, 120, 200, 0.12);
}

.copyable-command__text {
	flex: 1 1 auto;
	min-width: 0;
	overflow-x: auto;
	white-space: pre;
	font-family: var(--font-mono, monospace);
	font-size: 12.5px;
	color: var(--q-text-bright, #ffffff);
	/* A command is one line by definition here — scrolling beats wrapping mid-flag. */
	scrollbar-width: thin;
}

.copyable-command__btn {
	flex: 0 0 auto;
}

body.body--light .copyable-command {
	background: rgba(60, 40, 110, 0.04);
	border-color: rgba(60, 40, 110, 0.1);
}

body.body--light .copyable-command__text {
	color: #2a2440;
}
</style>
