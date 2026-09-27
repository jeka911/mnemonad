import { join } from 'node:path';
import {
    Searcher, VectorIndex, DEFAULT_DB_NAME, createProvider, resolveModelName, MissingExtensionError,
} from '../search/index.js';
import { resolvePath, folderExists } from './shared.js';

export async function search(args) {
    if (!args.query) {
        throw userError('a search query is required (e.g. `mnemonad search /path/to/folder "how does chunking work"`)');
    }
    const destPath = resolvePath(args.path, { mustExist: true });
    const dbName = args.searchDb || DEFAULT_DB_NAME;
    const dbPath = join(destPath, dbName);

    if (!folderExists(destPath) || !(await _fileExists(dbPath))) {
        throw userError(
            `no ${dbName} found in ${destPath}\n` +
            '  Run `mnemonad index <path>` first — either yours, or whoever pushed this stream\'s\n' +
            '  (a pull already brings theirs down with the rest of the folder).'
        );
    }

    // The query has to be embedded by the model that built the index — which the index records,
    // so there's nothing to choose. An explicit --model that disagrees is a mistake worth
    // naming rather than a preference to honour.
    const indexModel = VectorIndex.readMeta(dbPath)?.model;
    if (args.model && indexModel && resolveModelName(args.model) !== indexModel) {
        throw userError(
            `${dbName} was built with ${indexModel}; a search has to use the same model — drop --model\n` +
            '  (search always uses the index\'s own), or rebuild the index with the other one:\n' +
            `    mnemonad index ${destPath} --model ${args.model} --rebuild`
        );
    }

    const searcher = new Searcher({ createProvider });
    const k = args.limit ? Number(args.limit) : 5;
    let hits;
    try {
        hits = await searcher.search(dbPath, args.query, k);
    } catch (err) {
        if (err instanceof MissingExtensionError) {
            throw userError(
                `this folder's index was built with ${err.model}, which ${err.message.slice(err.message.indexOf('needs'))}\n` +
                '  Or rebuild the index with the built-in model:\n' +
                `    mnemonad index ${destPath} --rebuild`
            );
        }
        throw err;
    }

    if (hits.length === 0) {
        console.log('  no matches');
        return;
    }

    for (const [i, hit] of hits.entries()) {
        console.log(`\n${i + 1}. ${hit.path} (chunk ${hit.chunkIndex}, distance ${hit.distance.toFixed(4)})`);
        const snippet = await _readSnippet(destPath, hit);
        if (snippet) console.log('   ' + snippet.replace(/\s+/g, ' ').slice(0, 200));
    }
}

async function _fileExists(path) {
    try {
        const { stat } = await import('node:fs/promises');
        const s = await stat(path);
        return s.isFile();
    } catch {
        return false;
    }
}

/** Re-reads the hit's snippet straight from the already-pulled source file — the index
 *  deliberately doesn't store chunk text itself (see ../search/VectorIndex.js),
 *  so this is the one place that cost is paid, and only for hits actually shown. */
async function _readSnippet(destPath, hit) {
    try {
        const { readFile } = await import('node:fs/promises');
        const bytes = await readFile(join(destPath, hit.path));
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        return text.slice(hit.startOffset, hit.endOffset);
    } catch {
        return null;
    }
}

function userError(message) {
    const err = new Error(message);
    err._isUserError = true;
    return err;
}
