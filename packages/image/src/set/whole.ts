/** Whether the value is a whole number from `min` (default 0) to `max` (default: no limit). */
export function isWhole(
	value: unknown,
	min = 0,
	max = Number.POSITIVE_INFINITY,
): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= min &&
		value <= max
	);
}
