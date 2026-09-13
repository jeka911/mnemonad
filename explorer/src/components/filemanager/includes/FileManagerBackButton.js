import FileManagerAbstract from './FileManagerAbstract.js';

export default class FileManagerBackButton extends FileManagerAbstract {
    constructor(params = {}) {
        super();
        this.isBackButton = true;
        this.ratio = 1;
        this.parent = params.parent || null;
    }

    dispose() {
    }
}