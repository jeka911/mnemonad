import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/store.js';
import { buildUploadRequestTypedData } from '../src/auth.js';
import { PinataError } from '../src/pinata.js';

/**
 * The gates in `POST /upload-url`, each driven in isolation.
 *
 * Chain and Pinata are substituted rather than mocked deeply: what is worth testing here is
 * the decision logic — does a missing escrow get refused, does an oversized request get
 * refused, does a URL ever outlive the escrow funding it — not viem's or Pinata's behaviour.
 */

const GATEWAY = '0xD1BAe7c151A8DF2b3f5B9D3DBb41c168B7606ED9';
const REGISTRY = '0xbea34c1500832dc0dbf1402d8c15c1cf720d0ad2';
const CHAIN_ID = 10143;

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const contentHash = `0x${'ab'.repeat(32)}`;

function baseConfig(extra = {}) {
	return loadConfig({
		PINATA_JWT: 'test-jwt',
		CHAIN_ID: String(CHAIN_ID),
		REGISTRY_ADDRESS: REGISTRY,
		LEDGER_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'presign-')), 'issued.jsonl'),
		LOG_LEVEL: 'silent',
		...extra,
	});
}

/** A chain stub whose escrow answer each test controls. */
function fakeChain(escrow, gatewayCfg = {}) {
	return {
		publicClient: { getBlockNumber: async () => 123n },
		getGateway: async () => ({
			address: GATEWAY,
			config: async () => ({
				usdCentsPerMiB: 5n,
				minChargeWei: 0n,
				paused: false,
				maxPriceAge: 5_184_000n,
				requestTtl: 3600n,
				...gatewayCfg,
			}),
			weiPerMiB: async () => 2_201_809_975_872_566_284n,
			requestFor: async () => escrow,
		}),
		resetGateway: () => {},
		getEscrow: async () => escrow,
	};
}

function fakePinata(impl) {
	const calls = [];
	return {
		calls,
		createUploadUrl: async (args) => {
			calls.push(args);
			if (impl) return await impl(args);
			return {
				url: `https://uploads.pinata.cloud/v3/files/fake?X-Expires=${args.expiresIn}`,
				expiresAt: Math.floor(Date.now() / 1000) + args.expiresIn,
				maxFileSize: args.maxFileSize,
			};
		},
	};
}

function openEscrow(overrides = {}) {
	const now = BigInt(Math.floor(Date.now() / 1000));
	return {
		requestId: `0x${'11'.repeat(32)}`,
		amount: 272_975_251_067_575_090n,
		maxSize: 130_000n,
		expiry: now + 3600n,
		exists: true,
		...overrides,
	};
}

async function sign({ size, deadline, signer = account, gatewayAddress = GATEWAY }) {
	return await signer.signTypedData(
		buildUploadRequestTypedData({
			chainId: CHAIN_ID,
			gatewayAddress,
			payer: signer.address,
			contentHash,
			size,
			deadline,
		})
	);
}

async function post(app, body) {
	return await app.inject({ method: 'POST', url: '/upload-url', payload: body });
}

/** A fully valid request, for tests that vary exactly one thing. */
async function validBody(size = 130_000) {
	const deadline = Math.floor(Date.now() / 1000) + 120;
	return {
		payer: account.address,
		contentHash,
		size,
		deadline,
		signature: await sign({ size, deadline }),
	};
}

let config;
beforeEach(() => {
	config = baseConfig();
});

describe('happy path', () => {
	it('declares the escrowed ceiling to Pinata, not the requested size', async () => {
		const pinata = fakePinata();
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata });

		const res = await post(app, await validBody(64_000));
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.url).toContain('uploads.pinata.cloud');
		expect(body.maxFileSize).toBe(130_000);
		expect(body.reused).toBe(false);

		// Declared as what was paid for — which is also what `consumeUpload` accepts.
		// Advisory only: Pinata does not enforce it (see pinata.js).
		expect(pinata.calls[0].maxFileSize).toBe(130_000);
		// The escrow is the correlation key for later auditing.
		expect(pinata.calls[0].keyvalues.requestId).toBe(openEscrow().requestId);
		await app.close();
	});

	it('records the issuance durably, so a restart does not forget', async () => {
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata: fakePinata() });
		await post(app, await validBody());
		await app.close();

		const rows = fs.readFileSync(config.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
		expect(rows).toHaveLength(1);
		expect(rows[0].requestId).toBe(openEscrow().requestId);
		expect(rows[0].count).toBe(1);

		// A fresh store over the same ledger sees the prior issuance.
		expect(createStore(config).stats().tracked).toBe(1);
	});
});

