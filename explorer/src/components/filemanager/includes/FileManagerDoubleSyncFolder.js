import { DoubleSyncFolder } from '@fizzyflow/doublesync';
import FileManagerDoubleSyncFile from './FileManagerDoubleSyncFile.js';
import FileManagerRowBuilder from './FileManagerRowBuilder.js';
import FileManagerBackButton from './FileManagerBackButton.js';
import FileManagerNanoThumb from './FileManagerNanoThumb.js';

let _idCounter = 0;

/**
 * A DoubleSyncFolder subclass that also provides the UI layer FileManagerBrowser needs:
 * row builder, event emitter, push, preview loading, folder navigation.
 *
 * Each child file is a FileManagerDoubleSyncFile (binary-packed media metadata + content).
 * Subfolders are FileManagerDoubleSyncFolder instances.
 */
export default class FileManagerDoubleSyncFolder extends DoubleSyncFolder {
	constructor(name, params = {}) {
		super();
		if (typeof name !== 'string' || !name) throw new Error('FileManagerDoubleSyncFolder: name required');
		this._name = name;
		this.id = 'dsfo_' + (++_idCounter) + '_' + Math.random().toString(36).substring(2, 8);

		/** @type {FileManagerDoubleSyncFolder|null} */
		this._parent = params.parent || null;
		/** @type {Map<string, FileManagerDoubleSyncFile|FileManagerDoubleSyncFolder>} */
		this._children = new Map();

		// UI state
		this._rowBuilder = new FileManagerRowBuilder();
		this._rowBuilder.on('rowAdded', (row) => this._emit('rowAdded', row));
		this._rowBuilder.on('rowRemoved', (row) => this._emit('rowRemoved', row));
		this._items = [];
		this._folders = [];
		this._listeners = new Map();
		this._loaded = false;
		this._pendingCount = 0;
	}

	// ── DoubleSyncFolder interface ──

	get name() { return this._name; }

	async list() { return [...this._children.values()]; }

	async addFile(name, bytes) {
		const file = FileManagerDoubleSyncFile.fromRaw(name, bytes);
		file._folder = this;
		this._children.set(name, file);
		return file;
	}

	async addFolder(name) {
		const existing = this._children.get(name);
		if (existing instanceof FileManagerDoubleSyncFolder) return existing;
		if (existing) throw new Error(`addFolder: '${name}' already exists as a file`);
		const folder = new FileManagerDoubleSyncFolder(name, { parent: this });
		this._children.set(name, folder);
		return folder;
	}

	async removeChild(name) {
		console.log('DSFolder.removeChild', name, 'children:', [...this._children.keys()]);
		const child = this._children.get(name);
		if (!child) { console.log('DSFolder.removeChild: child not found'); return false; }
		this._children.delete(name);

		const arr = child instanceof FileManagerDoubleSyncFolder ? this._folders : this._items;
		const idx = arr.indexOf(child);
		if (idx !== -1) arr.splice(idx, 1);

		const removed = this._rowBuilder.remove(child);
		console.log('DSFolder.removeChild: rowBuilder.remove =>', removed, 'items left:', this._items.length, 'folders left:', this._folders.length);

		this.markChanged({ type: 'remove', name });
		return true;
	}

	// ── UI-facing API ──

	get parent() { return this._parent; }
	get isFolder() { return true; }
	get isBackButton() { return false; }
	get ratio() { return 1; }
	get rows() { return this._rowBuilder.rows; }
	get items() { return this._items; }
	get folders() { return this._folders; }

	get fullPath() {
		if (this._parent) return this._parent.fullPath + '/' + this._name;
		if (this._name && this._name !== '___root___') return '/' + this._name;
		return '';
	}

	/** Lightweight pending-changes interface expected by FileManagerTopLeftMenu — scoped to
	 *  this one folder, same as `_pendingCount` itself (see `totalPendingChangesCount` below
	 *  for the whole-subtree count "Sync to chain" actually needs). */
	get pendingChanges() {
		return {
			pendingCount: this._pendingCount,
			on: (event, cb) => this.on('pendingChange', cb),
			off: (event, cb) => this.off('pendingChange', cb),
		};
	}

	get pendingChangesCount() { return this._pendingCount; }

