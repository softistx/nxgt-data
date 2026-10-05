/**
 * What `definition` on a bound object holds to. Checked by `tsc --noEmit`,
 * never run. Kept apart from `wiring.ts`, which is past the size limit.
 */
import { RedisClient } from 'bun';
import type { z } from 'zod';
import {
	type BoundCache,
	type BoundIdempotency,
	type BoundRateLimit,
	bindCache,
	bindIdempotency,
	bindRateLimit,
} from '../../src';
import { defineRedis } from '../../src/wiring/config/define-redis';
import { openRedis } from '../../src/wiring/open-redis';
import { createOrder, loginLimit, userCache } from '../fixtures';
import * as caches from '../wiring/caches';
import * as channels from '../wiring/channels';
import * as idempotency from '../wiring/idempotency';
import * as limits from '../wiring/limits';

const client = new RedisClient('redis://127.0.0.1:1');
const limit = bindRateLimit(client, loginLimit);
const orders = bindIdempotency(client, createOrder);
const users = bindCache(client, userCache);

// The bound types stay as loose in `P` as before `definition` existed: a
// `key` written as a method is bivariant, so each widens.
const wideLimit: BoundRateLimit<unknown> = limit;
const wideOrders: BoundIdempotency<unknown, unknown, unknown> = orders;
const wideCache: BoundCache<string, unknown, unknown> = users;
const wideCacheKey: BoundCache<unknown, unknown, unknown> = users;
const wideLimitString: BoundRateLimit<string> = bindRateLimit(client, {
	name: 'n',
	key: (p: string) => p,
	limit: 1,
	per: 1000,
});
void [wideLimit, wideOrders, wideCache, wideCacheKey, wideLimitString];

// The policy reads as numbers.
const policy: number[] = [
	limit.definition.limit,
	limit.definition.per,
	orders.definition.ttl,
	orders.definition.lease,
	users.definition.ttl,
];
void policy;

// The schema keeps what the bind functions' casts promise: `T` and `I`.
type Out = { orderId: string; total: number; status: string };
type In = { orderId: string; total: number; status?: string | undefined };
const out: Out = {} as z.output<typeof orders.definition.schema>;
const into: In = {} as z.input<typeof orders.definition.schema>;
const outBack: z.output<typeof orders.definition.schema> = {} as Out;
const inBack: z.input<typeof orders.definition.schema> = {} as In;
const cacheOut: { id: string; email: string; seats: number } = {} as z.output<
	typeof users.definition.schema
>;
const cacheIn: { id: string; email: string; seats?: number | undefined } =
	{} as z.input<typeof users.definition.schema>;
const cacheOutBack: z.output<typeof users.definition.schema> = {} as {
	id: string;
	email: string;
	seats: number;
};
const cacheInBack: z.input<typeof users.definition.schema> = {} as {
	id: string;
	email: string;
	seats?: number | undefined;
};
void [out, into, outBack, inBack, cacheOut, cacheIn, cacheOutBack, cacheInBack];
// @ts-expect-error the output has `status` filled, so it is not a string-less shape
const notOut: { orderId: number } = {} as z.output<
	typeof orders.definition.schema
>;
void notOut;

// Fields are readonly, bound by hand.
// @ts-expect-error
orders.definition.ttl = 1;
// @ts-expect-error
users.definition.ttl = 1;

export async function wired() {
	const redis = await openRedis(
		defineRedis({
			uri: 'redis://127.0.0.1:6379',
			caches,
			channels,
			limits,
			idempotency,
		}),
	);
	const reads: unknown[] = [
		redis.limits.login.definition.limit,
		redis.idempotency.orders.definition.lease,
		redis.cache.users.definition.ttl,
		redis.channels.created.definition.name,
	];
	void reads;
	const wiredLimit: number = redis.limits.login.definition.per;
	void wiredLimit;

	// @ts-expect-error definition is readonly
	redis.limits.login.definition = loginLimit;
	// @ts-expect-error definition is readonly
	redis.idempotency.orders.definition = createOrder;
	// @ts-expect-error definition is readonly
	redis.cache.users.definition = userCache;
	// @ts-expect-error definition is readonly
	redis.channels.created.definition = channels.created;

	// @ts-expect-error a field is readonly
	redis.idempotency.orders.definition.ttl = 1;
	// @ts-expect-error a field is readonly
	redis.cache.users.definition.ttl = 1;
	await redis.close();
}
