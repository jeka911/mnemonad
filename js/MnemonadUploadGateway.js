import { keccak256, encodeAbiParameters } from 'viem';
import { uploadGatewayAbi } from './gatewayAbi.js';

/**
 * Client for `MnemonadUploadGateway` — the paid-upload escrow that prices off-chain
 * storage in MON via Pyth's MON/USD feed.
 *
 * The flow it exists to support:
 *   1. {quote} the cost for a payload of up to N bytes.
 *   2. {payForUpload} escrows that MON, committed to the payload's exact sha256.
 *   3. Something uploads the bytes — see `MnemonadPresignProvider`, which trades this
 *      escrow for a one-shot upload URL from a server holding the pinning credential.
 *   4. `Mnemonad.push` commits the pointer, and the registry settles the escrow against
 *      `Pointer.hash` — waiving its own EXTERNAL fee because the upload was prepaid.
 *
 * Deliberately a separate class rather than methods on `Mnemonad`: the registry works
 * perfectly well with no gateway wired, and the SDK should not imply otherwise. Discover
 * one with {fromMnemonad}, which reads the registry's own `uploadGateway()` so the address
 * can never drift from what the contract actually honours.
 */
export default class MnemonadUploadGateway {
	/**
	 * @param {Object} params
	 * @param {import('viem').PublicClient} params.publicClient
	 * @param {string} params.address
	 * @param {?import('viem').WalletClient} [params.walletClient]
	 * @param {?string} [params.senderAddress] - defaults to the wallet client's account.
	 */
	constructor(params = {}) {
		if (!params.publicClient) throw new Error('MnemonadUploadGateway: publicClient is required');
		if (!params.address) throw new Error('MnemonadUploadGateway: address is required');

		this.publicClient = params.publicClient;
		this.address = params.address;
		this.walletClient = params.walletClient || null;
		this._senderAddress = params.senderAddress || this.walletClient?.account?.address || null;
	}

	/**
	 * Resolves the gateway a registry actually honours, or null when none is wired.
	 *
	 * @param {import('./Mnemonad.js').default} mnemonad
	 * @param {Object} [params={}] - extra constructor params (walletClient, senderAddress).
	 * @returns {Promise<?MnemonadUploadGateway>}
	 */
	static async fromMnemonad(mnemonad, params = {}) {
		const address = await mnemonad.uploadGateway();
		if (!address || /^0x0+$/i.test(address)) return null;
		return new MnemonadUploadGateway({ publicClient: mnemonad.publicClient, address, ...params });
	}

	/** @returns {boolean} True iff this instance can send transactions. */
	get isWritable() {
		return !!(this.walletClient && this._senderAddress);
	}

	async _read(functionName, args = []) {
		return await this.publicClient.readContract({
			address: this.address,
			abi: uploadGatewayAbi,
			functionName,
			args,
		});
	}

	/**
	 * MON required to buy quota for a payload of up to `size` bytes.
	 *
	 * @param {number|bigint} size
	 * @returns {Promise<bigint>} wei
	 * @throws Reverts as `BadPrice`/`ConfidenceTooWide`/`RateOutOfBand`, or Pyth's own
	 *   `StalePrice`, rather than quoting off a price the contract will not honour — so a
	 *   successful quote is also a statement that the oracle is currently trustworthy.
	 */
	async quote(size) {
		return await this._read('quote', [BigInt(size)]);
	}

	/** @returns {Promise<bigint>} Current MON-per-MiB rate, derived live from Pyth. */
	async weiPerMiB() {
		return await this._read('weiPerMiB');
	}

	/** @returns {Promise<{usdCentsPerMiB: bigint, minChargeWei: bigint, paused: boolean, maxPriceAge: bigint, requestTtl: bigint}>} */
	async config() {
		const [usdCentsPerMiB, minChargeWei, paused, maxPriceAge, requestTtl] = await Promise.all([
			this._read('usdCentsPerMiB'),
			this._read('minChargeWei'),
			this._read('paused'),
			this._read('maxPriceAge'),
			this._read('requestTtl'),
		]);
		return { usdCentsPerMiB, minChargeWei, paused, maxPriceAge, requestTtl };
	}

	/** @returns {Promise<{escrowed: bigint, revenue: bigint}>} */
	async balances() {
		const [escrowed, revenue] = await Promise.all([this._read('escrowed'), this._read('revenue')]);
		return { escrowed, revenue };
	}

