import { describe, it, expect } from 'vitest';
import { resolvePath } from '../lib/commands/shared.js';

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
