/**
 * Background push jobs — what `mnemonad push --detach` leaves behind.
 *
 * A detached push builds its patch in the foreground (every check that can fail for the
 * user's own reasons runs there: ownership, unlocking, indexing, "nothing to push", the
 * balance), then hands only the sending to a detached child process and exits. Each job is a
 * folder under `~/.cache/mnemonad/jobs/<id>/`:
 *
 *   job.json   — what to send where, and the job's status (see JOB_STATUS)
 *   patch.bin  — the prepared patch, frozen when the command ran; deleted once sent
 *   push.log   — the child's own output
 *
 * Secrets (a key, a phrase, a password, a Pinata JWT) never touch this folder or the child's
 * argv: the parent writes them to the child's stdin and closes it.
 *
 * Correctness never depends on the locking below. The child refuses to send a patch whose
 * base version is gone (`MonadSync.commitPush`), and the contract rejects any write that
 * doesn't land at the index it names. The waiting here only keeps the next command from
 * racing a job it would lose to anyway — or, for a pull, from overwriting the folder with the
 * version before the one still being sent.
 */
import { spawn } from 'node:child_process';
import { openSync, closeSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Mnemonad from 'mnemonad';
import { MonadSync } from 'monadsync';
import { makeChainClient, requireWalletClient } from './chainClient.js';
import { FSFolder } from './FSFolder.js';
import {
    formatStreamId,
    formatPath,
    unlockStream,
    assertStreamOwner,
    resolveOffloadParams,
    writeManifest,
    makeExcludes,
    hashLocalTree,
    localTreeHash,
    userError,
} from './commands/shared.js';
import { updateIndex } from './commands/buildIndex.js';

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mnemonad.js');

/** pending: written, child not started yet · waiting: queued behind an earlier job from the
 *  same signer · preparing: indexing and building the patch (`push --detach --index` only) ·
 *  sending: transactions in flight · done / failed: finished. */
export const JOB_STATUS = {
    PENDING: 'pending', WAITING: 'waiting', PREPARING: 'preparing', SENDING: 'sending', DONE: 'done', FAILED: 'failed',
};

const ACTIVE = new Set([JOB_STATUS.PENDING, JOB_STATUS.WAITING, JOB_STATUS.PREPARING, JOB_STATUS.SENDING]);

/** "version 8", or what a job that hasn't built its version yet is doing instead. */
function versionLabel(job) {
    return job.version != null ? `version ${job.version}` : 'the next version';
}

/** A job still `pending` with no pid after this long never got its child started. */
const SPAWN_GRACE_MS = 60_000;

/** Finished jobs older than this are removed the next time a job is created. */
const KEEP_FINISHED_MS = 14 * 24 * 60 * 60 * 1000;

const POLL_MS = 1000;

/** `MNEMONAD_JOBS_DIR` overrides the location (the tests use a temp dir). */
export function jobsRoot() {
    return process.env.MNEMONAD_JOBS_DIR || join(homedir(), '.cache', 'mnemonad', 'jobs');
}

/**
 * Identifies a stream across commands: the same token id is a different stream on another
 * chain or registry.
 *
 * @param {{chain: string, contractAddress: ?string, streamId: bigint|string}} where
 */
export function streamKey({ chain, contractAddress, streamId }) {
    return `${chain}|${String(contractAddress || '').toLowerCase()}|${formatStreamId(streamId)}`;
}

function signerKey({ chain, signer }) {
    return `${chain}|${String(signer || '').toLowerCase()}`;
}

function isPidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM: the process exists, it's just not ours to signal.
        return err.code === 'EPERM';
    }
}

