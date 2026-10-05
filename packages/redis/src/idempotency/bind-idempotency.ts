import type { RedisClient } from 'bun';
import type { z } from 'zod';
import { checkIdempotency, DEFAULT_LEASE } from './define-idempotency';
import { type Context, run } from './run';
import type { BoundIdempotency, IdempotencyDefinition } from './types';

/**
 * Binds an idempotent operation to a client.
 *
 * ```ts
 * const orders = bindIdempotency(redis, createOrder);
 * const { value, replayed } = await orders.run(
 * 	{ user, key: request.headers.get('Idempotency-Key') },
 * 	() => placeOrder(body),
 * 	{ fingerprint: rawBody },
 * );
 * ```
 *
 * Each step is one script over one hash — take the key, store the result,
 * give the key back — so two processes cannot both take it. See
 * `scripts.ts` for what a stored record may be.
 */
export function bindIdempotency<P, S extends z.ZodType>(
	client: RedisClient,
	definition: IdempotencyDefinition<P, S>,
): BoundIdempotency<P, z.output<S>, z.input<S>> {
	checkIdempotency(definition, 'bindIdempotency');
	const ctx: Context = {
		client,
		name: definition.name,
		ttl: definition.ttl,
		lease: definition.lease ?? DEFAULT_LEASE,
		schema: definition.schema,
	};
	const keyFor = (params: P) => `${ctx.name}:${definition.key(params)}`;
	return {
		keyFor,
		run: async (params, work, options) =>
			await run<z.output<S>, z.input<S>>(ctx, keyFor(params), work, options),
		forget: async (params) => (await client.del(keyFor(params))) > 0,
	};
}
