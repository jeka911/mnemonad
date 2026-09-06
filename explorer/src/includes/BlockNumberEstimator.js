import { getBlockNumber } from '@wagmi/core';

// Estimates the chain's current block number without polling every block.
// It samples the real block number occasionally and interpolates in between:
// the reported blockNumber only ever moves by +1 (never jumps), but the tick
// RATE adapts — faster when the real head is ahead, paused when we've drifted
// ahead (so it never goes backward). Changes are pushed out via callbacks.
const BOOTSTRAP_OFFSETS = [1000, 2000, 5000, 10000, 15000];
const STEADY_RESYNC_INTERVAL = 10000;
const DEFAULT_SECONDS_PER_BLOCK = 0.3;
const MIN_SECONDS_PER_BLOCK = 0.2;
const EMA_ALPHA = 0.4; // weight of the newest measurement when tuning K
const MAX_SPEEDUP = 25; // cap on how many times faster than K we may tick
const MIN_STEP_MS = 20; // floor on the tick interval

export default class BlockNumberEstimator {
	constructor({ config, onBlockNumber = () => {}, onSecondsPerBlock = () => {} }) {
		this.config = config;
		this.onBlockNumber = onBlockNumber;
		this.onSecondsPerBlock = onSecondsPerBlock;

		this.blockNumber = null;
		this.secondsPerBlock = null;
		this.started = false;

		this._lastSample = null;
		this._tickTimer = null;
		this._resyncTimer = null;
		this._bootstrapTimers = [];
	}

	async start() {
		if (this.started) {
			return;
		}
		this.started = true;

		// Initial real sample, then a few quick ones to learn the block time.
		await this.resync();
		this._bootstrapTimers = BOOTSTRAP_OFFSETS.map((offset) =>
			setTimeout(() => this.resync(), offset)
		);

		// Afterwards, only check the chain rarely — interpolation fills the gap.
		this._resyncTimer = setInterval(() => this.resync(), STEADY_RESYNC_INTERVAL);

		this._scheduleTick();
	}

	stop() {
		this._bootstrapTimers.forEach((timer) => clearTimeout(timer));
		this._bootstrapTimers = [];
		if (this._resyncTimer) {
			clearInterval(this._resyncTimer);
			this._resyncTimer = null;
		}
		if (this._tickTimer) {
			clearTimeout(this._tickTimer);
			this._tickTimer = null;
		}
		this.started = false;
	}

	async fetchNow() {
		const block = await getBlockNumber(this.config, { cacheTime: 0 });
		this._applySample(block);
		return block;
	}

	async resync() {
		let block;
		try {
			block = await getBlockNumber(this.config, { cacheTime: 0 });
		} catch (e) {
			return;
		}
		this._applySample(block);
	}

	_setBlockNumber(value) {
		this.blockNumber = value;
		this.onBlockNumber(value);
	}

	_setSecondsPerBlock(value) {
		this.secondsPerBlock = value;
		this.onSecondsPerBlock(value);
	}

	_applySample(block) {
		const now = Date.now();
		if (this._lastSample) {
			const elapsed = (now - this._lastSample.at) / 1000;
			const delta = Number(block - this._lastSample.block);
			if (elapsed > 0 && delta > 0) {
				const measured = elapsed / delta;
				const next =
					this.secondsPerBlock === null
						? measured
						: EMA_ALPHA * measured + (1 - EMA_ALPHA) * this.secondsPerBlock;
				this._setSecondsPerBlock(Math.max(MIN_SECONDS_PER_BLOCK, next));
			}
		} else if (this.secondsPerBlock === null) {
			this._setSecondsPerBlock(DEFAULT_SECONDS_PER_BLOCK);
		}

		this._lastSample = { at: now, block };
		// Seed the display on the very first sample; never snap afterwards so the
		// number only ever advances by +1 (the ticker catches up).
		if (this.blockNumber === null) {
			this._setBlockNumber(block);
		}
	}

	// Estimated real chain head right now, from the last sample + elapsed time.
	_estimatedHead() {
		if (!this._lastSample) {
			return this.blockNumber;
		}
		const k = this.secondsPerBlock || DEFAULT_SECONDS_PER_BLOCK;
		// Round (not floor) so the estimate centers on the real head instead of
		// sitting ~half a block behind it.
		const elapsedBlocks = Math.round(
			(Date.now() - this._lastSample.at) / 1000 / k
		);
		return this._lastSample.block + BigInt(elapsedBlocks);
	}

	_scheduleTick() {
		if (this._tickTimer) {
			clearTimeout(this._tickTimer);
			this._tickTimer = null;
		}

		const k = this.secondsPerBlock || DEFAULT_SECONDS_PER_BLOCK;
		let gap = 0;
		if (this.blockNumber !== null) {
			gap = Number(this._estimatedHead() - this.blockNumber);
		}

		// Behind → tick faster (still +1 per tick); caught up → wait ~one block.
		let interval = k * 1000;
		if (gap > 0) {
			interval = Math.max(MIN_STEP_MS, (k * 1000) / Math.min(gap, MAX_SPEEDUP));
		}

		this._tickTimer = setTimeout(() => this._tick(), interval);
	}

	_tick() {
		if (this.blockNumber !== null && this.blockNumber < this._estimatedHead()) {
			this._setBlockNumber(this.blockNumber + 1n);
		}
		this._scheduleTick();
	}
}
