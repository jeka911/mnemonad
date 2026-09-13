<template>
    <div class="fileManagerTopRightMenu">
        <button class="menuButton" @click="toggleMenu">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="1"></circle>
                <circle cx="12" cy="5" r="1"></circle>
                <circle cx="12" cy="19" r="1"></circle>
            </svg>
        </button>
        <div class="menuPopup" :class="{ 'visible': isMenuOpen }" @click.stop>
            <div class="menuItem" @click="onSort" :class="{menuItemDisabled: readOnly}">
                <SortIcon />
                <span>Sort</span>
            </div>
            <div class="menuItem" @click="onMakeDir">
                <FolderPlusIcon />
                <span>Make Dir</span>
            </div>
            <div class="menuItem" @click="onNewFile">
                <TextFileIcon />
                <span>New File</span>
            </div>
            <div class="menuItem" @click="onFillSamples" :class="{menuItemDisabled: isFillingSamples}">
                <DatabaseIcon />
                <span>{{ isFillingSamples ? 'Filling...' : 'Fill Samples' }}</span>
            </div>
            <!-- <div class="menuItem" @click="onRefresh">
                <RefreshIcon />
                <span>Refresh</span>
            </div> -->
            <div class="menuItem" :class="{ menuItemActive: isPolling }" @click="onTogglePolling">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
                <span>{{ isPolling ? 'Stop Live' : 'Live' }}</span>
            </div>
            <div class="menuItem menuItem--streamInfo" @click="onVectorInfo">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <span>Stream Info</span>
            </div>
            <div class="menuItem" @click="onClose">
                <CloseIcon />
                <span>Close</span>
            </div>
        </div>

        <FileManagerMenuMakeDir
            :isOpen="isModalOpen"
            @cancel="closeModal"
            @create="createDir"
        />

        <FileManagerMenuNewFile
            :isOpen="isNewFileModalOpen"
            @cancel="closeNewFileModal"
            @create="createFile"
        />

    </div>
</template>

<script>
import FileManagerMenuMakeDir from './FileManagerMenuMakeDir.vue';
import FileManagerMenuNewFile from './FileManagerMenuNewFile.vue';
import FileManagerSampleFiller from '../includes/FileManagerSampleFiller.js';
import FolderPlusIcon from '../helpers/FolderPlusIcon.vue';
import TextFileIcon from '../helpers/TextFileIcon.vue';
import DatabaseIcon from '../helpers/DatabaseIcon.vue';
import RefreshIcon from '../helpers/RefreshIcon.vue';
import SortIcon from '../helpers/SortIcon.vue';
import CloseIcon from '../helpers/CloseIcon.vue';

export default {
    name: 'FileManagerTopRightMenu',
    components: {
        FileManagerMenuMakeDir,
        FileManagerMenuNewFile,
        FolderPlusIcon,
        TextFileIcon,
        DatabaseIcon,
        RefreshIcon,
        SortIcon,
        CloseIcon,
    },
    props: {
        folder: {
            type: Object,
            required: false,
            default: null,
        },
        readOnly: {
            type: Boolean,
            required: false,
            default: false,
        },
        isPolling: {
            type: Boolean,
            required: false,
            default: false,
        },
    },
    emits: ['close', 'togglePolling', 'streamInfo'],
    data() {
        return {
            isMenuOpen: false,
            isModalOpen: false,
            isNewFileModalOpen: false,
            isFillingSamples: false,
        }
    },
    methods: {
        toggleMenu() {
            this.isMenuOpen = !this.isMenuOpen;
        },
        closeMenu() {
            this.isMenuOpen = false;
        },
        onVectorInfo() {
            this.closeMenu();
            this.$emit('streamInfo');
        },
        onMakeDir() {
            this.closeMenu();
            this.isModalOpen = true;
        },
        onNewFile() {
            this.closeMenu();
            this.isNewFileModalOpen = true;
        },
        closeModal() {
            this.isModalOpen = false;
        },
        closeNewFileModal() {
            this.isNewFileModalOpen = false;
        },
        createDir(dirName) {
            // TODO: Implement directory creation logic
            console.log('Creating directory:', dirName);
            this.folder.mkdir(dirName);
            this.closeModal();
        },
        createFile(fileName) {
            this.folder.pushTextFile(fileName);
            this.closeNewFileModal();
        },
        async onFillSamples() {
            if (this.isFillingSamples || !this.folder) return;
            this.closeMenu();
            this.isFillingSamples = true;
            try {
                const filler = new FileManagerSampleFiller();
                await filler.fill(this.folder);
            } catch (err) {
                console.error('Fill samples error:', err);
            } finally {
                this.isFillingSamples = false;
            }
        },
        onRefresh() {
            if (this.folder) {
                this.folder.load();
            }
            this.closeMenu();
        },
        onSort() {
            this.closeMenu();
        },
        onTogglePolling() {
            this.$emit('togglePolling');
            this.closeMenu();
        },
        onClose() {
            this.$emit('close');
            this.closeMenu();
        },
    },
    mounted() {
        // Close menu when clicking outside
        this.__onDocumentClick = (e) => {
            if (this.isMenuOpen && !this.$el.contains(e.target)) {
                this.closeMenu();
            }
        };
        document.addEventListener('click', this.__onDocumentClick);
    },
    beforeUnmount() {
        if (this.__onDocumentClick) {
            document.removeEventListener('click', this.__onDocumentClick);
        }
    },
}
</script>

