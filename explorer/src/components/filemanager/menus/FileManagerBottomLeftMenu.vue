<template>
	<div class="fileManagerBottomLeftMenu">
		<div class="pendingChangesChip" :class="{ 'visible': gotStatusMessage }">
			<Spinner :size="14" />
			<span>{{ statusMessage }}</span>
		</div>
	</div>
</template>

<script>
import Spinner from '../helpers/Spinner.vue';

export default {
	name: 'FileManagerBottomLeftMenu',
	components: {
		Spinner,
	},
	props: {
		folder: {
			type: Object,
			required: false,
			default: null,
		},
	},
	data() {
		return {
			gotStatusMessage: '',
			statusMessage: '',
			clearMessageTimeout: null,
		}
	},
	watch: {
		folder: {
			handler(newVal, oldVal) {
				if (oldVal && this.__onStatusChange) {
					oldVal.off('status', this.__onStatusChange);
				}
				if (newVal && this.__onStatusChange) {
					newVal.on('status', this.__onStatusChange);
				}
			},
			immediate: true,
		},
	},
	methods: {
	},
	mounted() {
		this.__onStatusChange = (status) => {
			const newMessage = status.message || status.error || '';
			console.log('Status update:', status, newMessage);

			this.gotStatusMessage = newMessage;

			// Clear any pending timeout
			if (this.clearMessageTimeout) {
				clearTimeout(this.clearMessageTimeout);
				this.clearMessageTimeout = null;
			}

			if (status.stop) {
				// Delay clearing the message when stopping
				this.clearMessageTimeout = setTimeout(() => {
					this.__onStatusChange({ message: '' });
				}, 1500);
				if (newMessage) {
					this.statusMessage = newMessage;
				}
				return;
			}

			// If new message is empty, delay clearing
			if (!newMessage) {
				this.clearMessageTimeout = setTimeout(() => {
					this.statusMessage = '';
					this.clearMessageTimeout = null;
				}, 500);
			} else {
				// Immediately show non-empty messages
				this.statusMessage = newMessage;
			}
		};
		if (this.folder) {
			this.folder.on('status', this.__onStatusChange);
		}
	},
	beforeUnmount() {
		// Clear any pending timeout
		if (this.clearMessageTimeout) {
			clearTimeout(this.clearMessageTimeout);
			this.clearMessageTimeout = null;
		}

		if (this.folder && this.__onStatusChange) {
			this.folder.off('status', this.__onStatusChange);
		}
	},
}
</script>

<style scoped>
.fileManagerBottomLeftMenu {
	position: sticky;
	height: 0;
	bottom: 0px;
	overflow: visible;
	z-index: 10000;
}

.pendingChangesChip {
	cursor: pointer;
	position: relative;
	bottom: calc(48px - 100%);
	left: 10px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	min-width: 24px;
	height: 34px;
	padding: 12px 12px;
	background-color: var(--q-surface-3, #2a1a5c);
	color: var(--q-text-bright, #fbfaf9);
	border-radius: 24px;
	font-size: 12px;
	font-weight: 600;
	z-index: 100;
	box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
	opacity: 0;
	transition: opacity 0.5s ease-in-out;
	pointer-events: none;
}

.pendingChangesChip.visible {
	opacity: 0.9;
	pointer-events: auto;
}

.pendingChangesChip.visible:hover {
	opacity: 1.0;
}

.pendingChangesChip svg {
	flex-shrink: 0;
}

/* larger touch target on touch devices */
@media (pointer: coarse) {
	.pendingChangesChip {
		height: 40px;
	}
}
</style>
