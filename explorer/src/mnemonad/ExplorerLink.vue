<template>
	<a
		v-if="href"
		class="explorer-link"
		:href="href"
		target="_blank"
		rel="noopener noreferrer"
	>
		<slot>{{ label }}</slot>
		<q-icon name="open_in_new" size="14px" class="explorer-link__icon" />
	</a>
</template>

<script>
import { addressUrl, tokenUrl } from '../includes/explorerUrl.js';

export default {
	name: 'ExplorerLink',
	props: {
		// 'address', or 'token' (an ERC-721 token id — pass the contract via `contractAddress`).
		type: {
			type: String,
			default: 'address',
		},
		value: {
			type: [String, Number, BigInt],
			required: true,
		},
		// Required when type is 'token'; ignored for 'address'.
		contractAddress: {
			type: String,
			default: null,
		},
		chain: {
			type: Object,
			required: true,
		},
		label: {
			type: String,
			default: 'View on explorer',
		},
	},
	computed: {
		href: function() {
			if (this.type === 'token') return tokenUrl(this.chain, this.contractAddress, this.value);
			if (this.type === 'address') return addressUrl(this.chain, this.value);
			return null;
		},
	},
};
</script>

<style scoped>
.explorer-link {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--q-text-muted, #8a94a6);
	text-decoration: none;
	font-size: 0.85em;
	transition: color var(--q-transition-fast, 0.15s);
}

.explorer-link:hover {
	color: var(--q-text-bright, #ffffff);
}

.explorer-link__icon {
	opacity: 0.8;
}

body.body--light .explorer-link {
	color: #5a5a6e;
}

body.body--light .explorer-link:hover {
	color: #2a2440;
}
</style>
