import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	findTransformersExtension, loadTransformersExtension, createProvider, MissingExtensionError,
	EXTENSION_PACKAGE,
} from '../../lib/search/providers.js';
import { resolveModelName, embedderForModel, embedderOfIndex } from '../../lib/search/schema.js';

/** What Node throws when a bare specifier can't be found. */
function notFound(specifier) {
	const err = new Error(`Cannot find package '${specifier}' imported from /somewhere/providers.js`);
	err.code = 'ERR_MODULE_NOT_FOUND';
	return err;
}

let root;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'mnemonad-global-root-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A stand-in extension installed the way `npm install -g` lays it out: <root>/<name>/. */
async function installStub(source) {
	const dir = join(root, EXTENSION_PACKAGE);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'package.json'), JSON.stringify({ name: EXTENSION_PACKAGE, type: 'module', exports: './index.js' }));
	await writeFile(join(dir, 'index.js'), source);
}

describe('findTransformersExtension', () => {
	it('uses a plain import when the extension resolves from the CLI itself', async () => {
		const ext = { apiVersion: 1 };
		const found = await findTransformersExtension({
			importer: async (s) => { if (s === EXTENSION_PACKAGE) return ext; throw notFound(s); },
			globalRoots: () => { throw new Error('should not be asked'); },
		});
		expect(found).toBe(ext);
	});

	it('falls back to the global npm root when the plain import misses', async () => {
		await installStub('export const apiVersion = 1; export const marker = "from the global root";');
		const found = await findTransformersExtension({
			importer: async (s) => { if (s === EXTENSION_PACKAGE) throw notFound(s); return import(s); },
			globalRoots: () => [root],
		});
		expect(found.marker).toBe('from the global root');
	});

	it('finds it in pnpm 11\'s isolated per-package global folders, newest first', async () => {
		const { utimes } = await import('node:fs/promises');
		for (const [hash, marker, age] of [['old1', 'stale copy', 1000], ['new2', 'current copy', 0]]) {
			const dir = join(root, hash, 'node_modules', EXTENSION_PACKAGE);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, 'package.json'), JSON.stringify({ name: EXTENSION_PACKAGE, type: 'module', exports: './index.js' }));
			await writeFile(join(dir, 'index.js'), `export const apiVersion = 1; export const marker = ${JSON.stringify(marker)};`);
			const t = new Date(Date.now() - age * 1000);
			await utimes(join(dir, 'package.json'), t, t);
		}
		const found = await findTransformersExtension({
			importer: async (s) => { if (s === EXTENSION_PACKAGE) throw notFound(s); return import(s); },
			globalRoots: () => [root],
		});
		expect(found.marker).toBe('current copy');
	});

	it('is null when the extension is installed nowhere', async () => {
		expect(await findTransformersExtension({
			importer: async (s) => { throw notFound(s); },
			globalRoots: () => [root],
		})).toBe(null);
		expect(await findTransformersExtension({
			importer: async (s) => { throw notFound(s); },
			globalRoots: () => [],
		})).toBe(null);
	});

	it('surfaces a broken install (a dependency missing inside the extension) instead of calling it absent', async () => {
		await expect(findTransformersExtension({
			importer: async () => { throw notFound('@huggingface/transformers'); },
			globalRoots: () => [root],
		})).rejects.toThrow(/@huggingface\/transformers/);
	});
});

describe('loadTransformersExtension', () => {
	it('explains how to install it when missing', async () => {
		const err = await loadTransformersExtension('Xenova/all-MiniLM-L6-v2', {
			importer: async (s) => { throw notFound(s); },
			globalRoots: () => [],
		}).catch((e) => e);
		expect(err).toBeInstanceOf(MissingExtensionError);
		expect(err.model).toBe('Xenova/all-MiniLM-L6-v2');
		expect(err.message).toContain(`npm install -g ${EXTENSION_PACKAGE}`);
	});

	it('refuses an extension speaking a different API version', async () => {
		await expect(loadTransformersExtension('m', {
			importer: async () => ({ apiVersion: 99 }),
			globalRoots: () => [],
		})).rejects.toThrow(/API v99.*expects v1/);
	});

	it('hands transformers models to the extension, with the index\'s dtype', async () => {
		const calls = [];
		const provider = await createProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dtype: 'q8',
			extension: {
				importer: async () => ({ apiVersion: 1, createProvider: (opts) => { calls.push(opts); return { fake: true }; } }),
				globalRoots: () => [],
			},
		});
		expect(provider).toEqual({ fake: true });
		expect(calls[0]).toMatchObject({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' });
	});

	it('never looks for the extension for a static model', async () => {
		const provider = await createProvider({
			model: 'minishlab/potion-base-8M',
			extension: { importer: async () => { throw new Error('should not be asked'); } },
		});
		expect(provider.embedder).toBe('model2vec');
	});
});

describe('model names', () => {
	it('expands aliases and routes each model to its embedder', () => {
		expect(resolveModelName('potion')).toBe('minishlab/potion-base-8M');
		expect(resolveModelName('minilm')).toBe('Xenova/all-MiniLM-L6-v2');
		expect(resolveModelName('some/other-model')).toBe('some/other-model');
		expect(embedderForModel('minishlab/potion-base-8M')).toBe('model2vec');
		expect(embedderForModel('Xenova/all-MiniLM-L6-v2')).toBe('transformers');
	});

	it('reads an index built before `embedder` was recorded as transformers-built', () => {
		expect(embedderOfIndex({ model: 'Xenova/all-MiniLM-L6-v2' })).toBe('transformers');
		expect(embedderOfIndex({ model: 'minishlab/potion-base-8M', embedder: 'model2vec' })).toBe('model2vec');
		expect(embedderOfIndex({})).toBe('transformers');
	});
});
