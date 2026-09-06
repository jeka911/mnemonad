import { defineConfig } from 'vitest/config';

// Separate from vitest.config.js on purpose: that config excludes real_ipfs.test.js so it
// never rides along on the default `npm test` glob (vitest's exclude wins over an explicit
// CLI file argument, so there is no way to reach this file through the main config at all).
// This one exists solely so `npm run test:real-ipfs` has a config that doesn't exclude it.
export default defineConfig({
	test: {
		include: ['test/real_ipfs.test.js'],
		testTimeout: 120_000,
		hookTimeout: 180_000,
	},
});
