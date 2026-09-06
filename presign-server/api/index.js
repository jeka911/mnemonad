/**
 * Serverless entry point.
 *
 * `src/index.js` binds a port and owns a process; a function host owns the process and
 * hands over one request at a time. This file is the adapter between the two, and the only
 * place in the server that knows it might be running on a function host.
 *
 * Kept separate from `src/app.js` deliberately: `buildApp` stays a pure builder that the
 * tests can drive with injected collaborators, with no configuration read at import time.
 */
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Two facts about running on a function host, set here rather than left to the operator to
// remember in a dashboard. Both are corrections for the environment, not policy choices.

// The filesystem is read-only apart from /tmp, so the issuance ledger cannot live under
// the deployment. Its first write would otherwise fail with EROFS on the first *paid*
// request — the worst possible moment. See README "Deploying" for what /tmp costs.
process.env.LEDGER_PATH ??= '/tmp/mnemonad-presign/issued.jsonl';

// The host terminates TLS and forwards the caller's address, so `request.ip` has to come
// from `X-Forwarded-For`. Without this every request appears to originate from the same
// address and the rate limiter throttles all callers as one.
process.env.TRUST_PROXY ??= 'true';

/** @type {Promise<import('fastify').FastifyInstance> | undefined} */
let booting;

/**
 * Builds the app once per instance and reuses it across invocations.
 *
 * Unlike `src/index.js` this does *not* pre-resolve the gateway before serving: a check
 * that runs on every cold start would add a round trip to latency without adding safety,
 * since `GET /health` already reports chain reachability and gateway resolution on demand.
 */
function start() {
	booting ??= (async () => {
		const app = await buildApp(loadConfig());
		await app.ready();
		return app;
	})();
	return booting;
}

export default async function handler(req, res) {
	let app;
	try {
		app = await start();
	} catch (err) {
		// `buildApp` touches no network, so a failure here is a configuration error and
		// nothing else. Letting it escape gets an opaque platform-level crash; this at
		// least writes the reason somewhere an operator can read it. The reason names
		// environment variables, so it goes to the log rather than to the caller.
		console.error(`presign-server failed to start: ${err.message}`);
		// Let the next invocation try again, so a fixed configuration recovers without
		// waiting for this instance to be recycled.
		booting = undefined;
		res.statusCode = 500;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ error: 'misconfigured', message: 'Server is not configured correctly.' }));
		return;
	}
	app.server.emit('request', req, res);
}
