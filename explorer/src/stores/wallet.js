import { defineStore } from 'pinia';
import {
	getAccount,
	watchAccount,
	getGasPrice,
	readContract,
	writeContract,
	switchChain,
	waitForTransactionReceipt,
	disconnect as coreDisconnect,
} from '@wagmi/core';
import { bytesToHex } from 'viem';
import { Notify } from 'quasar';
import { config } from '../wagmi';
import BlockNumberEstimator from '../includes/BlockNumberEstimator';
import { getActiveNetwork } from '../settings.js';

// The chain this whole session is pinned to (see settings.js). The wallet's
// actual chain is the user's to control; we only compare against this to detect
// (not force) a mismatch, and every read is pinned to it via the single-chain
// wagmi config so the app reads the right network regardless of the wallet.
const ACTIVE_CHAIN = getActiveNetwork().chain;

// Wipe wagmi's persisted connection (localStorage keys under "wagmi.*") so no
// stale session — importantly its saved chainId — survives a disconnect or a
// network switch to be auto-restored on the next load.
function clearWagmiStorage() {
	try {
		for (let i = localStorage.length - 1; i >= 0; i--) {
			const key = localStorage.key(i);
			if (key && key.indexOf('wagmi') === 0) {
				localStorage.removeItem(key);
			}
		}
	} catch (e) {
		// localStorage unavailable — nothing to clear.
	}
}

// Kept outside reactive state so its timers/handles/buffers aren't proxied by Pinia.
let estimator = null;
let gasTimer = null;

// Gas price changes far slower than the block head — a light poll is plenty.
const GAS_POLL_INTERVAL = 10000;


