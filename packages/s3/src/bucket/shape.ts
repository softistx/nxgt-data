/**
 * A value's shape, for a message: an option can come off a request body,
 * and a message reports what it was, never what it held.
 */
export function shapeOf(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return 'an array';
	if (typeof value === 'number') {
		if (Number.isNaN(value)) return 'NaN';
		if (!Number.isFinite(value)) return 'an infinite number';
		if (!Number.isInteger(value)) return 'a fraction';
		if (value === 0) return 'zero';
		if (value < 0) return 'a negative number';
		return Number.isSafeInteger(value) ? 'a number' : 'a number too large';
	}
	return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
