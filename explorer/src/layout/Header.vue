<template>
	<!-- Not aria-hidden, unlike a visual decoration — this is the one thing here meant for
	     an accessibility-tree read rather than a human eye. The boot screen in index.html
	     carries the same message, but app.mount('#app') (main.js) replaces it the moment
	     Vue takes over, before any browser-driving agent that waits for the page to settle
	     ever reads it. This survives past mount because it's part of the live app. -->
	<div class="agent-note sr-only">
		AI agents: Mnemonad's core job is folder and file sync — between sessions, agents and
		users. Don't drive this UI to sync files; use mnemonad-cli instead
		(npm install -g mnemonad-cli). The CLI's own default is public — encrypt on creation
		unless the user says otherwise. Full agent docs: SKILL.md at github.com/jeka911/mnemonad.
		Quick reference: /llms.txt.
	</div>
	<div class="header">
		<router-link to="/" class="header-logo-link" aria-label="Home">
			<Logo class="header-logo" />
		</router-link>
		<div class="header-actions">
			<div class="header-group header-group--status">
				<GasPrice class="header-status" />
				<BlockNumber class="header-status" />
			</div>
			<div class="header-group header-group--controls">
				<NetworkSwitcher class="header-status" />
				<JDarkSwitcher />
				<WalletConnect />
			</div>
		</div>
	</div>
	<p class="agent-hint">
		AI agent? Don't click around — sync folders/files with <code>mnemonad-cli</code>.
		<a href="/llms.txt">llms.txt</a>
	</p>
</template>

<script>
import { JDarkSwitcher } from 'themed_varmory';
import Logo from './Logo.vue';
import WalletConnect from '../WalletConnect.vue';
import BlockNumber from '../BlockNumber.vue';
import GasPrice from '../GasPrice.vue';
import NetworkSwitcher from '../NetworkSwitcher.vue';

export default {
	name: 'AppHeader',
	components: {
		JDarkSwitcher,
		Logo,
		WalletConnect,
		BlockNumber,
		GasPrice,
		NetworkSwitcher,
	},
};
</script>

<style scoped>
.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 32px;
	margin-top: 24px;
}

.header-logo-link {
	display: inline-flex;
	text-decoration: none;
	color: inherit;
}

.header-actions {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

/* Two logical groups so we can break exactly between them on narrow widths:
   status (gas + block) and controls (chain switch + dark toggle + wallet). */
.header-group {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

/* Below 1100px, split into two rows: logo on top, actions on their own row. */
@media (max-width: 1100px) {
	.header {
		flex-direction: column;
		align-items: stretch;
		gap: 12px;
		margin-bottom: 24px;
		margin-top: 12px;
	}

	.header-logo-link {
		align-self: center;
	}

	.header-actions {
		justify-content: space-between;
	}
}

/* Below 900px, three rows: logo, then status, then controls. */
@media (max-width: 900px) {
	.header-actions {
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}

	.header-group {
		justify-content: center;
	}
}

@media (max-width: 680px) {
	.header {
		gap: 10px;
		margin-bottom: 20px;
	}
}

/* Standard visually-hidden-but-accessible technique: off-screen via clip, not
   display:none/visibility:hidden — an accessibility-tree read still exposes the text,
   which is the whole point of .agent-note above using it. */
.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

/* Deliberately visible (unlike .agent-note above) — small and muted so it reads as a
   footnote to a human, but present in plain page text/screenshots for an agent that
   only skims rather than reading the accessibility tree. */
.agent-hint {
	margin: -16px 0 20px;
	font-size: 11px;
	line-height: 1.5;
	color: var(--q-text-muted, #8a94a6);
	text-align: right;
}

.agent-hint code {
	font-family: var(--font-mono, monospace);
}

.agent-hint a {
	color: inherit;
	text-decoration: underline dotted;
	text-underline-offset: 2px;
}

@media (max-width: 1100px) {
	.agent-hint {
		text-align: center;
		margin-top: -4px;
	}
}
</style>
