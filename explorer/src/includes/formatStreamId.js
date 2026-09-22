/**
 * Shortens a stream id for display.
 *
 * Ids are ERC-721 token ids: 77 digits of decimal, unreadable and impossible to tell apart
 * at a glance. Hex-padding to the full 32 bytes and eliding the middle keeps them scannable
 * while what's shown is still the actual id — the same shape the block explorer and the
 * rest of this app use for a hash.
 *
 * Shared so every place that shows an id shortens it identically: a row in a stream list
 * and the file browser's own header must be comparable at a glance, which they aren't if
 * each keeps its own slice lengths.
 *
 * @param {string|bigint} id Decimal stream id.
 * @returns {string} e.g. `0x453a1f...f3c8`.
 */
export function formatStreamId(id) {
	const hex = BigInt(id).toString(16).padStart(64, '0');
	return `0x${hex.slice(0, 6)}...${hex.slice(-4)}`;
}
