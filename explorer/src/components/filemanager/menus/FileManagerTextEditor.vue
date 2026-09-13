<template>
    <FileManagerModal
        :isOpen="true"
        :title="item.name"
        @close="onClose"
    >
        <textarea
            class="textEditorArea"
            v-model="text"
            :readonly="readOnly"
            ref="textarea"
        ></textarea>
        <template #actions>
            <button class="modalButton modalButtonCancel" @click="onClose">Cancel</button>
            <button class="modalButton modalButtonOk" @click="onSave" v-if="!readOnly">Save</button>
        </template>
    </FileManagerModal>
</template>

<script>
import FileManagerModal from './FileManagerModal.vue';
import { toRaw } from 'vue';

export default {
    name: 'FileManagerTextEditor',
    components: {
        FileManagerModal,
    },
    props: {
        item: {
            type: Object,
            required: true,
        },
        readOnly: {
            type: Boolean,
            default: false,
        },
    },
    emits: ['saved', 'close'],
    data() {
        return {
            text: '',
        };
    },
    mounted() {
        this.text = toRaw(this.item).getTextContent();
        this.$nextTick(() => {
            if (this.$refs.textarea) {
                this.$refs.textarea.focus();
            }
        });
    },
    methods: {
        onSave() {
            toRaw(this.item).setTextContent(this.text);
            this.$emit('saved');
        },
        onClose() {
            this.$emit('close');
        },
    },
}
</script>

<style scoped>
.textEditorArea {
    width: 100%;
    min-width: 500px;
    height: 400px;
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    padding: 10px;
    border: 1px solid var(--q-surface-border, #33246b);
    border-radius: 4px;
    resize: vertical;
    outline: none;
    box-sizing: border-box;
    line-height: 1.5;
    background-color: var(--q-surface-1, #150c33);
    color: var(--q-text-bright, #fbfaf9);
}

.textEditorArea:focus {
    border-color: var(--q-primary, #836ef9);
}

@media screen and (max-width: 600px) {
    .textEditorArea {
        min-width: unset;
        width: 100%;
    }
}
</style>
