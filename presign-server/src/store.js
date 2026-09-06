import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable record of which escrows have been issued upload URLs.
 *
 * An append-only JSON-lines file, replayed into a Map at boot. Not SQLite, and deliberately
 * not: the volume is one row per *paid* upload, and the thing this protects is Pinata
 * storage rather than money — `consumeUpload` deletes the on-chain request on settlement,
 * so no amount of URL leakage can produce a second fee waiver. A native dependency (or
 * Node 22's flag-gated `node:sqlite`) would be paying real cost for durability guarantees
 * this workload does not need. If issuance volume ever justifies indexes, this is the
 * seam to replace.
 *
 * Concurrency: the check-and-claim below is synchronous, so it completes within one
 * event-loop turn and two simultaneous requests cannot both pass it. The file append is
 * async and happens after the claim, which is the right order — a crash between the two
 * loses a record, and losing a record only permits one extra bounded upload.
 */
export function createStore({ ledgerPath, maxIssuesPerRequest }) {
	/** @type {Map<string, {count: number, url: string, expiresAt: number}>} */
	const issued = new Map();
	let ready = false;

	function load() {
		if (ready) return;
		fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
		if (fs.existsSync(ledgerPath)) {
			const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n');
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const row = JSON.parse(line);
					if (!row.requestId) continue;
					// Later rows supersede earlier ones for the same escrow.
					issued.set(row.requestId, {
						count: row.count,
						url: row.url,
						expiresAt: row.expiresAt,
					});
				} catch {
					// A truncated final line (crash mid-append) is expected and skippable.
				}
			}
		}
		ready = true;
	}

	/**
	 * Decides whether a request may be issued a URL, and claims the slot if so.
	 *
	 * @returns {{action: 'reuse', url: string, expiresAt: number}
	 *   | {action: 'issue', count: number}
	 *   | {action: 'exhausted', count: number}}
	 */
	function claim(requestId, now) {
		load();
		const prev = issued.get(requestId);

		// A still-valid URL is returned as-is rather than counted again: a client retrying
		// after a dropped response should not burn an attempt.
		if (prev && prev.url && prev.expiresAt > now) {
			return { action: 'reuse', url: prev.url, expiresAt: prev.expiresAt };
		}
		const count = prev ? prev.count : 0;
		if (count >= maxIssuesPerRequest) {
			return { action: 'exhausted', count };
		}
		// Claim synchronously, before any await in the caller, so concurrent requests for
		// the same escrow cannot both get past this point.
		issued.set(requestId, { count: count + 1, url: null, expiresAt: 0 });
		return { action: 'issue', count: count + 1 };
	}

	/** Records the URL actually issued, and persists the row. */
	async function commit(requestId, { url, expiresAt, count, payer, contentHash, maxSize }) {
		issued.set(requestId, { count, url, expiresAt });
		const row = JSON.stringify({
			requestId,
			payer,
			contentHash,
			maxSize: String(maxSize),
			url,
			expiresAt,
			count,
			at: new Date().toISOString(),
		});
		await fs.promises.appendFile(ledgerPath, `${row}\n`, 'utf8');
	}

	/** Releases a claim whose issuance failed, so a transient Pinata error costs no attempt. */
	function release(requestId, count) {
		if (count <= 1) issued.delete(requestId);
		else issued.set(requestId, { count: count - 1, url: null, expiresAt: 0 });
	}

	function stats() {
		load();
		return { tracked: issued.size };
	}

	return { claim, commit, release, stats };
}
