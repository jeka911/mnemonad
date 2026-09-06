import { formatEther } from 'viem';

// MON amounts here span many orders of magnitude, and a flat 6-decimal format
// would round the small end straight to "0.000000" and hide it entirely. So
// tiny nonzero values get extra significant digits instead of disappearing.
export function formatMon(wei) {
	const n = Number(formatEther(wei));
	if (n === 0) {
		return '0';
	}
	if (n >= 0.000001) {
		return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
	}
	const decimals = Math.min(18, -Math.floor(Math.log10(n)) + 2);
	return n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

export default formatMon;