describe('proving control of `payer`', () => {
	it('rejects a signature from someone else — requestId is public, so it is not a bearer token', async () => {
		const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata: fakePinata() });

		const deadline = Math.floor(Date.now() / 1000) + 120;
		const res = await post(app, {
			payer: account.address, // claims to be the payer...
			contentHash,
			size: 130_000,
			deadline,
			signature: await sign({ size: 130_000, deadline, signer: other }), // ...but signed by another key
		});
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('bad_signature');
		await app.close();
	});

	it('rejects a signature bound to a different gateway', async () => {
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata: fakePinata() });
		const deadline = Math.floor(Date.now() / 1000) + 120;
		const res = await post(app, {
			payer: account.address,
			contentHash,
			size: 130_000,
			deadline,
			// Domain separation is what stops a signature being replayed at a redeployed gateway.
			signature: await sign({ size: 130_000, deadline, gatewayAddress: REGISTRY }),
		});
		expect(res.statusCode).toBe(401);
		await app.close();
	});

	it('rejects an expired deadline and an unbounded one', async () => {
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata: fakePinata() });
		const now = Math.floor(Date.now() / 1000);

		for (const [deadline, code] of [[now - 1, 'deadline_passed'], [now + 999_999, 'deadline_too_far']]) {
			const res = await post(app, {
				payer: account.address,
				contentHash,
				size: 130_000,
				deadline,
				signature: await sign({ size: 130_000, deadline }),
			});
			expect(res.statusCode).toBe(401);
			expect(res.json().error).toBe(code);
		}
		await app.close();
	});
});

describe('the escrow gate', () => {
	it('refuses with 402 when nothing has been paid', async () => {
		const app = await buildApp(config, {
			chain: fakeChain({ ...openEscrow(), amount: 0n, exists: false }),
			pinata: fakePinata(),
		});
		const res = await post(app, await validBody());
		expect(res.statusCode).toBe(402);
		expect(res.json().error).toBe('no_escrow');
		await app.close();
	});

	it('refuses a request larger than the escrow covers', async () => {
		const pinata = fakePinata();
		const app = await buildApp(config, { chain: fakeChain(openEscrow({ maxSize: 1000n })), pinata });
		const res = await post(app, await validBody(50_000));
		expect(res.statusCode).toBe(402);
		expect(res.json().error).toBe('size_exceeds_escrow');
		expect(pinata.calls).toHaveLength(0);
		await app.close();
	});
});

describe('the URL must never outlive its funding', () => {
	it('shrinks the TTL to stay inside the escrow window', async () => {
		// 90s of escrow left, 60s margin -> only 30s may be granted, less than the 120s default.
		const now = BigInt(Math.floor(Date.now() / 1000));
		const pinata = fakePinata();
		const app = await buildApp(config, {
			chain: fakeChain(openEscrow({ expiry: now + 90n })),
			pinata,
		});

		const res = await post(app, await validBody());
		expect(res.statusCode).toBe(200);
		expect(pinata.calls[0].expiresIn).toBeLessThanOrEqual(30);
		expect(pinata.calls[0].expiresIn).toBeGreaterThan(0);
		await app.close();
	});

	it('refuses outright when the escrow is inside the safety margin', async () => {
		// Past the escrow's expiry the payer can refund(); a URL that outlived it would mean
		// reclaiming the MON *and* still uploading — a free upload.
		const now = BigInt(Math.floor(Date.now() / 1000));
		const pinata = fakePinata();
		const app = await buildApp(config, {
			chain: fakeChain(openEscrow({ expiry: now + 10n })),
			pinata,
		});

		const res = await post(app, await validBody());
		expect(res.statusCode).toBe(402);
		expect(res.json().error).toBe('escrow_expiring');
		expect(pinata.calls).toHaveLength(0);
		await app.close();
	});
});

