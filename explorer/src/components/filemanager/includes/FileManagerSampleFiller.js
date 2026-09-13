const TEXT_SAMPLES = import.meta.glob('../samples/text/*', { eager: true, query: '?raw', import: 'default' });
const IMAGE_SAMPLES = import.meta.glob('../samples/images/*', { eager: true, query: '?url', import: 'default' });

export default class FileManagerSampleFiller {
    async fill(folder, { maxImages = Infinity, includeText = true } = {}) {
        const textEntries = Object.entries(TEXT_SAMPLES);
        const imageEntries = Object.entries(IMAGE_SAMPLES).slice(0, maxImages);

        const textFolder = await folder.mkdir('Text');
        const imagesFolder = await folder.mkdir('Images');
        const mixedFolder = await folder.mkdir('Mixed');

        if (includeText) {
            for (const [path, content] of textEntries) {
                const name = path.split('/').pop();
                textFolder.pushTextFile(name, content);
                mixedFolder.pushTextFile(name, content);
            }
        }

        for (const [path, url] of imageEntries) {
            const name = path.split('/').pop();
            const file = await this._fetchImageFile(url, name);
            await imagesFolder.pushMediaFile(file);
            await mixedFolder.pushMediaFile(file);
        }
    }

    async _fetchImageFile(url, name) {
        const res = await fetch(url);
        const blob = await res.blob();
        return new File([blob], name, { type: blob.type || 'image/jpeg' });
    }
}
