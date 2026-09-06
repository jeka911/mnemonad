import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { quasar, transformAssetUrls } from '@quasar/vite-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [
		vue({ template: { transformAssetUrls } }),
		quasar({ autoImportComponentCase: 'combined' }),
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