	/**
	 * Pending changes anywhere in this subtree — this folder's own plus every descendant's,
	 * recursively. This (not `pendingChangesCount`, which is local to one folder) is what
	 * "Sync to chain" needs: a push from the root walks the *whole* tree, so a change made
	 * three levels down is just as real as one made at the root, and a nested subfolder's
	 * own local count is invisible to anything watching only the root (confirmed live: this
	 * is exactly why a file added inside a Live-pulled subfolder never enabled the button).
	 * Walks `_children` directly rather than `_folders`/`_loaded` state, so it's correct
	 * regardless of which parts of the tree the UI has actually navigated into and loaded.
	 */
	get totalPendingChangesCount() {
		let total = this._pendingCount;
		for (const child of this._children.values()) {
			if (child instanceof FileManagerDoubleSyncFolder) total += child.totalPendingChangesCount;
		}
		return total;
	}

	/**
	 * Marks a change as pending — same bookkeeping every mkdir/pushMediaFile/pushTextFile/
	 * removeChild call site here uses, extracted so a *file*'s own edit
	 * (FileManagerDoubleSyncFile.setContent/setTextContent, which mutates the file object
	 * directly and has no other reason to reach back into its parent folder) can mark the
	 * same "sync to chain" pending state those already do, instead of silently not counting.
	 *
	 * Also bubbles a plain 'change' up through every ancestor (not their own `_pendingCount`
	 * — that stays local, for FileManagerTopLeftMenu's per-folder badge — just the event),
	 * so anything watching a whole subtree (see `totalPendingChangesCount` above) knows to
	 * re-read it, no matter how deep the actual edit happened.
	 * @param {Object} [change={type:'edit'}] - forwarded as-is to the 'pendingChange' event.
	 */
	markChanged(change = { type: 'edit' }) {
		this._pendingCount++;
		this._emit('change');
		this._emit('pendingChange', { change });
		for (let ancestor = this._parent; ancestor; ancestor = ancestor._parent) {
			ancestor._emit('change');
		}
	}

	/**
	 * Called by the save button. Emits 'save' so the parent page can call monadSync.push().
	 * A root-level push commits the *whole* tree (DoubleSync's diff walks every descendant),
	 * so every descendant's pending count is cleared too, not just this folder's own —
	 * otherwise a subfolder edited earlier would still report itself "pending" immediately
	 * after a successful sync.
	 */
	async implementChanges() {
		this._emit('save');
		this._resetPendingCounts();
		this._emit('change');
	}

	/** @private Recursively zeroes this folder's own pending count and every descendant's,
	 *  firing 'pendingChange' on each so a per-folder badge (FileManagerTopLeftMenu)
	 *  watching any of them updates too. */
	_resetPendingCounts() {
		this._pendingCount = 0;
		this._emit('pendingChange', { implemented: true });
		for (const child of this._children.values()) {
			if (child instanceof FileManagerDoubleSyncFolder) child._resetPendingCounts();
		}
	}

	/**
	 * Load children into the UI row builder. Call once after construction.
	 */
	async load() {
		if (this._loaded) return;
		this._loaded = true;

		if (this._parent) {
			this._rowBuilder.unshift(new FileManagerBackButton({ parent: this._parent }));
		}

		for (const [, child] of this._children) {
			if (child instanceof FileManagerDoubleSyncFolder) {
				this._folders.push(child);
				this._rowBuilder.unshift(child);
				this._emit('folder', child);
			} else if (child instanceof FileManagerDoubleSyncFile) {
				child._folder = this;
				this._items.push(child);
				this._rowBuilder.push(child);
				this._emit('item', child);
			}
		}
	}

	/**
	 * No-op for doublesync-backed files (previews are inline in binary content).
	 * Provided for compatibility with FileManagerBrowserRow.restore().
	 */
	async loadPreviews() {}

	/**
	 * Add a media file from a browser File object. Reads dimensions, generates thumbnail,
	 * packs everything into binary content, and adds to the tree.
	 */
	async pushMediaFile(file) {
		const uniqueName = this._pickUniqueName(file.name || 'unnamed');
		const mediaBytes = new Uint8Array(await file.arrayBuffer());

		let width = 0, height = 0, duration = 0, thumbnail = null;

		if (file.type?.startsWith('image/') || file.type?.startsWith('video/')) {
			const dims = await this._extractDimensions(file);
			width = dims.width;
			height = dims.height;
			duration = dims.duration || 0;
			thumbnail = dims.thumbnail;
		}

		const dsFile = FileManagerDoubleSyncFile.create(uniqueName, mediaBytes, {
			width, height, duration, thumbnail,
		});
		dsFile._folder = this;

		this._children.set(uniqueName, dsFile);
		if (this._loaded) {
			this._items.push(dsFile);
			this._rowBuilder.push(dsFile);
			this._emit('item', dsFile);
		}
		this.markChanged({ type: 'add' });

		return dsFile;
	}

