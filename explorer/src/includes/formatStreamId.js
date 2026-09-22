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
	return `0x${fullHex(id).slice(0, 6)}...${fullHex(id).slice(-4)}`;
}

/**
 * The full, unelided form: `0x` + all 64 hex digits. For anywhere the id has to actually be
 * *used* rather than just recognized — a command to copy-paste, a folder name — where the
 * elided form above would paste back in broken. Matches `mnemonad-cli`'s own id formatting
 * (`cli/lib/commands/shared.js`'s `formatStreamId`) exactly, so an id shown by either tool
 * reads identically.
 *
 * @param {string|bigint} id Decimal stream id.
 * @returns {string} e.g. `0x00000000000000000000000000000000000000000000000000000000000000ab`.
 */
export function fullStreamIdHex(id) {
	return `0x${fullHex(id)}`;
}

function fullHex(id) {
	return BigInt(id).toString(16).padStart(64, '0');
}
