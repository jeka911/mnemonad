import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import StaticEmbeddingProvider from './embeddings/StaticEmbeddingProvider.js';
import { nodeModelFiles } from './embeddings/modelFiles.node.js';
import { EMBEDDER_STATIC, EMBEDDER_TRANSFORMERS, embedderForModel } from './schema.js';

/**
 * Embedding providers for Node — the built-in static one, or one from the optional
 * transformers extension.
 *
 * The extension (`mnemonad-search-transformers`) is deliberately *not* a dependency of the CLI:
 * it brings ONNX Runtime, ~450 MB installed, for the one feature (MiniLM-style neural models)
 * most users never need. It's installed separately, and found at runtime:
 *
 *  1. A plain `import()`. Node resolves it by walking up from this file's own folder, which
 *     reaches it for a local project install, `npx -p … -p …`, and npm's global installs —
 *     global packages sit side by side in `<prefix>/lib/node_modules`, which the walk reaches.
 *  2. Failing that, the package managers' own global folders: `npm root -g` (for layouts the
 *     walk doesn't reach), then `pnpm root -g`. pnpm 11 installs every global package into its
 *     own isolated folder (`<root>/<hash>/node_modules/<pkg>`), so there the CLI can never see
 *     a sibling by walking up; each of those folders is checked instead, newest first.
 */

export const EXTENSION_PACKAGE = 'mnemonad-search-transformers';

/** What this CLI expects the extension's interface to look like; the extension exports its own. */
export const EXTENSION_API_VERSION = 1;

export const EXTENSION_INSTALL = `npm install -g ${EXTENSION_PACKAGE}   (or: pnpm add -g ${EXTENSION_PACKAGE})`;

export class MissingExtensionError extends Error {
	constructor(model) {
		super(
			`${model} needs the optional transformers extension (about 450 MB installed, not included by default):\n` +
			`    ${EXTENSION_INSTALL}`
		);
		this.name = 'MissingExtensionError';
		this.model = model;
	}
}

/**
 * @param {Object} [opts] - both overridable for tests
 * @param {(specifier: string) => Promise<any>} [opts.importer]
 * @param {() => string[]} [opts.globalRoots] - global package folders to look in (see above)
 * @returns {Promise<?any>} the extension module, or null when it isn't installed
 */
export async function findTransformersExtension({ importer = (s) => import(s), globalRoots = defaultGlobalRoots } = {}) {
	try {
		return await importer(EXTENSION_PACKAGE);
	} catch (err) {
		if (!isNotFound(err)) throw err;
	}
	for (const root of globalRoots()) {
		const pkgJson = extensionIn(root);
		if (!pkgJson) continue;
		// Resolved from inside the package itself (a self-reference through its own `exports`),
		// so the entry point is whatever the package declares, not a guessed file name.
		const entry = createRequire(pkgJson).resolve(EXTENSION_PACKAGE);
		return importer(pathToFileURL(entry).href);
	}
	return null;
}

/**
 * The extension's package.json under one global folder, or null. Only these exact places —
 * never a module-resolution walk, which could wander out of the folder and pick up some
 * unrelated copy:
 *  - `<root>/<package>` — npm, and older pnpm, where global packages sit side by side;
 *  - `<root>/<dir>/node_modules/<package>` — pnpm 11's isolated per-package folders; newest
 *    first, since reinstalling leaves an older folder behind until pnpm prunes it.
 */
function extensionIn(root) {
	const direct = join(root, EXTENSION_PACKAGE, 'package.json');
	if (existsSync(direct)) return direct;
	let dirs;
	try {
		dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
	} catch {
		return null;
	}
	const found = dirs
		.map((d) => join(root, d.name, 'node_modules', EXTENSION_PACKAGE, 'package.json'))
		.filter((p) => existsSync(p))
		.map((p) => ({ p, mtime: statSync(p).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	return found.length ? found[0].p : null;
}

/**
 * @param {string} model - for the error message
 * @param {Object} [opts] - see findTransformersExtension
 */
export async function loadTransformersExtension(model, opts) {
	const ext = await findTransformersExtension(opts);
	if (!ext) throw new MissingExtensionError(model);
	if (ext.apiVersion !== EXTENSION_API_VERSION) {
		throw new Error(
			`${EXTENSION_PACKAGE} speaks extension API v${ext.apiVersion ?? '?'}, but this mnemonad-cli expects ` +
			`v${EXTENSION_API_VERSION} — update both: npm install -g mnemonad-cli@latest ${EXTENSION_PACKAGE}@latest`
		);
	}
	return ext;
}

/**
 * @param {Object} params
 * @param {string} params.model - full model id
 * @param {string} [params.embedder] - defaults to what the model needs (see embedderForModel)
 * @param {?string} [params.dtype] - transformers models only
 * @param {(event: Object) => void} [params.onProgress]
 * @param {Object} [params.extension] - passed to loadTransformersExtension (tests)
 */
export async function createProvider({ model, embedder = embedderForModel(model), dtype = null, onProgress = null, extension } = {}) {
	if (embedder === EMBEDDER_STATIC) {
		return new StaticEmbeddingProvider({ model, files: nodeModelFiles(model, { onProgress }) });
	}
	if (embedder === EMBEDDER_TRANSFORMERS) {
		const ext = await loadTransformersExtension(model, extension);
		return ext.createProvider({ model, ...(dtype ? { dtype } : {}), onProgress });
	}
	throw new Error(`unknown embedder '${embedder}' (expected ${EMBEDDER_STATIC} or ${EMBEDDER_TRANSFORMERS})`);
}

function isNotFound(err) {
	return !!err
		&& (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')
		// Only the extension itself being absent — a missing dependency *inside* an installed
		// extension is a broken install, and should surface as such.
		&& String(err.message).includes(`'${EXTENSION_PACKAGE}'`);
}

/** npm's and pnpm's global package folders — whichever of the two is installed. Asked only
 *  when the plain import has already missed, so a normal run never spawns either. */
function defaultGlobalRoots() {
	return ['npm', 'pnpm'].map(globalRootOf).filter(Boolean);
}

function globalRootOf(tool) {
	try {
		return execFileSync(tool, ['root', '-g'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 10_000,
			shell: process.platform === 'win32',
		}).trim() || null;
	} catch {
		return null;
	}
}
