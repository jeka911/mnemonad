import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import { Quasar, Notify, Dialog, LocalStorage, SessionStorage } from 'quasar';
import { ThemedVarmory, useThemeStore } from 'themed_varmory';
import { WagmiPlugin } from '@wagmi/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import 'quasar/dist/quasar.css';
import '@quasar/extras/material-icons/material-icons.css';
// Outlined variant, reached with the `o_` name prefix. The filled set above
// stays the default; this is for icons sitting next to stroke-style artwork,
// where a filled glyph reads heavier than its neighbours.
import '@quasar/extras/material-icons-outlined/material-icons-outlined.css';
import App from './App.vue';
import routes from './pages';
import { config } from './wagmi';

// Custom Monad theme (see src/themes/monad/*.css). Each loader must resolve to
// the CSS string itself, so unwrap the module's default export.
const monadTheme = {
	common: () => import('./themes/monad/common.css?inline').then((m) => m.default),
	dark: () => import('./themes/monad/dark.css?inline').then((m) => m.default),
	light: () => import('./themes/monad/light.css?inline').then((m) => m.default),
};

const app = createApp(App);
const pinia = createPinia();
const router = createRouter({
	history: createWebHistory('/'),
	routes: routes,
});

// Install Pinia first, before any other plugins that might need it
app.use(pinia);
app.use(router);
app.use(Quasar, { plugins: { Notify, Dialog, LocalStorage, SessionStorage } });

// Default to the dark Monad look. ThemedVarmory's initialize() (run during its
// install below, before mount) reads Quasar's persisted "isDark" and otherwise
// falls back to light — so seed dark here when the user hasn't chosen yet. This
// makes components render dark from the first render, while the header toggle
// still persists an explicit light/dark choice to the same key for next time.
if (LocalStorage.getItem('isDark') === null) {
	const store = useThemeStore();
	setTimeout(() => store.applyTheme('monad', true), 500); // wait for ThemedVarmory to install
	LocalStorage.set('isDark', true);
}

// Now install ThemedVarmory (which depends on Pinia being set up).
// Register the Monad theme alongside the built-ins and make it active.
try {
	app.use(ThemedVarmory, {
		theme: 'monad',
		themes: { monad: monadTheme },
	});
} catch (e) {
	console.error('Error installing ThemedVarmory:', e);
}

// wagmi + vue-query power the wallet connection. reconnectOnMount stays ON (the
// default) so the connector is actually re-instantiated on reload — with it off,
// wagmi hydrates a "connected" state whose connector is a lifeless stub, so
// disconnect() throws "connector.disconnect is not a function". Reconnect reads
// the wallet's *current* chain (it doesn't force one), and we clear the persisted
// session on an explicit disconnect/switch, so no stale chain gets dragged back.
app.use(WagmiPlugin, { config });
app.use(VueQueryPlugin);

// Console/agent shortcut for the wallet picker's "Use a private key instead" card — same
// capability, without clicking through a dialog first. Exists so an automated driver (or a
// person testing by hand) can do `await window.mnemonadConnectWithKey('0x...')` from
// devtools and get back the connected address, rather than typing into a password field
// through the DOM every time.
//
// Registered only when the feature itself is on, and even then only as a function that
// *dynamically* imports its own dependencies at call time — so with the flag unset, neither
// global exists and nothing behind them is ever fetched, matching `WalletConnect.vue`'s lazy
// chunk for the same UI. `connectLocalSigner.js` is the single place enforcing the
// testnet-only gate; both this and the card go through it, so neither can drift out of sync
// with the other's safety check.
if (import.meta.env.VITE_ENABLE_LOCAL_SIGNER === 'true') {
	window.mnemonadConnectWithKey = async (privateKey) => {
		const { connectLocalSigner } = await import('./wallet/connectLocalSigner.js');
		return connectLocalSigner(privateKey);
	};
	// Goes through the Pinia store rather than calling `@wagmi/core`'s `disconnect` action
	// directly. wagmi's own connection persistence can — even mid-session, not just across a
	// reload — replace a connector that was never in its static `connectors` list with a
	// storage-rehydrated stub carrying only `{id, name, type, uid}` and no methods, which
	// makes a raw `disconnect(config)` throw "connector.disconnect is not a function"
	// (`stores/wallet.js` already documents and defends against exactly this, for the same
	// reason, for extension wallets). Reusing that store action means this global inherits
	// the same defense automatically instead of needing its own copy.
	window.mnemonadDisconnect = async () => {
		const { useWalletStore } = await import('./stores/wallet.js');
		await useWalletStore().disconnect();
	};
}

app.mount('#app');
