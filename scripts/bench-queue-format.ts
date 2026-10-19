/**
 * The pure helpers of `scripts/bench-queue.ts`: the statistics and the
 * Markdown it prints. They touch nothing, so `bench-queue.spec.ts` runs them.
 */

/**
 * The nearest-rank percentile of `samples` (`p` from 0 to 1), without
 * reordering them. `NaN` when there are none.
 */
export function percentile(samples: readonly number[], p: number): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	const rank = Math.ceil(p * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

/** `count` things in `ms` milliseconds, as a whole number per second. */
export function perSecond(count: number, ms: number): number {
	return Math.round((count / ms) * 1000);
}

/** A Markdown table: a header row, its rule, then one line per row. */
export function renderTable(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
): string {
	const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
	return [
		line(headers),
		line(headers.map(() => '---')),
		...rows.map(line),
	].join('\n');
}
