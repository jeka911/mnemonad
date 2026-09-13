

export default class FileManagerAbstract {
    constructor() {
        this.__listeners = new Map();
    }

    on(event, callback) {
        if (!this.__listeners.has(event)) {
            this.__listeners.set(event, new Set());
        }
        this.__listeners.get(event).add(callback);
    }

    off(event, callback) {
        const set = this.__listeners.get(event);
        if (!set) return;
        set.delete(callback);
    }

    emit(event, payload) {
        const set = this.__listeners.get(event);
        if (!set) return;
        for (const cb of set) {
            cb(payload);
        }
    }
}