	has(item) {
		if (item instanceof FileManagerDoubleSyncFile) return this._items.includes(item);
		if (item instanceof FileManagerDoubleSyncFolder) return this._folders.includes(item);
		return false;
	}

	async mkdir(folderName) {
		const folder = await this.addFolder(folderName);
		if (this._loaded) {
			if (!this._folders.includes(folder)) {
				this._folders.push(folder);
				this._rowBuilder.unshift(folder);
			}
			this._emit('folder', folder);
		}
		this.markChanged({ type: 'mkdir' });
		return folder;
	}

	getFolder(path) {
		if (path === this.fullPath) return this;
		for (const f of this._folders) {
			const found = f.getFolder(path);
			if (found) return found;
		}
		return null;
	}

	pushTextFile(name, content = '') {
		const uniqueName = this._pickUniqueName(name);
		const bytes = new TextEncoder().encode(content);
		const dsFile = FileManagerDoubleSyncFile.create(uniqueName, bytes, {});
		dsFile._folder = this;
		this._children.set(uniqueName, dsFile);
		if (this._loaded) {
			this._items.push(dsFile);
			this._rowBuilder.push(dsFile);
			this._emit('item', dsFile);
		}
		this.markChanged({ type: 'add' });
		return dsFile;
	}

	dispose() {}

	// ── Event emitter (minimal, same interface as FileManagerAbstract) ──

	on(event, cb) {
		if (!this._listeners.has(event)) this._listeners.set(event, new Set());
		this._listeners.get(event).add(cb);
	}
	off(event, cb) {
		const s = this._listeners.get(event);
		if (s) s.delete(cb);
	}
	_emit(event, payload) {
		const s = this._listeners.get(event);
		if (!s) return;
		for (const cb of s) cb(payload);
	}

	// ── Static: build from a DoubleSyncMemoryFolder (e.g. after MonadSync.restore()) ──

	static fromMemoryFolder(memFolder, parent = null) {
		const folder = new FileManagerDoubleSyncFolder(memFolder.name || '___root___', { parent });
		if (memFolder._children) {
			for (const [name, child] of memFolder._children) {
				if (child.constructor?.name === 'DoubleSyncMemoryFolder' ||
					(child instanceof DoubleSyncFolder)) {
					const sub = FileManagerDoubleSyncFolder.fromMemoryFolder(child, folder);
					folder._children.set(name, sub);
				} else {
					const content = child._content || new Uint8Array(0);
					const dsFile = FileManagerDoubleSyncFile.fromRaw(name, content);
					dsFile._folder = folder;
					folder._children.set(name, dsFile);
				}
			}
		}
		return folder;
	}

	// ── Internal helpers ──

	_pickUniqueName(desired) {
		const existing = new Set(this._children.keys());
		if (!existing.has(desired)) return desired;
		const lastDot = desired.lastIndexOf('.');
		const base = lastDot > 0 ? desired.substring(0, lastDot) : desired;
		const ext = lastDot > 0 ? desired.substring(lastDot) : '';
		let counter = 1;
		let name = `${base}_${counter}${ext}`;
		while (existing.has(name)) {
			counter++;
			name = `${base}_${counter}${ext}`;
		}
		return name;
	}

	async _extractDimensions(file) {
		const url = URL.createObjectURL(file);
		try {
			if (file.type.startsWith('image/')) {
				return await this._loadImageDims(url);
			} else if (file.type.startsWith('video/')) {
				return await this._loadVideoDims(url);
			}
		} finally {
			URL.revokeObjectURL(url);
		}
		return { width: 0, height: 0, duration: 0, thumbnail: null };
	}

	_loadImageDims(url) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = async () => {
				const thumbnail = await FileManagerNanoThumb.generate(img);
				resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0, thumbnail });
				img.src = '';
			};
			img.onerror = () => { img.src = ''; reject(new Error('Failed to load image')); };
			img.src = url;
		});
	}

	_loadVideoDims(url) {
		return new Promise((resolve, reject) => {
			const video = document.createElement('video');
			video.preload = 'metadata';
			video.muted = true;
			video.onloadedmetadata = () => { video.currentTime = Math.min(1, video.duration * 0.1); };
			video.onseeked = async () => {
				const thumbnail = await FileManagerNanoThumb.generate(video);
				const result = { width: video.videoWidth, height: video.videoHeight, duration: video.duration, thumbnail };
				video.src = '';
				video.load();
				resolve(result);
			};
			video.onerror = () => { video.src = ''; video.load(); reject(new Error('Failed to load video')); };
			video.src = url;
		});
	}
}
