import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { push } from '../lib/commands/push.js';
import { pull } from '../lib/commands/pull.js';
import { info } from '../lib/commands/info.js';
import { search } from '../lib/commands/search.js';
import { readManifest } from '../lib/commands/shared.js';
import { jobsRoot, waitForJob, listJobs, startPushJob, streamKey } from '../lib/jobs.js';
import {
	startNode, makeBaseArgs, makeTempDir, cleanupDir, writeTestFile, readTree, captureLogs,
} from './fixture.js';

let node;
let jobsDir;
let srcDir;
let destDir;

beforeAll(async () => {
	node = await startNode();
	// Every job this file starts lands here, not in the real ~/.cache. The detached children
	// inherit the variable, so their own queue checks look here too.
	jobsDir = await makeTempDir('mnemonad-cli-jobs-');
	process.env.MNEMONAD_JOBS_DIR = jobsDir;
}, 60_000);

afterAll(async () => {
	await node?.stop();
	delete process.env.MNEMONAD_JOBS_DIR;
	await cleanupDir(jobsDir);
});

beforeEach(async () => {
	srcDir = await makeTempDir('mnemonad-cli-detach-src-');
	destDir = await makeTempDir('mnemonad-cli-detach-dest-');
});

afterEach(async () => {
	await cleanupDir(srcDir);
	await cleanupDir(destDir);
});

// A real chain round-trip, plus a child process starting up.
const TEST_TIMEOUT = 90_000;

function createdId(lines) {
	return lines.find((l) => l.includes('created:')).split('created:')[1].trim();
}

function jobDirFrom(lines) {
	const id = lines.find((l) => l.includes('sending in the background: job')).split('job')[1].trim().split(' ')[0];
	return join(jobsRoot(), id);
}

/** A first, ordinary push, so --detach has an existing stream to push to. */
async function createStream(baseArgs) {
	await writeTestFile(srcDir, 'a.txt', 'version 1\n');
	const { lines } = await captureLogs(() => push({ ...baseArgs, path: srcDir, manifest: true }));
	return createdId(lines);
}

