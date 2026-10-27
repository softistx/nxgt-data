import type { z } from 'zod';
import type { CacheDefinition } from '../../cache/types';
import type { ChannelDefinition } from '../../channel/define-channel';
import type { IdempotencyDefinition } from '../../idempotency/types';
import type { RateLimitDefinition } from '../../rate-limit/types';
import type { AnyQueue } from '../types';

/**
 * Whether a module export is a cache definition.
 *
 * By shape, not `instanceof`: `defineCache` returns the object it was given,
 * and two copies of `@nxgt/redis` in a tree would fail any identity test.
 * `ttl` is what tells it from a channel, which is why `ChannelDefinition`
 * declares `ttl?: never`.
 */
export function isCache(
	value: unknown,
): value is CacheDefinition<never, z.ZodType> {
	if (typeof value !== 'object' || value === null) return false;
	const it = value as Record<string, unknown>;
	return (
		typeof it['name'] === 'string' &&
		typeof it['key'] === 'function' &&
		typeof it['ttl'] === 'number' &&
		it['lease'] === undefined &&
		it['schema'] !== undefined
	);
}

/**
 * Whether a module export is a rate limit definition: `limit` and `per` are
 * what no other kind has.
 */
export function isRateLimit(
	value: unknown,
): value is RateLimitDefinition<never> {
	if (typeof value !== 'object' || value === null) return false;
	const it = value as Record<string, unknown>;
	return (
		typeof it['name'] === 'string' &&
		typeof it['key'] === 'function' &&
		typeof it['limit'] === 'number' &&
		typeof it['per'] === 'number'
	);
}

/**
 * Whether a module export is an idempotency definition: a cache's shape with
 * a `lease`, which `defineIdempotency` always fills and a cache never has.
 */
export function isIdempotency(
	value: unknown,
): value is IdempotencyDefinition<never, z.ZodType> {
	if (typeof value !== 'object' || value === null) return false;
	const it = value as Record<string, unknown>;
	return (
		typeof it['name'] === 'string' &&
		typeof it['key'] === 'function' &&
		typeof it['ttl'] === 'number' &&
		typeof it['lease'] === 'number' &&
		it['schema'] !== undefined
	);
}

/**
 * Whether a module export is a channel definition. A `key` function does not
 * rule it out: that is the selector of its keyed streams.
 */
export function isChannel(
	value: unknown,
): value is ChannelDefinition<z.ZodType> {
	if (typeof value !== 'object' || value === null) return false;
	const it = value as Record<string, unknown>;
	return (
		typeof it['name'] === 'string' &&
		it['schema'] !== undefined &&
		it['ttl'] === undefined &&
		it['lease'] === undefined &&
		it['limit'] === undefined
	);
}

/**
 * Whether a module export is a queue definition.
 *
 * `attempts`, `lease` and `keepFailed` are numbers and `backoff` an object,
 * which `defineQueue` always fills and no other kind has together. No `key`
 * function, which every guard has. A channel refuses it already: its `lease`
 * is a number.
 */
export function isQueue(value: unknown): value is AnyQueue {
	if (typeof value !== 'object' || value === null) return false;
	const it = value as Record<string, unknown>;
	const schema = it['schema'] as { safeParse?: unknown } | undefined;
	return (
		typeof it['name'] === 'string' &&
		typeof schema?.safeParse === 'function' &&
		typeof it['attempts'] === 'number' &&
		typeof it['lease'] === 'number' &&
		typeof it['keepFailed'] === 'number' &&
		typeof it['backoff'] === 'object' &&
		it['backoff'] !== null &&
		typeof it['key'] !== 'function'
	);
}

/** The definitions of a module object, by the key it is exported under. */
export function wiredOf<T>(
	module: object | undefined,
	is: (value: unknown) => value is T,
): readonly (readonly [string, T])[] {
	if (module === undefined) return [];
	const found: (readonly [string, T])[] = [];
	for (const [key, value] of Object.entries(module)) {
		if (is(value)) found.push([key, value] as const);
	}
	return found;
}
