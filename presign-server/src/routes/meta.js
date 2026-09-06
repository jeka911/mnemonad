import { UPLOAD_REQUEST_TYPES, uploadRequestDomain } from '../auth.js';

/**
 * Liveness and public configuration.
 *
 * `/config` publishes the EIP-712 domain and types so a client signs exactly what this
 * server verifies, rather than both sides hardcoding a copy that can silently drift. It
 * carries nothing secret: addresses, a chain id, and the shape of a signature.
 */
export default function metaRoutes(app, { config, chain, store }) {
	app.get('/health', async (_request, reply) => {
		// Reachability of the chain and a wired gateway are the two things that make this
		// service able to do its job at all, so "healthy" has to mean both.
		try {
			const gateway = await chain.getGateway();
			const [blockNumber, cfg] = await Promise.all([
				chain.publicClient.getBlockNumber({ cacheTime: 0 }),
				gateway.config(),
			]);
			return reply.send({
				status: 'ok',
				chainId: config.chainId,
				blockNumber: String(blockNumber),
				registry: config.registryAddress,
				gateway: gateway.address,
				gatewayPaused: cfg.paused,
				ledger: store.stats(),
			});
		} catch (err) {
			return reply.code(503).send({ status: 'degraded', error: err.message });
		}
	});

	app.get('/config', async (_request, reply) => {
		const gateway = await chain.getGateway();
		const cfg = await gateway.config();
		// Reverts when the oracle cannot currently be priced against — a real state to
		// report, not an error to hide.
		const weiPerMiB = await gateway.weiPerMiB().then(String).catch(() => null);

		return reply.send({
			chainId: config.chainId,
			registry: config.registryAddress,
			gateway: gateway.address,
			usdCentsPerMiB: Number(cfg.usdCentsPerMiB),
			minChargeWei: String(cfg.minChargeWei),
			requestTtlSeconds: Number(cfg.requestTtl),
			paused: cfg.paused,
			weiPerMiB,
			urlTtlSeconds: config.urlTtlSeconds,
			maxUploadBytes: config.maxUploadBytes,
			maxSignatureWindowSeconds: config.maxSignatureWindowSeconds,
			eip712: {
				domain: uploadRequestDomain({ chainId: config.chainId, gatewayAddress: gateway.address }),
				types: UPLOAD_REQUEST_TYPES,
				primaryType: 'UploadRequest',
			},
		});
	});
}
