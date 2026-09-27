import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { downloadWithProgress, hubUrl } from './modelFiles.shared.js';

/**
 * A model's files for StaticEmbeddingProvider under Node: downloaded from the Hugging Face hub
 * once, then read from a local cache — `$MNEMONAD_CACHE_DIR`, else `$XDG_CACHE_HOME/mnemonad`,
 * else `~/.cache/mnemonad`, under `models/<model id>/`. Written through a temp file and a
 * rename, so an interrupted download never leaves a truncated file behind to be read as valid.
 *
 * @param {string} model - e.g. 'minishlab/potion-base-8M'
 * @param {Object} [opts]
 * @param {(event: Object) => void} [opts.onProgress] - `{status: 'progress', file, loaded, total}`
 * @param {string} [opts.cacheDir]
 */
export function nodeModelFiles(model, { onProgress = null, cacheDir = defaultCacheDir() } = {}) {
	const dir = join(cacheDir, 'models', ...model.split('/'));
	return {
		async get(name) {
			const path = join(dir, name);
			try {
				return new Uint8Array(await readFile(path));
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
			}
			const bytes = await downloadWithProgress(hubUrl(model, name), name, onProgress);
			await mkdir(dir, { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			await writeFile(tmp, bytes);
			await rename(tmp, path);
			return bytes;
		},
	};
}

export function defaultCacheDir() {
	if (process.env.MNEMONAD_CACHE_DIR) return process.env.MNEMONAD_CACHE_DIR;
	if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'mnemonad');
	return join(homedir(), '.cache', 'mnemonad');
}