function writeJobSync(dir, job) {
    // Synchronous on purpose: callers read-modify-write job.json from two processes, and a
    // torn async write would leave a half-written file for the other side to parse.
    const tmp = join(dir, `job.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, join(dir, 'job.json'));
}

function readJobSync(dir) {
    try {
        return JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Re-reads a job and settles it as failed when it claims to be running but nothing is: the
 * child was killed, the machine slept through a crash, or the spawn never happened.
 */
function refreshJob(dir) {
    const job = readJobSync(dir);
    if (!job || !ACTIVE.has(job.status)) return job;

    const neverStarted = !job.pid && Date.now() - Date.parse(job.createdAt) > SPAWN_GRACE_MS;
    if (neverStarted || (job.pid && !isPidAlive(job.pid))) {
        const settled = {
            ...job,
            status: JOB_STATUS.FAILED,
            error: neverStarted
                ? 'the background process never started'
                : 'the background process exited before finishing',
            finishedAt: new Date().toISOString(),
            reported: false,
        };
        writeJobSync(dir, settled);
        return settled;
    }
    return job;
}

/** Every job on disk, oldest first, with dead ones settled as failed. */
export function listJobs() {
    let names;
    try {
        names = readdirSync(jobsRoot());
    } catch {
        return [];
    }
    const jobs = [];
    for (const name of names) {
        const dir = join(jobsRoot(), name);
        const job = refreshJob(dir);
        if (job) jobs.push({ ...job, dir });
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function isActive(job) {
    return ACTIVE.has(job.status);
}

/** Jobs still running for a stream (`{streamKey}`) or a signer (`{signer, chain}`). */
export function activeJobs(selector) {
    return listJobs().filter((job) => isActive(job) && matches(job, selector));
}

function matches(job, selector) {
    if (selector.streamKey) return job.streamKey === selector.streamKey;
    return signerKey(job) === signerKey(selector);
}

/** The most recent job for a stream, active or not. */
export function latestJob(key) {
    const jobs = listJobs().filter((job) => job.streamKey === key);
    return jobs.length ? jobs[jobs.length - 1] : null;
}

/**
 * Blocks until no job matching `selector` is still running, printing one line while it
 * waits. Returns how many it waited for.
 *
 * @param {{streamKey: string}|{signer: string, chain: string}} selector
 * @param {Object} [opts]
 * @param {string} [opts.reason] - why this command has to wait, for the printed line
 */
export async function waitForJobs(selector, { reason = 'before continuing' } = {}) {
    let first = activeJobs(selector);
    if (!first.length) return 0;

    const job = first[first.length - 1];
    console.log(
        `  waiting for background push ${job.id} (${versionLabel(job)}) to finish ${reason}...\n` +
        `  log: ${formatPath(join(job.dir, 'push.log'))}`
    );
    while (first.length) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        first = activeJobs(selector);
    }
    return 1;
}

/**
 * Prints a failed job's error once — the next command on that stream after the failure —
 * then marks it reported, so a failure is never silent past one run but doesn't nag forever.
 * `mnemonad info` keeps showing it regardless (see describeJob).
 */
export function reportFailedJob(key) {
    const job = latestJob(key);
    if (!job || job.status !== JOB_STATUS.FAILED || job.reported) return;
    console.log(
        `  warning: background push ${job.id} (${versionLabel(job)}) failed: ${job.error}\n` +
        `           nothing from it reached the stream. Log: ${formatPath(join(job.dir, 'push.log'))}`
    );
    writeJobSync(job.dir, { ...readJobSync(job.dir), reported: true });
}

/**
 * What every command that touches a stream calls once its id is known: reports a failed
 * background push (once), then either waits for a running one (`wait: true` — push, pull,
 * compact, watch: anything that would build on, or overwrite with, the version before it) or
 * just says one is running (diff, which only reads).
 *
 * @param {Object} args - parsed CLI args; needs `chain`, `contractAddress`, `streamId`
 * @param {Object} [opts]
 * @param {boolean} [opts.wait=true]
 * @param {string} [opts.reason] - see waitForJobs
 */
export async function settleStreamJobs(args, { wait = true, reason } = {}) {
    if (!args.streamId) return;
    const key = streamKey({ chain: args.chain, contractAddress: args.contractAddress, streamId: args.streamId });
    reportFailedJob(key);
    if (wait) {
        await waitForJobs({ streamKey: key }, { reason });
        return;
    }
    const running = activeJobs({ streamKey: key });
    if (running.length) {
        const job = running[running.length - 1];
        console.log(
            `  note: background push ${job.id} (${versionLabel(job)}) is still running —\n` +
            '        this compares against the chain as it is before that version lands'
        );
    }
}

/** One line for `mnemonad info`. */
export function describeJob(job) {
    const log = formatPath(join(job.dir, 'push.log'));
    switch (job.status) {
        case JOB_STATUS.DONE:
            return job.noChanges
                ? `no changes, nothing pushed ${job.finishedAt} (job ${job.id})`
                : `version ${job.version} sent ${job.finishedAt} (job ${job.id})`;
        case JOB_STATUS.FAILED:
            return `${versionLabel(job)} FAILED: ${job.error} (job ${job.id}, log: ${log})`;
        case JOB_STATUS.WAITING:
            return `${versionLabel(job)} queued behind another push from the same wallet (job ${job.id}, log: ${log})`;
        case JOB_STATUS.PREPARING:
            return `indexing and building the next version (job ${job.id}, pid ${job.pid ?? '?'}, log: ${log})`;
        default:
            return `${versionLabel(job)} still sending (job ${job.id}, pid ${job.pid ?? '?'}, log: ${log})`;
    }
}

function pruneFinishedJobs() {
    for (const job of listJobs()) {
        if (isActive(job) || !job.finishedAt) continue;
        if (Date.now() - Date.parse(job.finishedAt) > KEEP_FINISHED_MS) {
            rmSync(job.dir, { recursive: true, force: true });
        }
    }
}

/**
 * Writes a job and starts its detached child.
 *
 * @param {Object} job - everything the child needs except secrets; see push.js's detachPush.
 *   `mode: 'prepare'` (push.js's detachPrepare) has the child index and build the patch too.
 * @param {?Uint8Array} patchBytes - the prepared patch; null in `prepare` mode
 * @param {{key?: ?string, phrase?: ?string, password?: ?string, pinataJwt?: ?string}} secrets
 * @returns {Promise<{id: string, dir: string, pid: number}>}
 */
export async function startPushJob(job, patchBytes, secrets) {
    pruneFinishedJobs();

    const id = randomBytes(4).toString('hex');
    const dir = join(jobsRoot(), id);
    await mkdir(dir, { recursive: true });
    if (patchBytes) await writeFile(join(dir, 'patch.bin'), patchBytes);
    writeJobSync(dir, { ...job, id, status: JOB_STATUS.PENDING, pid: null, createdAt: new Date().toISOString() });

    const logFd = openSync(join(dir, 'push.log'), 'a');
    let child;
    try {
        child = spawn(process.execPath, [BIN_PATH, '__push-job', dir], {
            detached: true,
            stdio: ['pipe', logFd, logFd],
            windowsHide: true,
        });
    } finally {
        closeSync(logFd);
    }

    writeJobSync(dir, { ...readJobSync(dir), pid: child.pid });
    child.stdin.end(JSON.stringify(secrets));
    child.unref();
    return { id, dir, pid: child.pid };
}

async function readStdin() {
    const parts = [];
    for await (const part of process.stdin) parts.push(part);
    const raw = Buffer.concat(parts).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}

function log(...parts) {
    console.log(new Date().toISOString(), ...parts);
}

/**
 * The detached child: `mnemonad __push-job <dir>`. Never typed by a person — not in --help.
 *
 * Waits its turn behind earlier jobs from the same signer (two processes sending with one key
 * would race for the same nonce), then sends the prepared patch from a fresh, never-replayed
 * Mnemonad instance, and on success writes the folder's .mnemonad exactly like a foreground
 * `push --manifest` would have.
 *
 * @param {string} dir - the job folder
 */
export async function runPushJob(dir) {
    if (!dir) throw userError('__push-job needs a job folder');
    const secrets = await readStdin();

    let job = readJobSync(dir);
    if (!job) throw userError(`no job at ${dir}`);
    const update = (fields) => {
        job = { ...readJobSync(dir), ...fields };
        writeJobSync(dir, job);
    };
    update({ pid: process.pid });

    try {
        const earlier = () => activeJobs({ signer: job.signer, chain: job.chain })
            .filter((other) => other.createdAt < job.createdAt || (other.createdAt === job.createdAt && other.id < job.id));
        if (earlier().length) {
            update({ status: JOB_STATUS.WAITING });
            log(`waiting for earlier background push(es) from ${job.signer}...`);
            while (earlier().length) await new Promise((r) => setTimeout(r, POLL_MS));
        }

        const args = { ...job.args, key: secrets.key ?? null, phrase: secrets.phrase ?? null, password: secrets.password ?? null, pinataJwt: secrets.pinataJwt ?? null, passkey: false };
        const client = await makeChainClient(args);
        requireWalletClient(client);

        const mn = new Mnemonad({
            publicClient: client.publicClient,
            walletClient: client.walletClient,
            contractAddress: client.contractAddress,
            id: job.streamId,
            ...resolveOffloadParams(args, client.account),
        });
        await unlockStream(mn, { password: args.password, signer: client.walletClient });

        let sync;
        let prepared;
        let files = job.manifest?.files || null;
        if (job.mode === 'prepare') {
            update({ status: JOB_STATUS.PREPARING, startedAt: new Date().toISOString() });
            await assertStreamOwner(mn, client.account.address);
            const built = await prepareInBackground(job, args, mn);
            if (!built) {
                update({ status: JOB_STATUS.DONE, noChanges: true, version: mn.length, finishedAt: new Date().toISOString() });
                log('no changes, nothing to push');
                return;
            }
            ({ sync, prepared, files } = built);
            update({ version: prepared.version, baseLength: prepared.baseLength, kind: prepared.kind, bytes: prepared.patchBytes.length });
        } else {
            sync = new MonadSync({ mnemonad: mn });
            prepared = { patchBytes: new Uint8Array(await readFile(join(dir, 'patch.bin'))), baseLength: job.baseLength };
        }

        update({ status: JOB_STATUS.SENDING, sendingAt: new Date().toISOString() });
        log(`sending version ${job.version} of ${job.streamId} on ${job.chain}...`);
        const result = await sync.commitPush(prepared);

        if (job.manifest) {
            await writeManifest(job.folder, { streamId: job.streamId, version: result.version, files });
        }
        update({ status: JOB_STATUS.DONE, version: result.version, finishedAt: new Date().toISOString() });
        log(`version ${result.version} pushed`);
    } catch (err) {
        const error = err.code === 'STREAM_MOVED'
            ? `the stream changed after this push was prepared (it was built on version ${job.baseLength}) — push again`
            : err.message;
        update({ status: JOB_STATUS.FAILED, error, finishedAt: new Date().toISOString(), reported: false });
        log('failed:', err.stack || err.message);
        process.exitCode = 1;
    } finally {
        await rm(join(dir, 'patch.bin'), { force: true });
    }
}

/**
 * The part of a foreground push that `push --detach --index` hands off along with the sending:
 * update the search index, replay the chain, and build the patch — same steps, same order, as
 * push.js. Runs after any earlier job from the same wallet has landed, so it builds on the
 * real tip.
 *
 * @returns {Promise<?{sync: MonadSync, prepared: Object, files: ?Object}>} null when the folder
 *   already matches the latest version
 */
async function prepareInBackground(job, args, mn) {
    log('updating search index...');
    try {
        await updateIndex(job.folder, args, { quiet: true });
    } catch (err) {
        throw new Error(`indexing failed, so nothing was pushed: ${err.message}`);
    }

    const fsFolder = new FSFolder(job.folder, makeExcludes(args));
    const sync = new MonadSync({ mnemonad: mn, compress: args.compress === false ? false : 'gzip' });

    if (args.forceSnapshot) {
        // Same escape hatch push.js uses — see monadsync/README.md "Repairing a corrupt chain".
        await mn.initialize();
        sync._isInitialized = true;
        sync._lastSnapshot = null;
        sync._replayedCount = mn.length;
    } else {
        await sync.initialize();
        if (mn.length > 0) {
            const localHash = await localTreeHash(job.folder);
            const remoteHash = await sync.getTreeHash(mn.length);
            if (localHash && remoteHash.length === localHash.length && localHash.every((b, i) => b === remoteHash[i])) {
                return null;
            }
        }
    }

    log('building patch...');
    const prepared = await sync.preparePush(fsFolder);
    const files = job.manifest ? await hashLocalTree(fsFolder) : null;
    return { sync, prepared, files };
}

/** For tests: blocks until a job has finished, and returns it. */
export async function waitForJob(dir, { timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const job = refreshJob(dir);
        if (job && !isActive(job)) return job;
        if (Date.now() > deadline) throw new Error(`job ${dir} still ${job?.status} after ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

