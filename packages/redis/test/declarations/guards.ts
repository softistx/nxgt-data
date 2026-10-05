// The guards an app exports, defined and bound, behind exported values whose
// types are inferred: a declaration build must be able to name each one
// through `@nxgt/redis` and its peers alone (TS2883 otherwise).
import {
	bindCache,
	bindIdempotency,
	bindRateLimit,
	defineCache,
	defineChannel,
	defineIdempotency,
	defineRateLimit,
	defineRedis,
	openRedis,
} from '@nxgt/redis';
import type { RedisClient } from 'bun';
import { z } from 'zod';

/** Bun's client: its types are a Bun consumer's, so the bound guards name it. */
declare const redis: RedisClient;

export const exportLimit = defineRateLimit({
	name: 'export',
	key: (p: { org: string; user: string }) => `${p.org}/${p.user}`,
	limit: 10,
	per: 60_000,
	burst: 20,
});

export const createOrder = defineIdempotency({
	name: 'orders.create',
	key: (p: { user: string; key: string }) => `${p.user}/${p.key}`,
	ttl: 86_400,
	lease: 30_000,
	schema: z.object({
		orderId: z.string(),
		status: z.string().default('placed'),
	}),
});

export const exportsLimit = bindRateLimit(redis, exportLimit);

export const orders = bindIdempotency(redis, createOrder);

export function consumed() {
	return exportsLimit.consume({ org: 'acme', user: 'u1' });
}

/**
 * The wired guards: a configuration and the Redis it opens, both with
 * inferred types that name `LimitScope`, `IdempotencyScope` and the aliases
 * they are built from.
 */
export const wiredConfig = defineRedis({
	uri: 'redis://127.0.0.1:6379',
	prefix: 'myapp',
	limits: { exportLimit },
	idempotency: { createOrder },
});

export const wired = await openRedis(wiredConfig);

export const wiredLimits = wired.limits;

export const wiredOrders = wired.idempotency;

export const userCache = defineCache({
	name: 'user',
	key: (id: string) => id,
	ttl: 60,
	schema: z.object({ id: z.string(), seats: z.number().default(1) }),
});

/** A bound cache: its `definition` names the schema's types too. */
export const users = bindCache(redis, userCache);

export const userCreated = defineChannel({
	name: 'user.created',
	schema: z.object({ id: z.string() }),
});

export const wiredWithChannel = await openRedis(
	defineRedis({
		uri: 'redis://127.0.0.1:6379',
		channels: { userCreated },
		caches: { userCache },
	}),
);

/** The wired channel and cache, and their definitions, exported by value. */
export const wiredChannel = wiredWithChannel.channels.userCreated;
export const wiredCache = wiredWithChannel.cache.userCache;
