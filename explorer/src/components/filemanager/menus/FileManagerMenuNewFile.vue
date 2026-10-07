<template>
	<FileManagerModal
		:isOpen="isOpen"
		title="Create File"
		@close="onCancel"
	>
		<input
			type="text"
			class="modalInput"
			v-model="fileName"
			placeholder="filename.txt"
			@keyup.enter="onCreate"
			@keyup.escape="onCancel"
			ref="fileNameInput"
		/>
		<template #actions>
			<button class="modalButton modalButtonCancel" @click="onCancel">Cancel</button>
			<button class="modalButton modalButtonOk" @click="onCreate">Create</button>
		</template>
	</FileManagerModal>
</template>

<script>
import FileManagerModal from './FileManagerModal.vue';

export default {
	name: 'FileManagerMenuNewFile',
	components: {
		FileManagerModal,
	},
	props: {
		isOpen: {
			type: Boolean,
			required: true,
		},
	},
	emits: ['cancel', 'create'],
	data() {
		return {
			fileName: '',
		}
	},
	watch: {
		isOpen(newVal) {
			if (newVal) {
				this.fileName = '';
				this.$nextTick(() => {
					if (this.$refs.fileNameInput) {
						this.$refs.fileNameInput.focus();
					}
				});
			}
		},
	},
	methods: {
		onCancel() {
			this.$emit('cancel');
		},
		onCreate() {
			if (!this.fileName.trim()) {
				return;
			}
			this.$emit('create', this.fileName.trim());
		},
	},
}
</script>