describe('issuance limits', () => {
	it('returns the same URL for a retry while it is still valid', async () => {
		const pinata = fakePinata();
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata });

		const first = await post(app, await validBody());
		const second = await post(app, await validBody());

		expect(second.statusCode).toBe(200);
		expect(second.json().reused).toBe(true);
		expect(second.json().url).toBe(first.json().url);
		// A retry after a dropped response must not burn an attempt.
		expect(pinata.calls).toHaveLength(1);
		await app.close();
	});

	it('stops issuing after the configured attempt cap', async () => {
		// Every URL expires immediately, so each call is a fresh attempt rather than a reuse.
		const pinata = fakePinata(async (args) => ({
			url: 'https://uploads.pinata.cloud/v3/files/expired',
			expiresAt: Math.floor(Date.now() / 1000) - 1,
			maxFileSize: args.maxFileSize,
		}));
		const app = await buildApp(baseConfig({ MAX_ISSUES_PER_REQUEST: '2' }), {
			chain: fakeChain(openEscrow()),
			pinata,
		});

		expect((await post(app, await validBody())).statusCode).toBe(200);
		expect((await post(app, await validBody())).statusCode).toBe(200);
		const third = await post(app, await validBody());
		expect(third.statusCode).toBe(429);
		expect(third.json().error).toBe('issue_limit_reached');
		await app.close();
	});

	it('does not consume an attempt when Pinata fails', async () => {
		let calls = 0;
		const pinata = fakePinata(async (args) => {
			calls += 1;
			if (calls === 1) throw new PinataError('pinata: sign failed (HTTP 500)', 500);
			return {
				url: 'https://uploads.pinata.cloud/v3/files/ok',
				expiresAt: Math.floor(Date.now() / 1000) + args.expiresIn,
				maxFileSize: args.maxFileSize,
			};
		});
		const app = await buildApp(baseConfig({ MAX_ISSUES_PER_REQUEST: '1' }), {
			chain: fakeChain(openEscrow()),
			pinata,
		});

		const failed = await post(app, await validBody());
		expect(failed.statusCode).toBe(502);
		expect(failed.json().error).toBe('pinata_unavailable');

		// The payer did nothing wrong, so their single attempt must still be available.
		const retry = await post(app, await validBody());
		expect(retry.statusCode).toBe(200);
		await app.close();
	});
});

describe('input validation', () => {
	it('rejects a malformed hash or size before any chain or Pinata work', async () => {
		const pinata = fakePinata();
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata });

		const body = await validBody();
		for (const bad of [
			{ ...body, contentHash: '0xnothex' },
			{ ...body, size: 0 },
			{ ...body, size: config.maxUploadBytes + 1 },
			{ ...body, payer: 'not-an-address' },
		]) {
			const res = await post(app, bad);
			expect(res.statusCode).toBe(400);
		}
		expect(pinata.calls).toHaveLength(0);
		await app.close();
	});
});

describe('meta routes', () => {
	it('publishes the EIP-712 domain a client must sign, so the two cannot drift', async () => {
		const app = await buildApp(config, { chain: fakeChain(openEscrow()), pinata: fakePinata() });
		const res = await app.inject({ method: 'GET', url: '/config' });
		expect(res.statusCode).toBe(200);

		const body = res.json();
		expect(body.eip712.domain.verifyingContract).toBe(GATEWAY);
		expect(body.eip712.domain.chainId).toBe(CHAIN_ID);
		expect(body.eip712.primaryType).toBe('UploadRequest');
		expect(body.gateway).toBe(GATEWAY);
		expect(body.usdCentsPerMiB).toBe(5);
		await app.close();
	});

	it('reports degraded rather than ok when the gateway cannot be resolved', async () => {
		const brokenChain = {
			publicClient: { getBlockNumber: async () => 1n },
			getGateway: async () => { throw new Error('no gateway wired'); },
			resetGateway: () => {},
			getEscrow: async () => openEscrow(),
		};
		const app = await buildApp(config, { chain: brokenChain, pinata: fakePinata() });
		const res = await app.inject({ method: 'GET', url: '/health' });
		expect(res.statusCode).toBe(503);
		expect(res.json().status).toBe('degraded');
		await app.close();
	});
});
