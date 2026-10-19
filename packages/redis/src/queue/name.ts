/** The longest a job id or a dedupe key may be. */
export const MAX_NAME = 256;

/** The text of the refusal for a name: an id or a dedupe key. */
export const NAME_RULE = `a string of 1 to ${MAX_NAME} characters without braces, which are a hash tag`;

/**
 * Whether `value` is usable as a job id or a dedupe key: a string of 1 to
 * {@link MAX_NAME} characters without braces, which Redis Cluster reads as a
 * hash tag.
 */
export function isName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_NAME &&
		!value.includes('{') &&
		!value.includes('}')
	);
}
