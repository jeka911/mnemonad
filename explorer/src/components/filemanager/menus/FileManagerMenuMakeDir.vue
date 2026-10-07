<template>
	<FileManagerModal
		:isOpen="isOpen"
		title="Create Directory"
		@close="onCancel"
	>
		<input
			type="text"
			class="modalInput"
			v-model="dirName"
			placeholder="Directory name"
			@keyup.enter="onCreate"
			@keyup.escape="onCancel"
			ref="dirNameInput"
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
	name: 'FileManagerMenuMakeDir',
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
			dirName: '',
		}
	},
	watch: {
		isOpen(newVal) {
			if (newVal) {
				this.dirName = '';
				this.$nextTick(() => {
					if (this.$refs.dirNameInput) {
						this.$refs.dirNameInput.focus();
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
			if (!this.dirName.trim()) {
				return;
			}
			this.$emit('create', this.dirName.trim());
		},
	},
}
</script>
