<template>

    <div class="rowItemContainer" :class="{ isToBeUploaded: isToBeUploaded }" :data-item-name="item.name" :data-item-type="item.isBackButton ? 'back' : item.isFolder ? 'folder' : 'file'" @click="onClick">
        <div class="rowItemFolder"
            v-if="item.isBackButton">
            <FolderIcon class="rowItemIcon" :color="primaryColor" />
            <div class="rowItemFolderTitle" :style="{ color: primaryColor }">
                ...
            </div>
        </div>
        <div class="rowItemFolder"
            v-else-if="item.isFolder">
            <FolderIcon class="rowItemIcon" :color="primaryColor" />
            <div class="rowItemFolderTitle" :style="{ color: primaryColor }">
                {{ item.name}}
            </div>
        </div>
        <div class="rowItemFolder"
            v-else-if="item.isText">
            <TextFileIcon class="rowItemIcon" :color="primaryColor" />
            <div class="rowItemFolderTitle" :style="{ color: primaryColor }">
                {{ item.name }}
            </div>
        </div>
        <div class="rowItemFolder"
            v-else-if="isFile">
            <FileIcon class="rowItemIcon" :color="primaryColor" />
            <div class="rowItemFolderTitle" :style="{ color: primaryColor }">
                {{ item.name }}
            </div>
        </div>
        <div class="imageContainer" :class="{ contain: shouldHaveBack }"
            v-else>
            <img
                :src="previewImage"
                v-if="previewImage"
                :style="{ visibility: (imageLoaded ? 'visible' : 'hidden') }"
                :class="{ currentImageBlurred: currentImageBlurred, }"
                @load="onImageLoad"
                @error="onImageError"
            />
            <div class="placeholderBlurer"></div>
            <img
                :src="placeholderPreviewImage"
                class="placeholderPreviewImage"
            />
            <div class="absoluteCenter" v-if="progress !== null && progress < 100">
                <svg class="circularProgress" viewBox="0 0 50 50">
                    <circle class="progressBg" cx="25" cy="25" r="20"></circle>
                    <circle
                        class="progressBar"
                        cx="25"
                        cy="25"
                        r="20"
                        :style="{ strokeDashoffset: progressOffset }"
                    ></circle>
                </svg>
            </div>
            <div class="durationLabel" v-if="duration">{{ duration }}</div>
        </div>
    </div>

