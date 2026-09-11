import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Each suite boots a Hardhat node and deploys a registry (via ../js/test/fixture.js),
		// so give it room — DoubleSync's own CDC work on top of that is not the bottleneck.
		testTimeout: 120_000,
		hookTimeout: 180_000,
		// Suites share one local node and one port per file; running files in parallel would
		// clash, same reasoning as js/vitest.config.js.
		fileParallelism: false,
		include: ['test/**/*.test.js'],
	},
});
