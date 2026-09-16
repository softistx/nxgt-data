/**
 * A value as a string whose object keys are sorted, so that two documents
 * MongoDB may hand back in another key order compare equal. Arrays keep
 * their order: in an index key or a validator, order means something.
 */
export function canonical(value: unknown): string {
	return JSON.stringify(value ?? null, (_name, inner) =>
		inner && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
				)
			: inner,
	);
}
