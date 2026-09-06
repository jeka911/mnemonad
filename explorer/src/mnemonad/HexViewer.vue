<template>
	<div class="hex-viewer">
		<p v-if="!bytes || !bytes.length" class="hex-viewer__empty">(empty)</p>
		<template v-else>
			<p class="hex-viewer__caption">{{ formatBytes(bytes.length) }} — binary data, showing hex dump</p>
			<pre class="hex-viewer__dump">{{ dump }}</pre>
		</template>
	</div>
</template>

<script>
import { formatBytes } from '../includes/formatBytes.js';

/** Classic hexdump -C layout: 16 bytes per row, split into two groups of 8. */
const BYTES_PER_ROW = 16;
const GROUP_SIZE = BYTES_PER_ROW / 2;

export default {
	name: 'HexViewer',
	props: {
		bytes: {
			type: Uint8Array,
			default: null,
		},
	},
	computed: {
		dump: function() {
			if (!this.bytes || !this.bytes.length) return '';
			const rows = [];
			for (let offset = 0; offset < this.bytes.length; offset += BYTES_PER_ROW) {
				rows.push(formatRow(this.bytes, offset));
			}
			return rows.join('\n');
		},
	},
	methods: {
		formatBytes,
	},
};

/**
 * One `offset  hex hex hex hex  hex hex hex hex  |ascii...........|` line, padded to a
 * fixed width even on the final short row so every row's columns stay aligned.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {string}
 */
function formatRow(bytes, offset) {
	const hexGroups = [[], []];
	const ascii = [];

	for (let i = 0; i < BYTES_PER_ROW; i++) {
		const pos = offset + i;
		const group = hexGroups[i < GROUP_SIZE ? 0 : 1];
		if (pos < bytes.length) {
			const b = bytes[pos];
			group.push(b.toString(16).padStart(2, '0'));
			ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
		} else {
			group.push('  '); // keeps short trailing rows column-aligned with full ones
		}
	}

	const offsetHex = offset.toString(16).padStart(8, '0');
	const hex = `${hexGroups[0].join(' ')}  ${hexGroups[1].join(' ')}`;
	return `${offsetHex}  ${hex}  |${ascii.join('')}|`;
}
</script>

<style scoped>
.hex-viewer__empty {
	color: var(--q-text-muted, #8a94a6);
	margin: 0;
}

.hex-viewer__caption {
	margin: 0 0 8px;
	font-size: 0.8em;
	color: var(--q-text-muted, #8a94a6);
	font-family: var(--font-mono, monospace);
}

.hex-viewer__dump {
	margin: 0;
	padding: 10px 12px;
	border-radius: 8px;
	background: rgba(140, 120, 200, 0.05);
	border: 1px solid rgba(140, 120, 200, 0.12);
	color: var(--q-text-bright, #ffffff);
	font-family: var(--font-mono, monospace);
	font-size: 0.85em;
	line-height: 1.5;
	white-space: pre;
	overflow-x: auto;
	max-height: 60vh;
	overflow-y: auto;
}

body.body--light .hex-viewer__dump {
	background: rgba(60, 40, 110, 0.035);
	border-color: rgba(60, 40, 110, 0.1);
	color: #2a2440;
}
</style>
