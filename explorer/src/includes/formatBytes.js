/**
 * Human-readable byte size, e.g. formatBytes(1536) -> '1.5 KB'.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = units[0];
	for (let i = 1; i < units.length && value >= 1024; i += 1) {
		value /= 1024;
		unit = units[i];
	}
	return `${value.toFixed(1)} ${unit}`;
}
