import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { push } from '../lib/commands/push.js';
import {
	startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, readTestFile, captureLogs,
} from './fixture.js';
import { DEV_KEYS } from '../../js/test/fixture.js';

let node;
let srcDir;

beforeAll(async () => {
	node = await startNode();
}, 60_000);

afterAll(async () => {
	await node?.stop();
});

beforeEach(async () => {
	srcDir = await makeTempDir();
});

afterEach(async () => {
	await cleanupDir(srcDir);
});

const TX_TIMEOUT = 60_000;

describe('push', () => {
	it('refuses to run without an explicit path — never falls back to cwd', async () => {
		const args = { ...(await makeBaseArgs()), path: null };
		await expect(push(args)).rejects.toThrow(/folder path is required/);
	}, TX_TIMEOUT);

	it('creates a new stream from a folder and prints its id as 0x + 64 hex digits', async () => {
		await writeTestFile(srcDir, 'readme.md', 'hello world\n');
		await writeTestFile(srcDir, 'src/index.js', 'console.log(1);\n');

		const args = { ...(await makeBaseArgs()), path: srcDir };
		const { lines } = await captureLogs(() => push(args));

		const createdLine = lines.find((l) => l.includes('created:'));
		expect(createdLine).toBeTruthy();
		const streamId = createdLine.split('created:')[1].trim();
		expect(/^0x[0-9a-f]{64}$/.test(streamId)).toBe(true);
	}, TX_TIMEOUT);

	it('accepts a decimal id where a hex one was printed — both forms name the same stream', async () => {
		await writeTestFile(srcDir, 'a.txt', 'version 1\n');
		const baseArgs = await makeBaseArgs();

		const first = { ...baseArgs, path: srcDir };
		const { lines: firstLines } = await captureLogs(() => push(first));
		const hexId = firstLines.find((l) => l.includes('created:')).split('created:')[1].trim();
		const decimalId = BigInt(hexId).toString(10);

		await writeTestFile(srcDir, 'a.txt', 'version 2, now longer\n');
		const second = { ...baseArgs, path: srcDir, streamId: decimalId };
		const { lines: secondLines } = await captureLogs(() => push(second));

		expect(secondLines.some((l) => l.includes('version 2 pushed'))).toBe(true);
		// The confirmation line still prints hex regardless of which form was passed in.
		expect(secondLines.some((l) => l.includes('stream:') && l.includes(hexId))).toBe(true);
	}, TX_TIMEOUT);

	it('pushes a diff on the second push to an existing stream', async () => {
		await writeTestFile(srcDir, 'a.txt', 'version 1\n');
		const baseArgs = await makeBaseArgs();

		const first = { ...baseArgs, path: srcDir };
		const { lines: firstLines } = await captureLogs(() => push(first));
		const streamId = firstLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		await writeTestFile(srcDir, 'a.txt', 'version 2, now longer\n');
		const second = { ...baseArgs, path: srcDir, streamId };
		const { lines: secondLines } = await captureLogs(() => push(second));

		expect(secondLines.some((l) => l.includes('version 2 pushed'))).toBe(true);
	}, TX_TIMEOUT);

	it('skips pushing when nothing changed since the last push (tree-hash comparison)', async () => {
		await writeTestFile(srcDir, 'a.txt', 'unchanged\n');
		const baseArgs = await makeBaseArgs();

		const first = { ...baseArgs, path: srcDir };
		const { lines: firstLines } = await captureLogs(() => push(first));
		const streamId = firstLines.find((l) => l.includes('created:')).split('created:')[1].trim();

		const second = { ...baseArgs, path: srcDir, streamId };
		const { lines: secondLines } = await captureLogs(() => push(second));

		expect(secondLines.some((l) => l.includes('no changes, nothing to push'))).toBe(true);
	}, TX_TIMEOUT);

	it('skips pushing when the manifest says nothing changed since the last pull/push', async () => {
		await writeTestFile(srcDir, 'a.txt', 'content\n');
		const baseArgs = await makeBaseArgs();

		const first = { ...baseArgs, path: srcDir, manifest: true };
		await captureLogs(() => push(first));
		const manifestRaw = await readTestFile(srcDir, '.mnemonad');
		const { streamId } = JSON.parse(manifestRaw.toString('utf8'));

		const second = { ...baseArgs, path: srcDir, streamId, manifest: true };
		const { lines } = await captureLogs(() => push(second));
		expect(lines.some((l) => l.includes('no changes since last pull, nothing to push'))).toBe(true);
	}, TX_TIMEOUT);

	it('refuses to push to a stream owned by someone else', async () => {
		await writeTestFile(srcDir, 'a.txt', 'mine\n');
		const baseArgs = await makeBaseArgs();

		const first = { ...baseArgs, path: srcDir };
		const { lines } = await captureLogs(() => push(first));
		const streamId = lines.find((l) => l.includes('created:')).split('created:')[1].trim();

		await writeTestFile(srcDir, 'a.txt', 'trying to overwrite\n');
		const intruder = { ...baseArgs, path: srcDir, streamId, key: DEV_KEYS[1] };

		await expect(push(intruder)).rejects.toThrow(/owned by/);
	}, TX_TIMEOUT);

	it('creates a password-encrypted stream', async () => {
		await writeTestFile(srcDir, 'secret.txt', 'shh\n');
		const args = { ...(await makeBaseArgs()), path: srcDir, encrypt: true, password: 'correct horse battery staple' };
		const { lines } = await captureLogs(() => push(args));
		expect(lines.some((l) => l.includes('(encrypted with a password)'))).toBe(true);
	}, TX_TIMEOUT);

	it('creates a wallet-encrypted stream keyed to the signing account', async () => {
		await writeTestFile(srcDir, 'secret.txt', 'shh\n');
		const base = await makeBaseArgs();
		const args = { ...base, path: srcDir, encrypt: true, encryptWith: 'wallet' };
		const { lines } = await captureLogs(() => push(args));

		expect(lines.some((l) => l.includes('encrypted to ' + base.accountAddress))).toBe(true);
	}, TX_TIMEOUT);

	it('refuses --encrypt without a method, and refuses both methods at once', async () => {
		await writeTestFile(srcDir, 'a.txt', 'x\n');
		const base = await makeBaseArgs();

		// Which method to use is never guessed: both are reachable from the same invocation.
		await expect(push({ ...base, path: srcDir, encrypt: true })).rejects.toThrow(/needs a method/);
		await expect(
			push({ ...base, path: srcDir, encrypt: true, encryptWith: 'wallet', password: 'pw' })
		).rejects.toThrow(/takes no --password/);
		await expect(
			push({ ...base, path: srcDir, encrypt: true, encryptWith: 'nonsense' })
		).rejects.toThrow(/expected password or wallet/);
	}, TX_TIMEOUT);
});