	/**
	 * Deterministic request id, mirroring the contract's `requestIdFor`.
	 *
	 * Computed locally rather than read on-chain. The contract's version is `pure`, so an
	 * eth_call for it is a round trip that returns a value we can derive for free — and it
	 * doubled the RPC calls behind {requestFor}, which matters for a server answering many
	 * requests against a rate-limited endpoint. Verified byte-identical against the
	 * deployed contract.
	 *
	 * @param {string} payer @param {string} contentHash - 0x-prefixed sha256
	 * @returns {string}
	 */
	requestIdFor(payer, contentHash) {
		return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [payer, contentHash]));
	}

	/**
	 * Escrow state for a (payer, content) pair. `amount === 0n` means no open request.
	 * @param {string} payer @param {string} contentHash
	 * @returns {Promise<{requestId: string, amount: bigint, maxSize: bigint, expiry: bigint, exists: boolean}>}
	 */
	async requestFor(payer, contentHash) {
		const requestId = this.requestIdFor(payer, contentHash);
		const [amount, maxSize, expiry] = await this._read('requests', [requestId]);
		return { requestId, amount, maxSize, expiry, exists: amount > 0n };
	}

	/**
	 * Escrows payment for uploading `contentHash`, up to `maxSize` bytes.
	 *
	 * @param {string} contentHash - 0x-prefixed sha256 of the exact payload
	 * @param {number|bigint} maxSize - paid ceiling in bytes
	 * @param {Object} [params={}]
	 * @param {?bigint} [params.value] - defaults to a fresh {quote}. Overpayment is escrowed
	 *   and stays refundable, so a small buffer against price movement is safe.
	 * @returns {Promise<string>} transaction hash
	 */
	async payForUpload(contentHash, maxSize, params = {}) {
		this._requireWritable();
		const value = params.value ?? (await this.quote(maxSize));
		return await this._write('payForUpload', [contentHash, BigInt(maxSize)], value, params);
	}

	/**
	 * {payForUpload} preceded by pushing signed Hermes data into Pyth, in one transaction.
	 * Only needed when the on-chain price is older than `maxPriceAge`; on testnet, where
	 * that bound is deliberately loose, it usually is not.
	 *
	 * @param {string[]} updateData - hex payloads from Hermes
	 * @param {string} contentHash @param {number|bigint} maxSize
	 * @param {Object} params - `value` must cover Pyth's update fee plus the quote.
	 */
	async payForUploadWithUpdate(updateData, contentHash, maxSize, params = {}) {
		this._requireWritable();
		if (params.value === undefined) {
			throw new Error(
				'payForUploadWithUpdate: `value` is required — it must cover Pyth\'s update fee ' +
				'plus the quote, and the fee is only knowable from the update data.'
			);
		}
		return await this._write(
			'payForUploadWithUpdate',
			[updateData, contentHash, BigInt(maxSize)],
			params.value,
			params
		);
	}

	/**
	 * Reclaims an expired, unconsumed payment. Permissionless — funds always go to `payer`,
	 * so anyone may trigger it on their behalf.
	 * @param {string} payer @param {string} contentHash
	 */
	async refund(payer, contentHash) {
		this._requireWritable();
		return await this._write('refund', [payer, contentHash], 0n);
	}

	/** Pushes signed Hermes price data into Pyth. @param {string[]} updateData */
	async pushPriceUpdate(updateData, params = {}) {
		this._requireWritable();
		return await this._write('pushPriceUpdate', [updateData], params.value ?? 0n, params);
	}

	async _write(functionName, args, value, params = {}) {
		const hash = await this.walletClient.writeContract({
			address: this.address,
			abi: uploadGatewayAbi,
			functionName,
			args,
			value,
			account: this.walletClient.account ?? this._senderAddress,
			// viem reads three distinct meanings here, and the difference decides whether a
			// write is even attempted: a chain object asserts the wallet is on that network,
			// `null` deliberately waives that assertion, and `undefined` falls back to
			// `walletClient.chain`. A wagmi wallet client does not always carry one, and when
			// it doesn't the call fails with "No chain was provided to the request" before
			// reaching the wallet at all. So take whichever client knows the chain — the
			// public client always does — and waive the check only if neither does, matching
			// `Mnemonad._write`.
			chain: this.walletClient.chain ?? this.publicClient?.chain ?? null,
		});
		if (params.wait === false) return hash;
		const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
		if (receipt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
		return hash;
	}

	_requireWritable() {
		if (!this.isWritable) {
			throw new Error('MnemonadUploadGateway is not writable: walletClient is required');
		}
	}
}
