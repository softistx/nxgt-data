import type { z } from 'zod';
import type { IdempotencyDefinition } from './types';

/** How long the in-flight marker lives when a definition says nothing. */
export const DEFAULT_LEASE = 10_000;

const isCount = (n: unknown): n is number =>
	typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

/**
 * The checks `defineIdempotency` makes, named after the call that made them —
 * `bindIdempotency` makes them too, for a definition written by hand.
 */
export function checkIdempotency<P, S extends z.ZodType>(
	definition: IdempotencyDefinition<P, S>,
	call: string,
): void {
	const { name, ttl, lease } = definition;
	if (typeof name !== 'string' || name.length === 0) {
		throw new TypeError(
			`${call}: an idempotent operation needs a name, for its keys`,
		);
	}
	if (typeof definition.key !== 'function') {
		throw new TypeError(
			`${call}: "${name}" has no key function; it builds the rest of the key from the params`,
		);
	}
	if (!isCount(ttl)) {
		throw new TypeError(
			`${call}: "${name}" has a ttl of ${ttl}; it is a whole number of seconds, and must be at least 1`,
		);
	}
	if (lease !== undefined && !isCount(lease)) {
		throw new TypeError(
			`${call}: "${name}" has a lease of ${lease}; it is a whole number of milliseconds, and must be at least 1`,
		);
	}
	if (typeof definition.schema?.safeParse !== 'function') {
		throw new TypeError(
			`${call}: "${name}" has no schema; a stored result is checked against one both ways`,
		);
	}
}

/**
 * Describes an idempotent operation. It talks to nothing:
 * `bindIdempotency` is what needs a client.
 *
 * ```ts
 * export const createOrder = defineIdempotency({
 * 	name: 'orders.create',
 * 	key: (p: { user: string; key: string }) => `${p.user}/${p.key}`,
 * 	ttl: 86_400,                   // seconds a result is replayed
 * 	lease: 30_000,                 // milliseconds a crashed run holds the key
 * 	schema: z.object({ orderId: z.string() }),
 * });
 * ```
 *
 * A definition that could never work is a bare `TypeError`, thrown here —
 * normally at import. Its values are the code's, not a request's, so the
 * message quotes them.
 */
export function defineIdempotency<P, S extends z.ZodType>(
	definition: IdempotencyDefinition<P, S>,
): IdempotencyDefinition<P, S> {
	checkIdempotency(definition, 'defineIdempotency');
	return Object.freeze({ ...definition });
}
