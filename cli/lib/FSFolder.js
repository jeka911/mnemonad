import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
// monadsync re-exports its whole sync-primitives surface so a consumer needs only one
// dependency, not two — see monadsync/index.js.
import { DoubleSyncFolder as SyncFolder } from 'monadsync';
import { FSFile } from './FSFile.js';

const DEFAULT_EXCLUDES = ['node_modules', '.git', '.env', '.DS_Store', '.mnemonad', '.claude', 'pnpm-lock.yaml', 'package-lock.json'];

export class FSFolder extends SyncFolder {
    constructor(dirPath, excludes = DEFAULT_EXCLUDES) {
        super();
        this._path = dirPath;
        this._name = basename(dirPath);
        this._excludes = excludes;
    }

    get name() { return this._name; }

    async list() {
        const entries = await readdir(this._path, { withFileTypes: true });
        const children = [];

        for (const entry of entries) {
            if (this._excludes.includes(entry.name)) continue;
            if (entry.name.startsWith('.')) continue;

            const fullPath = join(this._path, entry.name);

            if (entry.isDirectory()) {
                children.push(new FSFolder(fullPath, this._excludes));
            } else if (entry.isFile()) {
                children.push(new FSFile(fullPath));
            }
        }

        return children;
    }
}
