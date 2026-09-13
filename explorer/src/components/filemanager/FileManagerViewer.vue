<template>
    <div
        v-if="showing"
        class="fileManagerViewer"
        @click.self="onHide"
        @touchstart="handleTouchStart"
        @touchmove="handleTouchMove"
        @touchend="handleTouchEnd"
    >
        <div class="fileManagerViewerDialog" @click.self="onHide">
            <div class="fileManagerViewerContent" @click.self="onHide">
                <img
                    v-if="showingType === 'photo' && previewSrc && isLoading"
                    :src="previewSrc"
                    :style="mediaStyle"
                    class="mediaDisplay previewImage"
                />

                <div v-if="isLoading" class="loadingContainer">
                    <Spinner :size="48" />
                </div>

                <img
                    v-if="showingType === 'photo' && imageSrc"
                    :src="imageSrc"
                    :style="mediaStyle"
                    class="mediaDisplay"
                    :class="{ 'hidden': isLoading }"
                    @load="isLoading = false"
                />

                <video
                    v-if="showingType === 'video' && videoSrc"
                    :src="videoSrc"
                    class="mediaDisplay"
                    controls
                    autoplay
                    @loadeddata="isLoading = false"
                />

                <div class="navigationOverlay">
                    <div
                        class="navigationArea navigationLeft"
                        :class="{ 'disabled': !hasPrevious }"
                        @click.stop="hasPrevious && goToPrevious()"
                    >
                        <svg class="navigationArrow" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                    </div>
                    <div
                        class="navigationArea navigationRight"
                        :class="{ 'disabled': !hasNext }"
                        @click.stop="hasNext && goToNext()"
                    >
                        <svg class="navigationArrow" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                </div>
            </div>

            <button class="closeButton" @click="onHide">&times;</button>
        </div>
    </div>
</template>

<script>
import Spinner from './helpers/Spinner.vue';

export default {
    name: 'FileManagerViewer',
    components: { Spinner },
    props: {
        resource: { type: Object, required: false, default: null },
        folder: { type: Object, required: false, default: null },
        browserWidth: { type: Number, required: false, default: null },
        browserHeight: { type: Number, required: false, default: null },
    },
    data() {
        return {
            showing: false,
            resourceToShow: null,
            showingType: null,
            imageSrc: null,
            videoSrc: null,
            previewSrc: null,
            isLoading: false,
            currentItemIndex: -1,
            mediaItems: [],
            touchStartX: 0, touchEndX: 0,
            touchStartY: 0, touchEndY: 0,
        };
    },
    computed: {
        hasPrevious() { return this.currentItemIndex > 0; },
        hasNext() { return this.currentItemIndex >= 0 && this.currentItemIndex < this.mediaItems.length - 1; },
        mediaStyle() {
            if (!this.resourceToShow?.width || !this.resourceToShow?.height) return {};
            const w = this.resourceToShow.width;
            const h = this.resourceToShow.height;
            const ar = w / h;
            const maxH = (this.browserHeight || window.innerHeight) - 56;
            const maxW = (this.browserWidth || window.innerWidth) - 56;
            let fw = w, fh = h;
            if (fh > maxH) { fh = maxH; fw = fh * ar; }
            if (fw > maxW) { fw = maxW; fh = fw / ar; }
            return { width: `${Math.round(fw)}px`, height: `${Math.round(fh)}px` };
        },
    },
    watch: {
        async resource(res) {
            if (!res) { this.cleanup(); return; }
            if (this.folder) {
                this.mediaItems = this.folder._items || this.folder.items || [];
            } else {
                this.mediaItems = [];
            }
            this.currentItemIndex = this.mediaItems.findIndex(i => i.id === res.id);
            await this.showResource(res);
        },
        showing(v) {
            if (v) window.addEventListener('keydown', this.handleKeyPress);
            else window.removeEventListener('keydown', this.handleKeyPress);
        },
    },
    methods: {
        async showResource(resource) {
            this.resourceToShow = resource;
            this.showing = true;
            this.isLoading = true;
            this.revokeMedia();

            const isImage = resource.mimeType?.startsWith('image/');
            const isVideo = resource.mimeType?.startsWith('video/');

            if (isImage) {
                this.showingType = 'photo';
                try { this.previewSrc = await resource.getPreviewURL('nano'); } catch {}
                this.imageSrc = await resource.getPreviewURL('high').catch(() =>
                    resource.getPreviewURL('low')
                );
            } else if (isVideo) {
                this.showingType = 'video';
                this.videoSrc = await resource.getPreviewURL('high').catch(() => '');
            } else {
                this.isLoading = false;
            }
        },
        async goToPrevious() {
            if (!this.hasPrevious) return;
            this.currentItemIndex--;
            await this.showResource(this.mediaItems[this.currentItemIndex]);
        },
        async goToNext() {
            if (!this.hasNext) return;
            this.currentItemIndex++;
            await this.showResource(this.mediaItems[this.currentItemIndex]);
        },
        handleTouchStart(e) { this.touchStartX = e.changedTouches[0].screenX; this.touchStartY = e.changedTouches[0].screenY; },
        handleTouchMove(e) { this.touchEndX = e.changedTouches[0].screenX; this.touchEndY = e.changedTouches[0].screenY; },
        handleTouchEnd() {
            const dx = this.touchEndX - this.touchStartX;
            const dy = this.touchEndY - this.touchStartY;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
                if (dx > 0) this.goToPrevious(); else this.goToNext();
            }
            this.touchStartX = this.touchEndX = this.touchStartY = this.touchEndY = 0;
        },
        handleKeyPress(e) {
            if (e.key === 'ArrowLeft') { e.preventDefault(); this.goToPrevious(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); this.goToNext(); }
            else if (e.key === 'Escape') { e.preventDefault(); this.onHide(); }
        },
        onHide() {
            this.showing = false;
            this.$emit('hide');
            this.cleanup();
        },
        revokeMedia() {
            this.imageSrc = null;
            this.videoSrc = null;
            this.previewSrc = null;
        },
        cleanup() {
            this.revokeMedia();
            this.resourceToShow = null;
            this.showingType = null;
            this.currentItemIndex = -1;
            this.mediaItems = [];
            this.showing = false;
        },
    },
    unmounted() {
        window.removeEventListener('keydown', this.handleKeyPress);
        this.revokeMedia();
    },
};
</script>

