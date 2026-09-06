import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { quasar, transformAssetUrls } from '@quasar/vite-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SDK_DIR = path.resolve(__dirname, '../js') + path.sep;

/**
 * Resolves the SDK's own bare imports (`viem`, `@noble/*`) against *this* package.
 *
 * ../js is pulled in by path, not as a dependency, so Node's algorithm looks for its
 * imports in js/node_modules and upward — never in explorer/node_modules. Locally that
 * happens to work because js/ has been installed for its test suite. A deploy that
 * installs only explorer/ (Vercel, root directory = explorer) has no js/node_modules at
 * all, and the build dies with "Rollup failed to resolve import @noble/hashes/sha2.js".
 *
 * Redirecting to explorer's copies also means one instance of viem in the bundle rather
 * than two, in the local case where both directories are installed.
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
			if (!importer || !importer.startsWith(SDK_DIR)) return null;
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
		// The SDK lives in the sibling ../js package rather than node_modules — it's
		// browser-safe as written (no node: imports), so a plain alias is enough; no
		// workspace link needed for one package.
		alias: {
			'@mnemonad': path.resolve(__dirname, '../js/index.js'),
		},
	},
	server: {
		port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
	},
});