describe('push --detach', () => {
	it('returns once the version is prepared, and the background job sends it', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		await writeTestFile(srcDir, 'a.txt', 'version 2, edited\n');
		await writeTestFile(srcDir, 'b.txt', 'a new file\n');
		const { lines } = await captureLogs(() => push({ ...baseArgs, path: srcDir, manifest: true, detach: true }));

		expect(lines.some((l) => l.includes('version 2 prepared (diff'))).toBe(true);
		expect(lines.some((l) => l.includes('pushed'))).toBe(false);

		const job = await waitForJob(jobDirFrom(lines));
		expect(job.status).toBe('done');
		expect(job.version).toBe(2);

		await pull({ ...baseArgs, streamId, path: destDir });
		const tree = await readTree(destDir);
		expect(tree['a.txt'].toString()).toBe('version 2, edited\n');
		expect(tree['b.txt'].toString()).toBe('a new file\n');

		// The child wrote the manifest a foreground `push --manifest` would have.
		const manifest = await readManifest(srcDir);
		expect(manifest.version).toBe(2);
		expect(Object.keys(manifest.files).sort()).toEqual(['a.txt', 'b.txt']);
	}, TEST_TIMEOUT);

	it('sends the folder as it was when the command ran, not as it is later', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		await writeTestFile(srcDir, 'a.txt', 'what --detach saw\n');
		const { lines } = await captureLogs(() => push({ ...baseArgs, streamId, path: srcDir, detach: true }));
		await writeTestFile(srcDir, 'a.txt', 'edited after the command returned\n');

		await waitForJob(jobDirFrom(lines));
		await pull({ ...baseArgs, streamId, path: destDir });
		expect((await readTree(destDir))['a.txt'].toString()).toBe('what --detach saw\n');
	}, TEST_TIMEOUT);

	it('refuses to create a stream — it needs an existing one', async () => {
		const baseArgs = await makeBaseArgs();
		await writeTestFile(srcDir, 'a.txt', 'hello\n');
		await expect(push({ ...baseArgs, path: srcDir, detach: true }))
			.rejects.toThrow(/--detach only pushes to an existing stream/);
	}, TEST_TIMEOUT);

	it('makes the next push wait for it, and build on top of it', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		await writeTestFile(srcDir, 'b.txt', 'from the detached push\n');
		const { lines } = await captureLogs(() => push({ ...baseArgs, path: srcDir, manifest: true, detach: true }));
		const jobDir = jobDirFrom(lines);

		await writeTestFile(srcDir, 'c.txt', 'from the push after it\n');
		const { lines: next } = await captureLogs(() => push({ ...baseArgs, path: srcDir, manifest: true }));

		expect((await waitForJob(jobDir)).status).toBe('done');
		expect(next.some((l) => l.includes('version 3 pushed'))).toBe(true);

		await pull({ ...baseArgs, streamId, path: destDir });
		expect(Object.keys(await readTree(destDir)).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
	}, TEST_TIMEOUT);

	it('makes a pull wait for it, so the pull includes the new version', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		await writeTestFile(srcDir, 'b.txt', 'still sending\n');
		const { lines } = await captureLogs(() => push({ ...baseArgs, streamId, path: srcDir, detach: true }));

		await captureLogs(() => pull({ ...baseArgs, streamId, path: destDir }));
		expect((await waitForJob(jobDirFrom(lines))).status).toBe('done');
		expect((await readTree(destDir))['b.txt'].toString()).toBe('still sending\n');
	}, TEST_TIMEOUT);

	it('never writes the key into the job folder, the log, or the child\'s arguments', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		await writeTestFile(srcDir, 'a.txt', 'version 2\n');
		const { lines } = await captureLogs(() => push({ ...baseArgs, streamId, path: srcDir, detach: true }));
		const jobDir = jobDirFrom(lines);
		await waitForJob(jobDir);

		const keyHex = baseArgs.key.replace(/^0x/, '');
		const jobJson = readFileSync(join(jobDir, 'job.json'), 'utf8');
		expect(jobJson).not.toContain(keyHex);
		expect(readFileSync(join(jobDir, 'push.log'), 'utf8')).not.toContain(keyHex);
		expect(JSON.parse(jobJson).args).not.toHaveProperty('key');
	}, TEST_TIMEOUT);
});

describe('push --detach --index', () => {
	it('indexes, builds and sends in the background, and returns before any of it', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		await writeTestFile(srcDir, 'finance.txt', 'The stock market and economy saw major inflation this year.\n');
		await writeTestFile(srcDir, 'animals.txt', 'Foxes and dogs are common household pets and animals.\n');
		const { lines } = await captureLogs(() =>
			push({ ...baseArgs, path: srcDir, manifest: true, detach: true, index: true })
		);
		expect(lines.some((l) => l.includes('indexing, building and sending in the background'))).toBe(true);
		expect(lines.some((l) => l.includes('prepared'))).toBe(false);

		const job = await waitForJob(jobDirFrom(lines));
		expect(job.status).toBe('done');
		expect(job.version).toBe(2);
		expect((await readManifest(srcDir)).version).toBe(2);

		await pull({ ...baseArgs, streamId, path: destDir });
		const { lines: hits } = await captureLogs(() =>
			search({ ...baseArgs, path: destDir, query: 'money and the economy', limit: 1 })
		);
		expect(hits.find((l) => /^\n1\. /.test(l))).toContain('finance.txt');
	}, TEST_TIMEOUT);

	it('finishes as "no changes" when the folder already matches the latest version', async () => {
		const baseArgs = await makeBaseArgs();
		await writeTestFile(srcDir, 'a.txt', 'indexed and pushed once\n');
		const { lines: created } = await captureLogs(() => push({ ...baseArgs, path: srcDir, index: true }));
		const streamId = createdId(created);

		const { lines } = await captureLogs(() => push({ ...baseArgs, streamId, path: srcDir, detach: true, index: true }));
		const job = await waitForJob(jobDirFrom(lines));
		expect(job.status).toBe('done');
		expect(job.noChanges).toBe(true);

		const { lines: infoLines } = await captureLogs(() => info({ ...baseArgs, streamId, path: srcDir }));
		expect(infoLines.some((l) => l.includes('background push: no changes, nothing pushed'))).toBe(true);
	}, TEST_TIMEOUT);

	it('reports an indexing failure in the job, having pushed nothing', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		await writeTestFile(srcDir, 'a.txt', 'version 2\n');
		// Overlap ≥ size is rejected by the chunker before any file is read.
		const { lines } = await captureLogs(() =>
			push({ ...baseArgs, streamId, path: srcDir, detach: true, index: true, chunkSize: 100, chunkOverlap: 100 })
		);
		const job = await waitForJob(jobDirFrom(lines));
		expect(job.status).toBe('failed');
		expect(job.error).toMatch(/indexing failed, so nothing was pushed/);

		const { lines: infoLines } = await captureLogs(() => info({ ...baseArgs, streamId, path: destDir }));
		expect(infoLines.some((l) => l.includes('versions:') && l.trim().endsWith('1'))).toBe(true);
	}, TEST_TIMEOUT);
});

