import { getAddress, isAddress } from 'viem';
import { verifyUploadRequest } from '../auth.js';
import { PinataError } from '../pinata.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * `POST /upload-url` — trades a proven, paid escrow for a size-bounded upload URL.
 *
 * Every gate below exists because skipping it has a concrete cost, noted inline. The order
 * matters: cheap local checks precede the signature recovery, which precedes chain reads,
 * which precede the (rate-limited, billable) Pinata call.
 */
export default function uploadUrlRoutes(app, { config, chain, pinata, store }) {
	app.post(
		'/upload-url',
		{
			schema: {
				body: {
					type: 'object',
					required: ['payer', 'contentHash', 'size', 'deadline', 'signature'],
					additionalProperties: false,
					properties: {
						payer: { type: 'string' },
						contentHash: { type: 'string', pattern: HEX32.source },
						// Bounded here so a nonsense size is rejected before any I/O.
						size: { type: 'integer', minimum: 1, maximum: config.maxUploadBytes },
						deadline: { type: 'integer', minimum: 1 },
						signature: { type: 'string' },
					},
				},
			},
		},
		async (request, reply) => {
			const { contentHash, size, deadline, signature } = request.body;
			const now = Math.floor(Date.now() / 1000);

			if (!isAddress(request.body.payer)) {
				return reply.code(400).send({ error: 'bad_payer', message: '`payer` is not an address.' });
			}
			const payer = getAddress(request.body.payer);

			const gateway = await chain.getGateway();

			// 1. Prove the caller controls `payer`. `requestId` is public in `UploadPaid`
			//    events, so without this anyone watching the chain could claim the URL that
			//    someone else's payment bought.
			const auth = await verifyUploadRequest({
				chainId: config.chainId,
				gatewayAddress: gateway.address,
				payer,
				contentHash,
				size,
				deadline,
				signature,
				now,
				maxWindowSeconds: config.maxSignatureWindowSeconds,
			});
			if (!auth.ok) {
				return reply.code(401).send({ error: auth.code, message: auth.message });
			}

			// 2. The payment itself. Read from the contract, never trusted from the request.
			const escrow = await chain.getEscrow(payer, contentHash);
			if (!escrow.exists) {
				return reply.code(402).send({
					error: 'no_escrow',
					message: 'No open escrow for this (payer, contentHash). Call payForUpload first.',
					requestId: escrow.requestId,
				});
			}

			// 3. Never issue a ceiling above what was paid for.
			const maxSize = Number(escrow.maxSize);
			if (size > maxSize) {
				return reply.code(402).send({
					error: 'size_exceeds_escrow',
					message: `Escrow covers ${maxSize} bytes, requested ${size}.`,
					maxSize,
				});
			}

			// 4. The URL must die before the escrow does. Past the escrow's expiry the payer
			//    can `refund`; a URL outliving it would let them reclaim their MON *and*
			//    still upload. Shrink the TTL to fit, and refuse rather than issue a URL
			//    that would outlast its funding.
			const secondsLeft = Number(escrow.expiry) - now - config.escrowMarginSeconds;
			if (secondsLeft <= 0) {
				return reply.code(402).send({
					error: 'escrow_expiring',
					message:
						'Escrow is too close to expiry to issue an upload URL safely. ' +
						'Let it lapse and reclaim it with refund(), then pay again.',
					expiry: Number(escrow.expiry),
				});
			}
			const expiresIn = Math.min(config.urlTtlSeconds, secondsLeft);

			// 5. Claim an issuance slot. Synchronous, so two concurrent requests for the same
			//    escrow cannot both proceed.
			const claim = store.claim(escrow.requestId, now);
			if (claim.action === 'reuse') {
				request.log.info({ requestId: escrow.requestId }, 'returning still-valid upload URL');
				return reply.send({
					url: claim.url,
					expiresAt: claim.expiresAt,
					maxFileSize: maxSize,
					reused: true,
				});
			}
			if (claim.action === 'exhausted') {
				return reply.code(429).send({
					error: 'issue_limit_reached',
					message: `This escrow has already been issued ${claim.count} upload URLs.`,
				});
			}

			// 6. Mint, declaring the *escrowed* ceiling — exactly what was paid for and
			//    exactly what `consumeUpload` will accept. Note `maxFileSize` is advisory:
			//    Pinata does not currently enforce it (see pinata.js). What bounds abuse
			//    here is that the URL is single-use, short-lived, and cost a real payment
			//    to obtain — not that oversize uploads are rejected.
			try {
				const issued = await pinata.createUploadUrl({
					maxFileSize: maxSize,
					expiresIn,
					name: `mnemonad-${escrow.requestId.slice(2, 12)}`,
					keyvalues: {
						requestId: escrow.requestId,
						payer,
						contentHash,
					},
				});

				await store.commit(escrow.requestId, {
					url: issued.url,
					expiresAt: issued.expiresAt,
					count: claim.count,
					payer,
					contentHash,
					maxSize,
				});

				request.log.info(
					{ requestId: escrow.requestId, payer, maxSize, expiresIn, attempt: claim.count },
					'issued upload URL'
				);
				return reply.send({
					url: issued.url,
					expiresAt: issued.expiresAt,
					maxFileSize: maxSize,
					reused: false,
				});
			} catch (err) {
				// A failed mint must not consume the payer's attempt — they did nothing wrong.
				store.release(escrow.requestId, claim.count);
				if (err instanceof PinataError) {
					request.log.error({ err: err.message }, 'pinata sign failed');
					return reply.code(502).send({
						error: 'pinata_unavailable',
						message: 'Could not mint an upload URL. The payment is untouched; retry shortly.',
					});
				}
				throw err;
			}
		}
	);
}
