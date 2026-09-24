import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { push } from '../lib/commands/push.js';
import { pull } from '../lib/commands/pull.js';
import {
	startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, readTree, captureLogs,
} from './fixture.js';
import { DEV_KEYS } from '../../js/test/fixture.js';

let node;
let srcDir;
let destDir;

beforeAll(async () => {
	node = await startNode();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

beforeEach(async () => {
	srcDir = await makeTempDir('mnemonad-cli-src-');
	destDir = await makeTempDir('mnemonad-cli-dest-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
	await cleanupDir(destDir);
});

const TX_TIMEOUT = 60_000;

async function pushFolder(baseArgs, dir) {
	const { lines } = await captureLogs(() => push({ ...baseArgs, path: dir }));
	return lines.find((l) => l.includes('created:')).split('created:')[1].trim();
}

describe('pull', () => {
	it('restores a pushed folder byte-for-byte into a fresh directory', async () => {
		await writeTestFile(srcDir, 'readme.md', 'hello world\n');
		await writeTestFile(srcDir, 'nested/deep/file.bin', Buffer.from([1, 2, 3, 4, 5]));

		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		await pull({ ...baseArgs, streamId, path: destDir });

		const srcTree = await readTree(srcDir);
		const destTree = await readTree(destDir);
		expect(Object.keys(destTree).sort()).toEqual(Object.keys(srcTree).sort());
		for (const relPath of Object.keys(srcTree)) {
			expect(destTree[relPath].equals(srcTree[relPath])).toBe(true);
		}
	}, TX_TIMEOUT);

	it('restores into a destination directory that does not exist yet', async () => {
		// makeTempDir() (used for destDir elsewhere) already creates the directory itself —
		// this exercises the real first-ever-pull case, where nothing has mkdir'd the
		// destination and a root-level file would otherwise have nowhere to be written.
		await writeTestFile(srcDir, 'readme.md', 'brand new destination\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const freshDest = `${destDir}/not-created-yet`;
		await pull({ ...baseArgs, streamId, path: freshDest });

		const destTree = await readTree(freshDest);
		expect(destTree['readme.md'].toString('utf8')).toBe('brand new destination\n');
	}, TX_TIMEOUT);

	it('deletes local files that no longer exist in the pulled version', async () => {
		await writeTestFile(srcDir, 'keep.txt', 'stays\n');
		await writeTestFile(srcDir, 'gone.txt', 'will be deleted\n');

		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);
		await pull({ ...baseArgs, streamId, path: destDir });
		expect(Object.keys(await readTree(destDir)).sort()).toEqual(['gone.txt', 'keep.txt']);

		await import('node:fs/promises').then((fs) => fs.rm(`${srcDir}/gone.txt`));
		await push({ ...baseArgs, path: srcDir, streamId });

		await pull({ ...baseArgs, streamId, path: destDir });
		expect(Object.keys(await readTree(destDir)).sort()).toEqual(['keep.txt']);
	}, TX_TIMEOUT);

	it('round-trips a wallet-encrypted stream with the owner\'s key, and refuses another', async () => {
		await writeTestFile(srcDir, 'secret.txt', 'classified\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder({ ...baseArgs, encrypt: true, encryptWith: 'wallet' }, srcDir);

		// A different key derives a different key-encryption key, so the wrapped key's GCM
		// tag fails — the SDK reports that as a typed KEK_MISMATCH rather than a raw tag error.
		await expect(
			pull({ ...baseArgs, streamId, path: destDir, key: DEV_KEYS[1] })
		).rejects.toThrow(/does not match|KEK_MISMATCH/);

		// With no key at all there is nothing to sign with, and the error should say so
		// rather than asking for a password the stream doesn't use.
		await expect(
			pull({ ...baseArgs, streamId, path: destDir, key: null, phrase: null })
		).rejects.toThrow(/owner's wallet/);

		await pull({ ...baseArgs, streamId, path: destDir });
		const destTree = await readTree(destDir);
		expect(destTree['secret.txt'].toString('utf8')).toBe('classified\n');
	}, TX_TIMEOUT);

	it('requires --password for an encrypted stream and succeeds once given', async () => {
		await writeTestFile(srcDir, 'secret.txt', 'classified\n');
		const baseArgs = await makeBaseArgs();
		const password = 'correct horse battery staple';
		const streamId = await pushFolder({ ...baseArgs, encrypt: true, password }, srcDir);

		await expect(pull({ ...baseArgs, streamId, path: destDir })).rejects.toThrow(/encrypted/);

		await pull({ ...baseArgs, streamId, path: destDir, password });
		const destTree = await readTree(destDir);
		expect(destTree['secret.txt'].toString('utf8')).toBe('classified\n');
	}, TX_TIMEOUT);

	it('throws when no stream-id is given', async () => {
		const baseArgs = await makeBaseArgs();
		await expect(pull({ ...baseArgs, streamId: null, path: destDir })).rejects.toThrow(/stream-id is required/);
	});

	it('discovers the stream id from .mnemonad when --manifest is set and no id is given', async () => {
		await writeTestFile(srcDir, 'readme.md', 'from manifest\n');
		const baseArgs = await makeBaseArgs();
		// --manifest writes .mnemonad into srcDir itself, recording the id that push created.
		await push({ ...baseArgs, path: srcDir, manifest: true });

		// A missing id, resolved purely from srcDir's own manifest — pulling back into the
		// same folder is a no-op sync, but it proves the id never had to be typed again.
		const { lines } = await captureLogs(() =>
			pull({ ...baseArgs, streamId: null, path: srcDir, manifest: true })
		);
		expect(lines.some((l) => l.includes('using stream id from .mnemonad manifest'))).toBe(true);

		const destTree = await readTree(srcDir);
		expect(destTree['readme.md'].toString('utf8')).toBe('from manifest\n');
	}, TX_TIMEOUT);

	it('still requires an explicit id when --manifest is not set, even with a manifest on disk', async () => {
		await writeTestFile(srcDir, 'readme.md', 'from manifest\n');
		const baseArgs = await makeBaseArgs();
		await push({ ...baseArgs, path: srcDir, manifest: true });

		await expect(
			pull({ ...baseArgs, streamId: null, path: srcDir, manifest: false })
		).rejects.toThrow(/stream-id is required/);
	}, TX_TIMEOUT);
});
