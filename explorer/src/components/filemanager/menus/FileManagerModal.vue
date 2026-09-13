<template>
    <div class="modalOverlay fileManagerModal" :class="{ 'visible': isOpen }" @click="onClose">
        <div class="modalDialog" @click.stop>
            <h3 class="modalTitle" v-if="title">{{ title }}</h3>
            <div class="modalContent">
                <slot></slot>
            </div>
            <div class="modalActions" v-if="$slots.actions">
                <slot name="actions"></slot>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'FileManagerModal',
    props: {
        isOpen: {
            type: Boolean,
            required: true,
        },
        title: {
            type: String,
            default: '',
        },
    },
    emits: ['close'],
    methods: {
        onClose() {
            this.$emit('close');
        },
    },
}
</script>

<style scoped>
.modalOverlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease, visibility 0.2s;
}

.modalOverlay.visible {
    opacity: 1;
    visibility: visible;
}

.modalDialog {
    background-color: var(--q-surface-2, #1e1147);
    border: 1px solid var(--q-surface-border, #33246b);
    border-radius: 8px;
    padding: 12px 16px;
    min-width: min(320px, calc(100vw - 32px));
    max-width: 90%;
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 24px var(--q-shadow-drop, rgba(32, 0, 82, .08));
    transform: scale(0.9);
    transition: transform 0.2s ease;
}

.modalOverlay.visible .modalDialog {
    transform: scale(1);
}

.modalTitle {
    margin: 0 0 10px 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--q-text-bright, #fbfaf9);
}

.modalContent {
    flex: 1;
    overflow-y: auto;
}

.modalActions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
}
</style>

<style>
/* Global styles for modal buttons - not scoped so child components can use them */
.fileManagerModal .modalButton {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s ease;
}

.fileManagerModal .modalButton:hover {
    opacity: 0.9;
}

.fileManagerModal .modalButton:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.fileManagerModal .modalButtonCancel {
    background-color: var(--q-surface-3, #2a1a5c);
    color: var(--q-text, #d8d3ea);
}

.fileManagerModal .modalButtonOk {
    background-color: var(--q-primary, #836ef9);
    color: white;
}

.fileManagerModal .modalInput {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--q-surface-border, #33246b);
    border-radius: 4px;
    font-size: 14px;
    box-sizing: border-box;
    outline: none;
    background-color: var(--q-surface-1, #150c33);
    color: var(--q-text-bright, #fbfaf9);
    transition: border-color 0.2s ease;
}

.fileManagerModal .modalInput:focus {
    border-color: var(--q-primary, #836ef9);
}
</style>
