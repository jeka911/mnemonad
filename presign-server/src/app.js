import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { createChain } from './chain.js';
import { createPinata } from './pinata.js';
import { createStore } from './store.js';
import uploadUrlRoutes from './routes/uploadUrl.js';
import metaRoutes from './routes/meta.js';

/**
 * Builds the app without binding a port, so tests can drive it via `app.inject()`.
 *
 * Every collaborator is injectable for the same reason: the interesting behaviour here is
 * the *gates* (signature, escrow, expiry, issuance limits), and those are only testable in
 * isolation if the chain and Pinata can be substituted.
 */
export async function buildApp(config, overrides = {}) {
	const app = Fastify({
		logger: { level: config.logLevel },
		trustProxy: config.trustProxy ?? false,
	});

	const chain = overrides.chain ?? createChain(config);
	const pinata = overrides.pinata ?? createPinata(config);
	const store = overrides.store ?? createStore(config);

	// The paywall is the real rate limit on issuance — you cannot get a URL without having
	// paid. This guards the cheap-to-call surface around it (signature recovery, chain
	// reads) from being used as a free amplifier.
	await app.register(rateLimit, {
		max: config.rateLimitMax,
		timeWindow: config.rateLimitWindow,
	});

	if (config.corsOrigin) {
		await app.register(cors, { origin: config.corsOrigin.split(',').map((s) => s.trim()) });
	}

	app.setErrorHandler((err, request, reply) => {
		// Fastify's schema errors are client mistakes; surface them as such rather than 500.
		if (err.validation) {
			return reply.code(400).send({ error: 'bad_request', message: err.message });
		}
		// An unreachable or rate-limiting RPC is not a bug in this service, and telling a
		// client "internal error" invites them to give up instead of retrying. Observed for
		// real: Monad's public endpoint returns `requests limited to 15/sec` under load,
		// which surfaced as a 500 and read as a server fault.
		if (isUpstreamChainError(err)) {
			request.log.warn({ err: err.shortMessage || err.message }, 'chain upstream unavailable');
			return reply.code(503).send({
				error: 'chain_unavailable',
				message: 'Could not read chain state right now. Retry shortly.',
			});
		}
		request.log.error({ err }, 'unhandled error');
		return reply.code(500).send({ error: 'internal', message: 'Unexpected server error.' });
	});

	const deps = { config, chain, pinata, store };
	await app.register(async (scope) => metaRoutes(scope, deps));
	await app.register(async (scope) => uploadUrlRoutes(scope, deps));

	return app;
}

/**
 * Recognises a failure that came from the chain endpoint rather than from our own logic.
 *
 * Matches on viem's error names plus the transport-level cases (rate limits, timeouts,
 * refused connections). Deliberately does *not* treat a contract revert as upstream — a
 * revert is a real answer, and the routes that expect one already handle it.
 */
function isUpstreamChainError(err) {
	const names = new Set([
		'HttpRequestError',
		'RpcRequestError',
		'TimeoutError',
		'InternalRpcError',
		'LimitExceededRpcError',
		'ContractFunctionExecutionError',
	]);
	for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth += 1) {
		if (names.has(e.name)) {
			// A revert carries decoded error data; an unreachable node does not.
			const reverted = e.name === 'ContractFunctionExecutionError' && hasRevertData(e);
			if (!reverted) return true;
		}
	}
	return false;
}

function hasRevertData(err) {
	for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth += 1) {
		if (e.name === 'ContractFunctionRevertedError') return true;
	}
	return false;
}
