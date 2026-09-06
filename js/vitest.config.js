import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
	test: {
		// Each suite boots a Hardhat node and deploys a registry, so give it room.
		testTimeout: 120_000,
		hookTimeout: 180_000,
		// Suites share one local node and one port; running them in parallel would clash.
		fileParallelism: false,
		// real_ipfs.test.js hits a real Pinata account and spends real quota — opt-in only,
		// via `npm run test:real-ipfs`, never as part of the default glob. Excluding it here
		// (not just its own describe.skipIf) means it stays out of `npm test` even on a
		// machine that already has js/.env configured for it.
		exclude: [...configDefaults.exclude, 'test/real_ipfs.test.js'],
	},
});
