<template>
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
</style>
