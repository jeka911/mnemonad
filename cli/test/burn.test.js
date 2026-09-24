import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import Mnemonad from 'mnemonad';
import { push } from '../lib/commands/push.js';
import { burn } from '../lib/commands/burn.js';
import { makeChainClient } from '../lib/chainClient.js';
import { startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, captureLogs } from './fixture.js';
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
	srcDir = await makeTempDir('mnemonad-cli-burn-src-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
});

const TX_TIMEOUT = 60_000;

async function pushFolder(baseArgs, dir) {
	const { lines } = await captureLogs(() => push({ ...baseArgs, path: dir }));
	return lines.find((l) => l.includes('created:')).split('created:')[1].trim();
}

describe('burn', () => {
	it('requires stream-id', async () => {
		const baseArgs = await makeBaseArgs();
		await expect(burn({ ...baseArgs, streamId: null })).rejects.toThrow(/stream-id is required/);
	});

	it('refuses without --yes, but still reports what would be destroyed', async () => {
		await writeTestFile(srcDir, 'a.txt', 'mine\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const { lines } = await captureLogs(async () => {
			await expect(burn({ ...baseArgs, streamId, yes: false })).rejects.toThrow(/permanently destroys/);
		});
		expect(lines.some((l) => l.includes('versions:') )).toBe(true);
		expect(lines.some((l) => l.includes('binary size:'))).toBe(true);
	}, TX_TIMEOUT);

	it('refuses to burn a stream owned by someone else', async () => {
		await writeTestFile(srcDir, 'a.txt', 'mine\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const intruder = { ...baseArgs, streamId, key: DEV_KEYS[1], yes: true };
		await expect(burn(intruder)).rejects.toThrow(/owned by/);
	}, TX_TIMEOUT);

	it('destroys the stream when run with --yes — it is no longer readable afterward', async () => {
		await writeTestFile(srcDir, 'a.txt', 'gone soon\n');
		const baseArgs = await makeBaseArgs();
		const streamId = await pushFolder(baseArgs, srcDir);

		const { lines } = await captureLogs(() => burn({ ...baseArgs, streamId, yes: true }));
		expect(lines.some((l) => l.includes('is burned'))).toBe(true);

		// A burned id stays permanently gone — the contract's own `_requireExists` rejects
		// every read on it, same as an id that was never created.
		const client = makeChainClient(baseArgs);
		const reader = new Mnemonad({
			publicClient: client.publicClient,
			contractAddress: client.contractAddress,
			id: streamId,
		});
		await expect(reader.initialize()).rejects.toThrow();
	}, TX_TIMEOUT);
});
