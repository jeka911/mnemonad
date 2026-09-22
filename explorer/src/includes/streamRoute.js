/**
 * The stream part of a URL: `/stream/testnet-0x648f18…3ac8`.
 *
 * A stream id alone doesn't identify a stream — the same ERC-721 token id can exist on both
 * networks and mean two different things, and the app's network is otherwise a localStorage
 * choice the URL knows nothing about. So a link that travels (pasted into chat, bookmarked,
 * opened by someone whose app is on the other network) has to carry the network with it,
 * which is what the `<network>-` prefix is for. The id itself is hex here rather than the 77
 * digits of decimal it is on chain: it's what the rest of the app shows, and it's the half
 * of the token that a person actually compares.
 *
 * Bare ids — decimal or hex, no prefix — still parse, because links in that older shape are
 * already out in the world. They're read as "whatever network this app is on" and rewritten
 * to the canonical form on arrival (see `syncStreamRouteNetwork`).
 */
import { NETWORKS, getActiveNetworkId, setActiveNetworkId } from '../settings.js';

const HEX_ID = /^0x[0-9a-f]+$/i;
const DECIMAL_ID = /^[0-9]+$/;

/**
 * The route param for one stream: `testnet-0x…` (64 hex digits, zero-padded).
 *
 * @param {string|bigint} id Stream id, decimal or hex.
 * @param {string} [networkId] Defaults to the network the app is currently on.
 */
export function streamRouteId(id, networkId = getActiveNetworkId()) {
	const hex = BigInt(id).toString(16).padStart(64, '0');
	return `${networkId}-0x${hex}`;
}

/**
 * A full path to a stream page — the one place URLs for it are built, so no caller has to
 * remember that the param isn't just the id anymore.
 *
 * @param {string|bigint} id Stream id, decimal or hex.
 * @param {{networkId?: string, files?: boolean}} [options] `files` targets the file browser.
 */
export function streamPath(id, { networkId, files = false } = {}) {
	return `/stream/${streamRouteId(id, networkId || getActiveNetworkId())}${files ? '/files' : ''}`;
}

/**
 * Reads a `:id` route param back.
 *
 * @param {string} param
 * @returns {{networkId: string|null, id: bigint}|null} `networkId` is null for a bare id
 *   (an older link, which says nothing about the network); null overall when the param
 *   isn't a stream id at all.
 */
export function parseStreamRouteId(param) {
	if (typeof param !== 'string' || !param) return null;

	let networkId = null;
	let raw = param;
	const dash = param.indexOf('-');
	if (dash !== -1) {
		const prefix = param.slice(0, dash).toLowerCase();
		// An unknown prefix is not a stream on some network this build hasn't heard of — it's
		// a malformed URL, and saying so beats loading the wrong chain's stream of that id.
		if (!NETWORKS[prefix]) return null;
		networkId = prefix;
		raw = param.slice(dash + 1);
	}

	if (!HEX_ID.test(raw) && !DECIMAL_ID.test(raw)) return null;
	try {
		return { networkId, id: BigInt(raw) };
	} catch {
		return null;
	}
}

/**
 * Brings the URL and the app's network into agreement, before a stream page loads anything.
 *
 * The URL wins: it's the more specific statement of intent (someone opened *this* link),
 * and the alternative — loading the active network's stream of that id — silently shows the
 * wrong stream, or more often a revert, with nothing on screen explaining why.
 *
 * @param {import('vue-router').RouteLocationNormalized} route
 * @param {import('vue-router').Router} router
 * @param {{networkId: string|null, id: bigint}} parsed From `parseStreamRouteId`.
 * @returns {boolean} True when a redirect or reload is under way and the caller should not
 *   load anything — the page is about to render again against the corrected URL.
 */
export function syncStreamRouteNetwork(route, router, parsed) {
	const active = getActiveNetworkId();
	const files = route.path.endsWith('/files');

	// An older, bare id: adopt the current network and rewrite the URL to the canonical form,
	// so what's in the address bar is shareable even though what was opened wasn't. `replace`,
	// not `push` — the un-prefixed URL isn't a place worth going Back to.
	if (parsed.networkId === null) {
		router.replace({
			path: streamPath(parsed.id, { networkId: active, files }),
			query: route.query,
			hash: route.hash,
		});
		return true;
	}

	// The link is for the other network. Switching stores the choice and reloads, which is
	// what rebuilds wagmi's config and every contract address against it (see settings.js) —
	// the URL already says the right thing, so it survives the reload as-is.
	if (parsed.networkId !== active) {
		setActiveNetworkId(parsed.networkId);
		return true;
	}

	return false;
}
