/**
 * JSON can't carry BigInt, and viem's transaction-request objects use BigInt for gas/value/
 * fee fields — so a transaction going out over `--passkey`'s loopback WebSocket bridge
 * (passkeyBridge.js) to the browser tab is wrapped through this first.
 *
 * Must produce exactly what explorer/src/wallet/bridgeCodec.js's `decodeFromBridge` expects
 * — the two sides are never bundled together (separate packages), so keep them in sync by
 * hand if either changes.
 */
export function encodeForBridge(value) {
	return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? { __bigint__: v.toString() } : v)));
}
