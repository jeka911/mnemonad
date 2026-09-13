import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { quasar, transformAssetUrls } from '@quasar/vite-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Both pulled in by path, not as pnpm dependencies — see resolveSdkDeps' own doc for why
// that needs this redirect at all.
const SDK_DIRS = [
	path.resolve(__dirname, '../js') + path.sep,
	path.resolve(__dirname, '../monadsync') + path.sep,
];

/**
 * Resolves the SDK's own bare imports (`viem`, `@noble/*`, `@fizzyflow/doublesync`, ...)
 * against *this* package.
 *
 * ../js and ../monadsync are pulled in by path, not as dependencies, so Node's algorithm
 * looks for their imports in js/node_modules (or monadsync/node_modules) and upward — never
 * in explorer/node_modules. Locally that happens to work because each has been installed
 * for its own test suite. A deploy that installs only explorer/ (Vercel, root directory =
 * explorer) has no js/node_modules or monadsync/node_modules at all, and the build dies
 * with e.g. "Rollup failed to resolve import @noble/hashes/sha2.js" or "... fflate" — hit
 * twice already this way (mnemonad's own `fflate` dependency, in both explorer/ and
 * presign-server/) before this list grew a second entry.
 *
 * Redirecting to explorer's copies also means one instance of each shared dep (viem,
 * @fizzyflow/doublesync) in the bundle rather than two, in the local case where all
 * directories are installed.
 *
 * Scoped by importer instead of a `resolve.alias` entry so that the app's own `viem`
 * imports keep resolving through the package's `exports` map exactly as before — an
 * alias to a directory would silently downgrade them to `main`/`module` fields.
 */
function resolveSdkDeps() {
	// Any path inside explorer/ serves as the stand-in importer; resolution only uses its
	// directory to decide where the node_modules walk starts.
	const proxyImporter = path.resolve(__dirname, 'index.html');
	return {
		name: 'mnemonad-sdk-deps',
		enforce: 'pre',
		async resolveId(source, importer, options) {
			if (!importer || !SDK_DIRS.some((dir) => importer.startsWith(dir))) return null;
			// Relative, absolute and virtual ids resolve fine on their own.
			if (source[0] === '.' || source[0] === '/' || source[0] === '\0') return null;
			return this.resolve(source, proxyImporter, { ...options, skipSelf: true });
		},
	};
}

export default defineConfig({
	plugins: [
		vue({ template: { transformAssetUrls } }),
		quasar({ autoImportComponentCase: 'combined' }),
		resolveSdkDeps(),
	],
	resolve: {
		// Both SDKs live in sibling packages rather than node_modules — they're browser-safe
		// as written (no node: imports), so a plain alias is enough for each; no workspace
		// link needed.
		alias: {
			'@mnemonad': path.resolve(__dirname, '../js/index.js'),
			'@monadsync': path.resolve(__dirname, '../monadsync/index.js'),
		},
	},
	server: {
		port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
	},
});
