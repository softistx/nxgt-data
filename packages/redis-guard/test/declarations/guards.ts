// The guards an app exports, defined and bound, behind exported values whose
// types are inferred: a declaration build must be able to name each one
// through `@nxgt/redis-guard` and its peers alone (TS2883 otherwise).
import {
	bindIdempotency,
	bindRateLimit,
	defineIdempotency,
	defineRateLimit,
} from '@nxgt/redis-guard';
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
