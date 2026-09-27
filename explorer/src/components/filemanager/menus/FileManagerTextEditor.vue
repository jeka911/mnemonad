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
        // {start, end} — offsets into the decoded text to highlight and scroll to on open
        // (a stream-search hit). Null opens at the top, as before.
        selection: {
            type: Object,
            default: null,
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
                if (this.selection) this.showSelection(this.selection);
            }
        });
    },
    methods: {
        showSelection({ start, end }) {
            const el = this.$refs.textarea;
            // A textarea's value normalizes CRLF to LF, so its selection indices run one short
            // per CRLF compared to offsets into the raw decoded string (which is what the index
            // stores). Lone CRs become LFs too, but those don't change length.
            const toValueIndex = (offset) => offset - (this.text.slice(0, offset).match(/\r\n/g)?.length || 0);
            const from = toValueIndex(Math.min(start, this.text.length));
            const to = toValueIndex(Math.min(end, this.text.length));
            // Wrapped lines make "line number × line height" wrong, so measure instead: with only
            // the text before the passage in the box, scrolling it fully down puts the passage's
            // first line at the bottom edge — zero when it already starts on the first screen.
            // Restored straight after — the same string v-model already holds.
            const full = el.value;
            el.value = full.slice(0, from);
            el.scrollTop = el.scrollHeight;
            const startAtBottom = el.scrollTop;
            el.value = full;
            // 'backward' puts the caret at the passage's start: browsers scroll the caret into
            // view, and at the (default) end it drags a long passage's last line on screen.
            el.setSelectionRange(from, to, 'backward');
            const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
            el.scrollTop = startAtBottom === 0 ? 0 : startAtBottom + el.clientHeight * 2 / 3 - lineHeight;
        },
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