// Uses @wagmi/core actions (not the Vue composables) so the wallet state lives
// in a store usable from anywhere, independent of component setup context.
export const useWalletStore = defineStore('wallet', {
	state: () => ({
		address: null,
		chainId: null,
		connectorName: null,
		blockNumber: null,
		secondsPerBlock: null,
		gasPrice: null,
		__initialized: false,
	}),
	getters: {
		isConnected: function() {
			return !!this.address;
		},
		// True once connected if the wallet's actual chain doesn't match the
		// network this session is pinned to (see ACTIVE_CHAIN above) — e.g. a
		// reconnect restored it on a stale chain. Writes must refuse while true.
		wrongNetwork: function() {
			return this.isConnected && this.chainId !== ACTIVE_CHAIN.id;
		},
		formattedAddress: function() {
			if (!this.address) {
				return '';
			}
			return '' + this.address.slice(0, 6) + '...' + this.address.slice(-4);
		},
		blockNumberString: function() {
			return this.blockNumber === null ? '' : '' + this.blockNumber;
		},
		connectionId: function() { // using this to watch
			return '' + this.address + '_' + this.chainId;
		},
		chainName: function() {
			const chain = config.chains.find((c) => c.id === this.chainId) || config.chains[0];
			return chain ? chain.name : '';
		},
		// Gas price in gwei, trimmed to a readable precision.
		gasPriceGwei: function() {
			if (this.gasPrice === null) {
				return '';
			}
			const gwei = Number(this.gasPrice) / 1e9;
			return gwei.toLocaleString('en-US', { maximumFractionDigits: 2 });
		},
	},
	actions: {
		init() {
			if (this.__initialized) {
				return;
			}
			this.__initialized = true;

			// Seed from the current account, then keep in sync with every change
			// (connect, disconnect, account switch, chain switch).
			this.sync(getAccount(config));
			watchAccount(config, { onChange: (account) => this.sync(account) });

			estimator = new BlockNumberEstimator({
				config,
				onBlockNumber: (blockNumber) => {
					this.blockNumber = blockNumber;
				},
				onSecondsPerBlock: (secondsPerBlock) => {
					this.secondsPerBlock = secondsPerBlock;
				},
			});
			estimator.start();

			// Poll gas price alongside the block estimator.
			this.fetchGasPrice();
			gasTimer = setInterval(() => this.fetchGasPrice(), GAS_POLL_INTERVAL);
		},
		sync(account) {
			this.address = account.address || null;
			this.chainId = account.chainId || null;
			this.connectorName = account.connector ? account.connector.name : null;
		},
		// Force a fresh read of the connector's account/chain rather than waiting
		// on wagmi's account watcher — used right after switchChain() resolves,
		// since the watcher doesn't reliably fire in time for our own `wrongNetwork`
		// check to clear immediately (it was still reporting the old chain after
		// a successful switch).
		refreshAccount() {
			this.sync(getAccount(config));
		},
		// The "Switch network" button. Tries wagmi's switchChain first; if the
		// connector claims it's unsupported (some wallets like Rabby wrongly do,
		// even though they honor the raw request), falls back to the EIP-3326
		// wallet_switchEthereumChain call straight on the provider — adding the
		// chain first if the wallet doesn't know it yet. watchAccount picks up the
		// resulting chain change and clears the mismatch banner on its own.
		async switchToActiveChain() {
			try {
				await switchChain(config, { chainId: ACTIVE_CHAIN.id });
				this.refreshAccount();
				return;
			} catch (e) {
				if (e?.name !== 'SwitchChainNotSupportedError') {
					Notify.create({
						type: 'negative',
						message: e?.shortMessage || e?.message || 'Failed to switch network — switch it manually in your wallet.',
						timeout: 6000,
					});
					return;
				}
			}
			// Fallback: raw provider request (what the connector wrongly refused).
			const ok = await this.requestWalletChain(ACTIVE_CHAIN);
			if (ok) {
				this.refreshAccount();
			} else {
				Notify.create({
					type: 'negative',
					message: 'Failed to switch network — switch to ' + ACTIVE_CHAIN.name + ' manually in your wallet.',
					timeout: 6000,
				});
			}
		},
		// Ask the connected wallet to switch to a given viem chain via the raw
		// EIP-3326 request (adding it first if unknown). Works even for a chain
		// that isn't in the current wagmi config, and on wallets whose connector
		// wrongly refuses wagmi's switchChain (e.g. Rabby). Best-effort: resolves
		// true on success, false if there's no provider or the wallet declined.
		async requestWalletChain(chain) {
			try {
				const account = getAccount(config);
				const provider = account.connector ? await account.connector.getProvider() : null;
				if (!provider) {
					return false;
				}
				const hexId = '0x' + chain.id.toString(16);
				try {
					await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
				} catch (switchErr) {
					// 4902 = the wallet doesn't have this chain yet; add it (which
					// also makes it active).
					if (switchErr?.code === 4902) {
						await provider.request({
							method: 'wallet_addEthereumChain',
							params: [{
								chainId: hexId,
								chainName: chain.name,
								nativeCurrency: chain.nativeCurrency,
								rpcUrls: chain.rpcUrls.default.http,
								blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
							}],
						});
					} else {
						throw switchErr;
					}
				}
				return true;
			} catch (e) {
				return false;
			}
		},
		async disconnect() {
			try {
				await coreDisconnect(config);
			} catch (e) {
				// A hydrated/partial connector may lack a real disconnect method
				// ("connector.disconnect is not a function"); ignore and force a
				// clean local reset below regardless.
			}
			// Forget the persisted session entirely, so a later reload (or a
			// network switch) starts clean and can't restore a stale chainId that
			// would drag the wallet back onto the wrong network.
			clearWagmiStorage();
			this.sync(getAccount(config));
		},
		fetchBlockNumber() {
			return estimator ? estimator.fetchNow() : null;
		},
		async fetchGasPrice() {
			try {
				this.gasPrice = await getGasPrice(config);
			} catch (e) {
				// Leave the last known value in place on transient RPC errors.
			}
		},
	},
});
