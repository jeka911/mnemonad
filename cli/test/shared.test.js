import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePath, formatStreamId, streamIdsEqual, discoverStreamId, writeManifest, parseQualifiedStreamId, resolveEncryptMethod, unlockStream } from '../lib/commands/shared.js';

describe('resolvePath', () => {
	it('throws a friendly, actionable error instead of falling back to cwd when path is missing', () => {
		expect(() => resolvePath(null)).toThrow(/folder path is required/);
		expect(() => resolvePath(undefined)).toThrow(/folder path is required/);
		expect(() => resolvePath('')).toThrow(/folder path is required/);
	});

	it('marks the error as a user error (message-only, no stack trace at the CLI boundary)', () => {
		try {
			resolvePath(null);
			expect.unreachable();
		} catch (err) {
			expect(err._isUserError).toBe(true);
		}
	});

	it('still resolves a real path normally', () => {
		expect(resolvePath('/tmp/some-folder')).toBe('/tmp/some-folder');
	});

	it('still expands a leading ~ to the home directory', async () => {
		const { homedir } = await import('node:os');
		expect(resolvePath('~/some-folder')).toBe(`${homedir()}/some-folder`);
	});
});

describe('resolvePath({ mustExist: true })', () => {
	it('accepts a folder that exists', async () => {
		const { mkdtemp, rm } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const dir = await mkdtemp(join(tmpdir(), 'mnemonad-resolve-'));
		try {
			expect(resolvePath(dir, { mustExist: true })).toBe(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('rejects a folder that does not exist, instead of a raw ENOENT from readdir', () => {
		expect(() => resolvePath('/tmp/mnemonad-definitely-not-here-9f3a', { mustExist: true }))
			.toThrow(/no such folder/);
	});

	it('points at pull as the way to create one', () => {
		expect(() => resolvePath('/tmp/mnemonad-definitely-not-here-9f3a', { mustExist: true }))
			.toThrow(/mnemonad pull/);
	});

	it('marks a missing folder as a user error (message only, no stack trace)', () => {
		try {
			resolvePath('/tmp/mnemonad-definitely-not-here-9f3a', { mustExist: true });
			expect.unreachable();
		} catch (err) {
			expect(err._isUserError).toBe(true);
		}
	});

	it('rejects a path that exists but is a file, not a folder', async () => {
		const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const dir = await mkdtemp(join(tmpdir(), 'mnemonad-resolve-'));
		const file = join(dir, 'a.txt');
		await writeFile(file, 'x');
		try {
			expect(() => resolvePath(file, { mustExist: true })).toThrow(/not a folder/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('still refuses a missing path argument before it ever checks the disk', () => {
		expect(() => resolvePath(null, { mustExist: true })).toThrow(/folder path is required/);
	});

	it('leaves the default (pull) tolerant of a not-yet-created folder', () => {
		expect(resolvePath('/tmp/mnemonad-definitely-not-here-9f3a'))
			.toBe('/tmp/mnemonad-definitely-not-here-9f3a');
	});
});

describe('formatStreamId', () => {
	it('renders a decimal id as 0x + 64 zero-padded lowercase hex digits', () => {
		expect(formatStreamId('123')).toBe(`0x${'0'.repeat(62)}7b`);
	});

	it('accepts a bigint directly (mn.id\'s own type)', () => {
		expect(formatStreamId(123n)).toBe(`0x${'0'.repeat(62)}7b`);
	});

	it('accepts an already-hex id and re-pads/lowercases it rather than passing it through', () => {
		expect(formatStreamId('0x7B')).toBe(`0x${'0'.repeat(62)}7b`);
		expect(formatStreamId('0x7b')).toBe(`0x${'0'.repeat(62)}7b`);
	});

	it('round-trips a real 32-byte id unchanged (already full-length, just lowercased)', () => {
		const id = '45484115941227250607382990641581457040221840181861794550002146954186597022408';
		expect(formatStreamId(id)).toBe('0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8');
	});

	it('rejects a malformed id the same way BigInt() does, instead of silently misparsing it', () => {
		expect(() => formatStreamId('not-an-id')).toThrow();
	});
});

describe('streamIdsEqual', () => {
	it('treats a decimal id and its hex form as the same stream', () => {
		expect(streamIdsEqual('123', '0x7b')).toBe(true);
		expect(streamIdsEqual('123', '0x7B')).toBe(true);
	});

	it('treats differently-padded hex as the same stream', () => {
		expect(streamIdsEqual('0x7b', `0x${'0'.repeat(62)}7b`)).toBe(true);
	});

	it('still tells genuinely different ids apart', () => {
		expect(streamIdsEqual('123', '124')).toBe(false);
	});

	it('is the guard push.js\'s manifest check needs: a bare string compare would wrongly call these different', () => {
		expect('123' === '0x7b').toBe(false); // the bug this function exists to avoid
		expect(streamIdsEqual('123', '0x7b')).toBe(true); // the fix
	});
});

describe('discoverStreamId', () => {
	async function withTempDir(fn) {
		const dir = await mkdtemp(join(tmpdir(), 'mnemonad-discover-'));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it('leaves an already-given id alone, without touching the manifest at all', async () => {
		const args = { streamId: '123', manifest: true };
		const id = await discoverStreamId(args, '/does/not/exist');
		expect(id).toBe('123');
		expect(args.streamId).toBe('123');
	});

	it('uses a manifest without --manifest, and turns manifest writing on for the run', async () => {
		await withTempDir(async (dir) => {
			await writeManifest(dir, { streamId: formatStreamId('123'), version: 1, files: {} });
			const args = { streamId: null, manifest: false };
			expect(await discoverStreamId(args, dir)).toBe(formatStreamId('123'));
			expect(args.streamId).toBe(formatStreamId('123'));
			expect(args.manifest).toBe(true);
		});
	});

	it('leaves an explicitly given id alone, manifest or not', async () => {
		await withTempDir(async (dir) => {
			await writeManifest(dir, { streamId: formatStreamId('123'), version: 1, files: {} });
			const args = { streamId: '456', manifest: false };
			expect(await discoverStreamId(args, dir)).toBe('456');
			expect(args.manifest).toBe(false);
		});
	});

	it('stays null when --manifest is set but no .mnemonad exists yet (first push/pull)', async () => {
		await withTempDir(async (dir) => {
			const args = { streamId: null, manifest: true };
			expect(await discoverStreamId(args, dir)).toBe(null);
			expect(args.streamId).toBe(null);
		});
	});

	it('recovers and sets the id from .mnemonad when --manifest is set and no id was given', async () => {
		await withTempDir(async (dir) => {
			await writeManifest(dir, { streamId: formatStreamId('123'), version: 2, files: {} });
			const args = { streamId: null, manifest: true };
			const id = await discoverStreamId(args, dir);
			expect(id).toBe(formatStreamId('123'));
			expect(args.streamId).toBe(formatStreamId('123'));
		});
	});
});

describe('parseQualifiedStreamId', () => {
	it('splits a network-qualified hex id, same shape the explorer\'s URLs use', () => {
		expect(parseQualifiedStreamId('testnet-0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8'))
			.toEqual({ network: 'testnet', id: '0x648f18ea13eaa4640b97a435a30d39d4f7af9c2105adb10217f8a8ae56e73ac8' });
		expect(parseQualifiedStreamId('mainnet-0x7b')).toEqual({ network: 'mainnet', id: '0x7b' });
	});

	it('accepts a qualified decimal id too', () => {
		expect(parseQualifiedStreamId('testnet-123')).toEqual({ network: 'testnet', id: '123' });
	});

	it('lowercases the network prefix', () => {
		expect(parseQualifiedStreamId('Testnet-0x7b')).toEqual({ network: 'testnet', id: '0x7b' });
		expect(parseQualifiedStreamId('MAINNET-0x7b')).toEqual({ network: 'mainnet', id: '0x7b' });
	});

	it('returns null for an unqualified id — the plain forms parse elsewhere', () => {
		expect(parseQualifiedStreamId('0x7b')).toBe(null);
		expect(parseQualifiedStreamId('123')).toBe(null);
	});

	it('returns null for an unknown network prefix rather than guessing', () => {
		expect(parseQualifiedStreamId('unknown-0x7b')).toBe(null);
		expect(parseQualifiedStreamId('local-0x7b')).toBe(null); // real --chain value, but never a URL prefix
	});

	it('returns null for a malformed id after a valid-looking network prefix', () => {
		expect(parseQualifiedStreamId('testnet-not-an-id')).toBe(null);
		expect(parseQualifiedStreamId('testnet-')).toBe(null);
	});

	it('returns null for non-string input', () => {
		expect(parseQualifiedStreamId(null)).toBe(null);
		expect(parseQualifiedStreamId(undefined)).toBe(null);
		expect(parseQualifiedStreamId(123)).toBe(null);
	});
});

describe('passkey-encrypted streams', () => {
	/** Just enough of a Mnemonad for unlockStream to read the method off. */
	function passkeyStream(kek = { method: 'passkey', rpId: 'mnemonad.vercel.app', credentialId: 'abc' }) {
		return {
			initialize: async () => {},
			isEncrypted: async () => true,
			streamMeta: { kek },
			unlockWithSignature: async () => { throw new Error('must not be tried'); },
			unlockWithPassword: async () => { throw new Error('must not be tried'); },
		};
	}

	it('refuses to create one from the CLI, pointing at the explorer', () => {
		expect(() => resolveEncryptMethod({ encrypt: true, encryptWith: 'passkey' })).toThrow(/explorer/);
	});

	it('stops with a clear message instead of trying the wallet key', async () => {
		const err = await unlockStream(passkeyStream(), { signer: {}, password: null }).catch((e) => e);
		expect(err.message).toMatch(/encrypted with a passkey/);
		expect(err.message).toContain('https://mnemonad.vercel.app');
	});

	it('still says something useful when the stream names no site', async () => {
		const err = await unlockStream(passkeyStream({ method: 'passkey' }), {}).catch((e) => e);
		expect(err.message).toMatch(/Open it in the explorer and unlock it/);
	});
});

