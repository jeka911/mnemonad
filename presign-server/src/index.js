/**
 * Entry point. Reads `.env` via Node's own loader (no dotenv dependency, matching
 * contracts/hardhat.config.ts and scripts/deploy.js), then starts the app.
 */
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createChain } from './chain.js';

try {
	process.loadEnvFile();
} catch {
	// No .env — fine when the environment is already populated.
}

const config = loadConfig();
const chain = createChain(config);

// Resolve the gateway before listening. A server that accepts requests it can never
// fulfil — because no gateway is wired, or the RPC is unreachable — is worse than one that
// refuses to start and says why.
try {
	const gateway = await chain.getGateway();
	console.log(`registry ${config.registryAddress} -> gateway ${gateway.address}`);
} catch (err) {
	console.error(`Refusing to start: ${err.message}`);
	process.exit(1);
}

const app = await buildApp(config, { chain });

try {
	await app.listen({ host: config.host, port: config.port });
} catch (err) {
	app.log.error({ err }, 'failed to start');
	process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		app.log.info({ signal }, 'shutting down');
		await app.close();
		process.exit(0);
	});
}
