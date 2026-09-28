/**
 * JSON can't carry BigInt, and viem's transaction-request objects use BigInt for gas/value/
 * fee fields — so a transaction sent over the CLI's loopback WebSocket bridge
 * (cli/lib/passkeyBridge.js, used by `mnemonad ... --passkey`) arrives with those fields
 * wrapped as `{__bigint__: "123"}`. This undoes that wrapping before the transaction is
 * handed to the passkey account's `signTransaction`.
 *
 * Must accept exactly what cli/lib/bridgeCodec.js's `encodeForBridge` produces — the two
 * sides are never bundled together (separate packages), so keep them in sync by hand if
 * either changes.
 */
export function decodeFromBridge(value) {
	if (Array.isArray(value)) return value.map(decodeFromBridge);
	if (value && typeof value === 'object') {
		if (typeof value.__bigint__ === 'string' && Object.keys(value).length === 1) {
			return BigInt(value.__bigint__);
		}
		const out = {};
		for (const [key, v] of Object.entries(value)) out[key] = decodeFromBridge(v);
		return out;
	}
	return value;
}
