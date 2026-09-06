import { verifyTypedData, getAddress } from 'viem';

/**
 * EIP-712 types for an upload-URL request.
 *
 * Signed off-chain only — no contract ever sees this. Its single job is proving the
 * requester controls `payer`, because `requestId` is emitted publicly in `UploadPaid` and
 * would otherwise be a bearer token: anyone watching the chain could claim the URL bought
 * by someone else's payment.
 */
export const UPLOAD_REQUEST_TYPES = {
	UploadRequest: [
		{ name: 'payer', type: 'address' },
		{ name: 'contentHash', type: 'bytes32' },
		{ name: 'size', type: 'uint64' },
		{ name: 'deadline', type: 'uint64' },
	],
};

/**
 * Domain-separated by chainId *and* the gateway address, so one signature cannot be
 * replayed against another network or against a future redeployed gateway.
 */
export function uploadRequestDomain({ chainId, gatewayAddress }) {
	return {
		name: 'MnemonadUploadGateway',
		version: '1',
		chainId,
		verifyingContract: getAddress(gatewayAddress),
	};
}

/**
 * The exact payload a client must sign. Exported so the SDK/explorer and the tests build it
 * from one definition rather than two that can drift.
 */
export function buildUploadRequestTypedData({ chainId, gatewayAddress, payer, contentHash, size, deadline }) {
	return {
		domain: uploadRequestDomain({ chainId, gatewayAddress }),
		types: UPLOAD_REQUEST_TYPES,
		primaryType: 'UploadRequest',
		message: {
			payer: getAddress(payer),
			contentHash,
			size: BigInt(size),
			deadline: BigInt(deadline),
		},
	};
}

/**
 * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
 *   A result rather than a thrown error: every failure here is a client mistake that maps
 *   to a 400/401, and distinguishing them by code keeps the route free of error-parsing.
 */
export async function verifyUploadRequest(params) {
	const { chainId, gatewayAddress, payer, contentHash, size, deadline, signature, now, maxWindowSeconds } = params;

	if (deadline <= now) {
		return { ok: false, code: 'deadline_passed', message: 'Signature deadline has already passed.' };
	}
	// A far-future deadline is a signature that stays valid indefinitely — bound it, so a
	// leaked signature has a short useful life.
	if (deadline > now + maxWindowSeconds) {
		return {
			ok: false,
			code: 'deadline_too_far',
			message: `Signature deadline must be within ${maxWindowSeconds}s.`,
		};
	}

	let valid = false;
	try {
		valid = await verifyTypedData({
			address: getAddress(payer),
			...buildUploadRequestTypedData({ chainId, gatewayAddress, payer, contentHash, size, deadline }),
			signature,
		});
	} catch (err) {
		return { ok: false, code: 'bad_signature', message: `Signature could not be verified: ${err.message}` };
	}

	if (!valid) {
		return {
			ok: false,
			code: 'bad_signature',
			message: 'Signature does not match `payer` for this request.',
		};
	}
	return { ok: true };
}