<style scoped>
.fileManagerTopRightMenu {
    position: sticky;
    height: 0;
    top: 0px;
    overflow: visible;
    z-index: 9150;
}

.menuButton {
    cursor: pointer;
    position: absolute;
    top: calc(8px - 100%);
    right: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    background-color: var(--q-primary, #836ef9);
    color: white;
    border: none;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 600;
    z-index: 100;
    box-shadow: 0 2px 4px var(--q-shadow-drop, rgba(32, 0, 82, .08));
    transition: opacity 0.2s ease;
}

.menuButton:hover {
    opacity: 0.9;
}

/* "Stream Info" opens the status dialog — only needed on mobile, where the
   status column is hidden. Scoped under .menuPopup to out-rank the base
   .menuItem rule that appears later in this file. */
.menuPopup .menuItem--streamInfo {
    display: none;
}

@media screen and (max-width: 1000px) {
    .menuPopup .menuItem--streamInfo {
        display: flex;
    }
}

/* larger touch targets on touch devices */
@media (pointer: coarse) {
    .menuButton {
        width: 40px;
        height: 40px;
    }
    .menuItem {
        padding: 13px 16px;
    }
}

.menuPopup {
    position: absolute;
    top: 40px;
    right: 40px;
    background-color: var(--q-surface-2, #1e1147);
    border: 1px solid var(--q-surface-border, #33246b);
    border-radius: 6px;
    box-shadow: 0 4px 12px var(--q-shadow-drop, rgba(32, 0, 82, .08));
    min-width: 160px;
    opacity: 0;
    visibility: hidden;
    transform: translateY(-10px);
    transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;
    z-index: 101;
}

.menuPopup.visible {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
}

.menuItem {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    cursor: pointer;
    color: var(--q-text, #d8d3ea);
    font-size: 14px;
    transition: background-color 0.15s ease;
}

.menuItem:first-child {
    border-radius: 6px 6px 0 0;
}

.menuItem:last-child {
    border-radius: 0 0 6px 6px;
}

.menuItem:hover {
    background-color: var(--q-surface-3, #2a1a5c);
}

.menuItemDisabled {
    color: var(--q-text-faint, rgba(251, 250, 249, .16));
    cursor: not-allowed;
}

.menuItemActive {
    color: var(--q-primary, #836ef9);
    font-weight: 600;
}

.menuItem svg {
    flex-shrink: 0;
}

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
    background-color: white;
    border-radius: 8px;
    padding: 24px;
    min-width: min(320px, calc(100vw - 32px));
    max-width: 90%;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    transform: scale(0.9);
    transition: transform 0.2s ease;
}

.modalOverlay.visible .modalDialog {
    transform: scale(1);
}

.modalTitle {
    margin: 0 0 16px 0;
    font-size: 18px;
    font-weight: 600;
    color: #333;
}

.modalInput {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
    box-sizing: border-box;
    margin-bottom: 16px;
    outline: none;
    transition: border-color 0.2s ease;
}

.modalInput:focus {
    border-color: #1976d2;
}

.modalActions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.modalButton {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s ease;
}

.modalButton:hover {
    opacity: 0.9;
}

.modalButtonCancel {
    background-color: #f5f5f5;
    color: #333;
}

.modalButtonOk {
    background-color: #1976d2;
    color: white;
}
</style>
