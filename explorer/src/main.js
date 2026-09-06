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

app.mount('#app');