<style scoped>
.fileManagerViewer {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background-color: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9200;
    cursor: pointer;
}
.fileManagerViewerDialog {
    position: relative;
    width: calc(100vw - 16px);
    height: calc(100vh - 16px);
    border-radius: 8px;
    padding: 20px;
    cursor: default;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}
.fileManagerViewerContent {
    position: relative;
    width: 100%; height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
}
.mediaDisplay { object-fit: contain; display: block; margin: auto; max-width: 100%; max-height: 100%; }
.loadingContainer {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    z-index: 10; pointer-events: none;
}
.closeButton {
    position: absolute; top: 10px; right: 10px;
    width: 36px; height: 36px; border: none;
    background: rgba(0, 0, 0, 0.5); color: white;
    font-size: 28px; line-height: 1; cursor: pointer;
    border-radius: 50%; display: flex;
    align-items: center; justify-content: center;
    z-index: 9202;
}
.closeButton:hover { background: rgba(0, 0, 0, 0.7); }
.navigationOverlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 9201; }
.navigationArea {
    position: absolute; top: 0; bottom: 0; width: 200px;
    cursor: pointer; pointer-events: auto;
    display: flex; align-items: center; justify-content: center; opacity: 1;
}
.navigationArea.disabled { opacity: 0.1; cursor: default; pointer-events: none; }
.navigationArrow { opacity: 0.3; color: white; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5)); }
.navigationArea:hover .navigationArrow { opacity: 1; }
.navigationLeft { left: 0; background: linear-gradient(to right, rgba(0,0,0,0), transparent); }
.navigationLeft:hover { background: linear-gradient(to right, rgba(0,0,0,0.3), transparent); }
.navigationRight { right: 0; background: linear-gradient(to left, rgba(0,0,0,0), transparent); }
.navigationRight:hover { background: linear-gradient(to left, rgba(0,0,0,0.3), transparent); }

/* narrow screens: slim nav zones so the image center stays tappable
   (swipe already handles prev/next on touch), respect notch insets */
@media screen and (max-width: 700px) {
    .navigationArea { width: max(18vw, 48px); }
    .navigationArrow { width: 32px; height: 32px; }
    .closeButton {
        top: max(10px, env(safe-area-inset-top));
        right: max(10px, env(safe-area-inset-right));
        width: 40px;
        height: 40px;
    }
}
.previewImage { filter: blur(8px); }
.hidden { display: none; }
</style>
