import { describe, it, expect } from 'vitest';
import { resolvePath, formatStreamId, streamIdsEqual } from '../lib/commands/shared.js';

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