</template>
<style type="text/css" scoped>
    .rowItemContainer {
        position: relative;
        border-radius: 0px;
        overflow: hidden;
        cursor: pointer;
        opacity: 1;
        /* box-shadow: 1px 1px 20px 3px rgba(0,0,0,1) inset; */
        /* box-shadow: 0 1px -3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24); */
        /* transition: box-shadow 0.3s ease, opacity 0.3s ease-in-out; */
    }

    .rowItemContainer:hover {
        opacity: 0.9;
        /* box-shadow: 1px 1px 20px 3px rgba(0,0,0,1) inset; */
        /* box-shadow: 0 3px 6px rgba(0, 0, 0, 0.16), 0 3px 6px rgba(0, 0, 0, 0.23); */
    }

    .rowItemFolder {
        position: relative;
        width: 100%;
        height: var(--row-height, 200px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }

    .rowItemIcon {
        width: 50%;
        height: 50%;
    }

    .rowItemFolderTitle {
        text-align: center;
        color: var(--q-primary);
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 3px;
        font-weight: 500;
        pointer-events: none;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
    }

    .imageContainer {
        position: relative;
        width: 100%;
        height: var(--row-height, 200px);
        overflow: hidden;
    }

    .imageContainer img {
        position: absolute;
        z-index: 6;
        width: 100%;
        height: 100%;
        object-position: 50% 50%;
        opacity: 1;
        /* transform: scale(1); */
        transition: filter ease-in 100ms, transform ease-in 500ms, opacity ease-in 500ms;
    }

    .placeholderBlurer {
        position: absolute;
        z-index: 5;
        top: 0; left: 0; right: 0; bottom: 0;
        backdrop-filter: blur(5px);
        background-color: rgba(255, 255, 255, 0.3);
    }

    .imageContainer img.placeholderPreviewImage {
        z-index: 3;
    }

    .rowItemContainer:hover .imageContainer img {
        /* transform: scale(1.01); */
    }

    .isToBeUploaded img {
        opacity: 0.2;
    }

    .rowItemBack {
        position: absolute;
        z-index: 2;
        left: 2px;
        right: 2px;
        top: 2px;
        bottom: 2px;
        border-radius: 4px;
        overflow: hidden;
    }

    .rowItemBack img {
        object-position: 50% 50%;
        object-fit: cover;
        width: 100%;
        height: var(--row-height, 200px);
        border-radius: 4px;
        opacity: 0.3;
    }

    .rowItemBackBlurred img {
        /* filter: scale(1.2) blur(10px); */
    }

    .absoluteCenter {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background-color: transparent;
    }

    .circularProgress {
        width: 50px;
        height: 50px;
        transform: rotate(-90deg);
    }

    .progressBg {
        fill: none;
        stroke: rgba(255, 255, 255, 0.2);
        stroke-width: 4;
    }

    .progressBar {
        fill: none;
        stroke: var(--q-primary, #836ef9);
        stroke-width: 4;
        stroke-linecap: round;
        stroke-dasharray: 125.6;
        transition: stroke-dashoffset 0.3s ease;
    }

    .durationLabel {
        position: absolute;
        bottom: 6px;
        right: 6px;
        background-color: rgba(0, 0, 0, 0.75);
        color: white;
        font-size: 12px;
        padding: 2px 6px;
        border-radius: 3px;
        font-weight: 500;
        z-index: 99999;
        pointer-events: none;
    }

    @media screen and (max-width: 900px) {
        .imageContainer {
            height: 100px;
        }

        .rowItemBack img {
            height: 100px;
        }
    }

</style>
<script>
import FolderIcon from './helpers/FolderIcon.vue';
import TextFileIcon from './helpers/TextFileIcon.vue';
import FileIcon from './helpers/FileIcon.vue';
import { toRaw } from 'vue';

export default {
    name: 'FileManagerBrowserRowItem',
    components: {
        FolderIcon,
        TextFileIcon,
        FileIcon,
    },
    props: {
        item: Object,
        primaryColor: {
            type: String,
            required: false,
            default: 'var(--q-primary)',
        },
    },
    emits: ['itemClick'],
    data() {
        return {
            initialized: false,
            name: '',

            isToBeUploaded: false,
            shouldHaveBack: false,
            previewImage: null,
            placeholderPreviewImage: null,
            progress: null,
            imageLoaded: false,

            currentImageBlurred: false,
            previewInitialized: false,
        }
    },
    watch: {
    },
    methods: {
        async onClick() {
            this.$emit('itemClick', this.item);
        },
        onImageLoad() {
            this.imageLoaded = true;
        },
        onImageError() {
            console.error('Failed to load image');
        },
        async initializePreview() {
            if (this.previewInitialized) return;
            this.previewInitialized = true;
            if (!this.item.isFolder && !this.item.isBackButton && !this.item.isText) {
                const rawItem = toRaw(this.item);
                rawItem.getPreviewURL('low').then((preview)=>{
                    this.previewImage = preview;
                    this.currentImageBlurred = false;
                });
            }
        }
    },
    created() {
        // if (this.item.hasHighPreview()) {
        //     this.previewImage = this.item.hasHighPreview();
        //     this.placeholderPreviewImage = ''+this.previewImage;
        // } else {
        //     this.previewImage = this.item.getLowPreview();
        //     this.placeholderPreviewImage = ''+this.previewImage;
        // }

        // if (this.item.ratio < 0.51 || this.item.ratio > 3) {
        //     this.shouldHaveBack = true;
        // }
    },
    beforeMount() {
        if (!this.item.isFolder && !this.item.isBackButton && !this.item.isText) {
            const rawItem = toRaw(this.item);
            rawItem.getPreviewURL('nano').then((preview)=>{
                this.placeholderPreviewImage = preview;
                this.currentImageBlurred = true;
            });
        }
    },
    mounted() {
        // this.item.getPreviewURL('nano').then((preview)=>{
        //     this.placeholderPreviewImage = preview;
        //     this.currentImageBlurred = true;
        // });

        // setTimeout(()=>{
        //     this.item.getPreviewURL('low').then((preview)=>{
        //         this.previewImage = preview;
        //         this.currentImageBlurred = false;

        //         this.progress = null;
        //     });
        // }, 100);

        // this.item.getPreview('nano').then((preview)=>{
        //     this.previewImage = preview;
        // });
        // this.__filePreviewListener = (e)=>{
        //     this.previewImage = e.detail.preview;
        // };
        // this.__fileProgressListener = (e)=>{
        //     this.progress = e.detail.progress;
        //     if (this.progress == 100) {
        //         this.isToBeUploaded = false;
        //     }
        // };
        // this.file.addEventListener('preview', this.__filePreviewListener);
        // this.file.addEventListener('progress', this.__fileProgressListener);

        // this.isToBeUploaded = this.file.isToBeUploaded;
    },
    unmounted() {
        toRaw(this.item).dispose();
    },
    computed: {
        currentImage() {
            if (this.previewImage && this.imageLoaded) {
                return this.previewImage;
            }
            return this.placeholderPreviewImage || '';
        },
        progressOffset() {
            if (this.progress === null) return 125.6;
            const percentage = this.progress * 100;
            return 125.6 - (125.6 * percentage) / 100;
        },
        duration() {
            return this.item?.durationFormatted || null;
        },
        isFile() {
            return this.item.isFile || false;
        }
    },
}
</script>