describe('failed background pushes', () => {
	it('fail without writing when the stream moved past the patch\'s base, and say so once', async () => {
		const baseArgs = await makeBaseArgs();
		const streamId = await createStream(baseArgs);

		// A job built against version 0 of a stream that already has 1.
		const job = await startPushJob(
			{
				streamId,
				streamKey: streamKey({ chain: baseArgs.chain, contractAddress: baseArgs.contractAddress, streamId }),
				chain: baseArgs.chain,
				signer: baseArgs.accountAddress,
				folder: srcDir,
				baseLength: 0,
				version: 1,
				kind: 'patch',
				bytes: 3,
				manifest: null,
				args: { chain: baseArgs.chain, rpcUrl: baseArgs.rpcUrl, contractAddress: baseArgs.contractAddress, gatewayUrl: null, presignUrl: null },
			},
			new Uint8Array([1, 2, 3]),
			{ key: baseArgs.key },
		);
		const settled = await waitForJob(job.dir);
		expect(settled.status).toBe('failed');
		expect(settled.error).toMatch(/the stream changed after this push was prepared/);

		const { lines: infoLines } = await captureLogs(() => info({ ...baseArgs, streamId, path: srcDir }));
		expect(infoLines.some((l) => l.includes('background push:') && l.includes('FAILED'))).toBe(true);

		await writeTestFile(srcDir, 'a.txt', 'version 2\n');
		const { lines: first } = await captureLogs(() => push({ ...baseArgs, streamId, path: srcDir }));
		expect(first.some((l) => l.includes(`background push ${job.id}`) && l.includes('failed'))).toBe(true);
		expect(first.some((l) => l.includes('version 2 pushed'))).toBe(true);

		await writeTestFile(srcDir, 'a.txt', 'version 3\n');
		const { lines: second } = await captureLogs(() => push({ ...baseArgs, streamId, path: srcDir }));
		expect(second.some((l) => l.includes(`background push ${job.id}`))).toBe(false);
	}, TEST_TIMEOUT);

	it('are reported as failed when the background process died mid-send', async () => {
		// A pid that certainly existed and certainly doesn't any more.
		const pid = await new Promise((resolve) => {
			const child = spawn(process.execPath, ['-e', '']);
			child.on('exit', () => resolve(child.pid));
		});
		const dir = join(jobsRoot(), 'deadbeef');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'job.json'), JSON.stringify({
			id: 'deadbeef',
			status: 'sending',
			pid,
			createdAt: new Date().toISOString(),
			streamKey: 'local|0x0|0x0',
			chain: 'local',
			signer: '0x0',
			version: 9,
		}));

		const job = listJobs().find((j) => j.id === 'deadbeef');
		expect(job.status).toBe('failed');
		expect(job.error).toMatch(/exited before finishing/);
	}, TEST_TIMEOUT);
});
