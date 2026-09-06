import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ids as mnemonadIds } from 'mnemonad';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * Reads and validates configuration once, at boot.
 *
 * Fails fast and loudly: a server that starts with a missing Pinata credential looks
 * healthy right up until the first paid request, by which point a user has already spent
 * MON and is waiting on a URL that will never come. Better to refuse to start.
 */
export function loadConfig(env = process.env) {
	const errors = [];

	const pinataJwt = env.PINATA_JWT || env.PINATA_JWT_TOKEN;
	if (!pinataJwt) errors.push('PINATA_JWT is required (a Pinata JWT with pinning-write scope)');

	const chainId = int(env.CHAIN_ID, 10143);
	const entry = Object.values(mnemonadIds).find((e) => e.chainId === chainId) || null;
	const registryAddress = env.REGISTRY_ADDRESS || entry?.contractAddress || null;
	if (!registryAddress) {
		errors.push(
			`REGISTRY_ADDRESS is required: chainId ${chainId} has no address recorded in mnemonad's ids.js`
		);
	}

	const rpcUrl = env.RPC_URL || defaultRpc(chainId);
	if (!rpcUrl) errors.push(`RPC_URL is required: no default known for chainId ${chainId}`);

	const config = {
		host: env.HOST || '127.0.0.1',
		port: int(env.PORT, 8787),
		logLevel: env.LOG_LEVEL || 'info',
		corsOrigin: env.CORS_ORIGIN || null,

		chainId,
		rpcUrl,
		registryAddress,

		pinataJwt,
		pinataSignUrl: env.PINATA_SIGN_URL || 'https://uploads.pinata.cloud/v3/files/sign',
		pinataNetwork: env.PINATA_NETWORK || 'public',

		/** How long an issued upload URL stays valid. Short: it is used immediately. */
		urlTtlSeconds: int(env.URL_TTL_SECONDS, 120),

		/**
		 * Safety gap between an issued URL's expiry and the escrow's own expiry.
		 *
		 * Load-bearing, not padding. Once the escrow expires the payer can `refund`, so a
		 * URL that outlived it would let them reclaim their MON *and* still upload — a free
		 * upload. The URL must always die first.
		 */
		escrowMarginSeconds: int(env.ESCROW_MARGIN_SECONDS, 60),

		/**
		 * How many URLs one escrow may be issued.
		 *
		 * Not 1: a legitimate upload that dies on a flaky connection would otherwise strand
		 * a payer until refund. Not unbounded: each issue costs a duplicate upload of
		 * already-paid-for bytes. `consumeUpload` deletes the request on settlement, so no
		 * number here can cause a double fee waiver — this only bounds storage abuse.
		 */
		maxIssuesPerRequest: int(env.MAX_ISSUES_PER_REQUEST, 3),

		/** Widest `deadline` a request signature may carry, bounding replay. */
		maxSignatureWindowSeconds: int(env.MAX_SIGNATURE_WINDOW_SECONDS, 300),

		/** Refuse absurd sizes before touching the chain or Pinata. */
		maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 1024 * 1024 * 1024),

		ledgerPath: env.LEDGER_PATH || path.join(SERVER_ROOT, 'data/issued.jsonl'),

		/**
		 * Ceiling on outbound RPC calls per second. Monad's public endpoint rejects past
		 * ~15/sec rather than queueing, so this is a real limit to respect, not a courtesy.
		 */
		maxRpcPerSecond: int(env.MAX_RPC_PER_SECOND, 8),

		rateLimitMax: int(env.RATE_LIMIT_MAX, 60),
		rateLimitWindow: env.RATE_LIMIT_WINDOW || '1 minute',
	};

	if (config.urlTtlSeconds <= 0) errors.push('URL_TTL_SECONDS must be positive');
	if (config.escrowMarginSeconds < 0) errors.push('ESCROW_MARGIN_SECONDS must not be negative');
	if (config.maxIssuesPerRequest < 1) errors.push('MAX_ISSUES_PER_REQUEST must be at least 1');

	if (errors.length) {
		throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
	}
	return config;
}

function int(value, fallback) {
	if (value === undefined || value === '') return fallback;
	const n = Number(value);
	if (!Number.isInteger(n)) throw new Error(`Expected an integer, got '${value}'`);
	return n;
}

function defaultRpc(chainId) {
	if (chainId === 10143) return 'https://testnet-rpc.monad.xyz';
	if (chainId === 143) return 'https://rpc.monad.xyz';
	return null;
}
