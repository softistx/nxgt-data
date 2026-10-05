import type { z } from 'zod';
import type { CacheDefinition } from '../../cache/types';
import type { ChannelDefinition } from '../../channel/define-channel';
import type { IdempotencyDefinition } from '../../idempotency/types';
import type { RateLimitDefinition } from '../../rate-limit/types';
import type { InstanceConfig } from './types';

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

/** Whether a module export is a channel definition. */
export function isChannel(
	value: unknown,
): value is ChannelDefinition<z.ZodType> {
	if (typeof value !== 'object' || value === null) return false;
	const it = value as Record<string, unknown>;
	return (
		typeof it['name'] === 'string' &&
		it['schema'] !== undefined &&
		it['ttl'] === undefined &&
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

/**
 * Refuses a configuration that cannot be honoured.
 *
 * A bare `TypeError`, with no code. Every refusal here is wiring-time — no
 * request can produce one — and there are few enough to tell apart by their
 * sentence, which is the rule in `AGENTS.md`. `@nxgt/mongo`'s wiring is the
 * exception to it because it has seven (`WiringError`);
 * `@nxgt/mongo-meilisearch`'s `createSearchSyncs`, the closer neighbour in
 * size, carries no error class either.
 */
export function checkInstance(
	call: 'defineRedis' | 'openRedis',
	name: string,
	instance: InstanceConfig<object, object>,
): void {
	// The call that raised it, not always `defineRedis`: the same checks run
	// again in `openRedis`, and a message naming a function the application
	// did not call sends a reader to the wrong file.
	const where = `${call}: instance "${name}"`;
	if (instance.uri === undefined && instance.client === undefined) {
		throw new TypeError(`${where} has neither uri nor client. Give it one.`);
	}
	if (instance.uri !== undefined && instance.client !== undefined) {
		throw new TypeError(
			`${where} has both uri and client. Pass the URI to connect to, or ` +
				'the client you already opened.',
		);
	}
	if (instance.client !== undefined && instance.clientOptions !== undefined) {
		throw new TypeError(
			`${where} has clientOptions beside a client. The client was opened ` +
				'with its own; pass a uri, or drop the options.',
		);
	}
	if (instance.prefix !== undefined && instance.prefix.trim() === '') {
		throw new TypeError(
			`${where} has an empty prefix. Leave it out, or give it a name.`,
		);
	}
	checkNothingWired(where, instance);
	checkNoClash(where, instance);
}

function checkNothingWired(
	where: string,
	instance: InstanceConfig<object, object>,
): void {
	if (
		wiredOf(instance.caches, isCache).length === 0 &&
		wiredOf(instance.channels, isChannel).length === 0 &&
		wiredOf(instance.limits, isRateLimit).length === 0 &&
		wiredOf(instance.idempotency, isIdempotency).length === 0
	) {
		throw new TypeError(
			`${where} wires no cache, no channel, no rate limit and no ` +
				'idempotency. Pass the module that exports them, or drop the instance.',
		);
	}
}

type Group = readonly [
	kind: string,
	wired: readonly (readonly [key: string, definition: { name: string }])[],
];

/**
 * Refuses a name used twice among `groups`.
 *
 * One definition under two keys: both would write the same Redis keys, so one
 * of them is silently dead — `redis.cache.a.delete(p)` empties what
 * `redis.cache.b.set(p, v)` wrote. A copy-paste in the module that exports
 * them, which nothing downstream can see.
 *
 * Two definitions of different kinds with one name, in the same group list:
 * a cache, a rate limit and an idempotency all write `<name>:<key>`, so they
 * would meet in Redis as a `WRONGTYPE` on whichever runs second. Only names
 * are compared — never what a key function would build.
 */
function refuseClash(where: string, groups: readonly Group[]): void {
	const seen = new Map<string, { kind: string; key: string }>();
	for (const [kind, wired] of groups) {
		for (const [key, definition] of wired) {
			const first = seen.get(definition.name);
			if (first === undefined) {
				seen.set(definition.name, { kind, key });
			} else if (first.kind === kind) {
				throw new TypeError(
					`${where} wires the ${kind} named "${definition.name}" twice, ` +
						`under "${first.key}" and "${key}". They would share every key ` +
						'in Redis. Export one of them, or give it a name of its own.',
				);
			} else {
				throw new TypeError(
					`${where} wires the ${first.kind} "${first.key}" and the ${kind} ` +
						`"${key}" under one name, "${definition.name}". They would share ` +
						'every key in Redis, and the second to run gets WRONGTYPE. Give ' +
						'one of them a name of its own.',
				);
			}
		}
	}
}

/**
 * Channels have a namespace of their own — pub/sub names are not keys — so
 * they are checked among themselves, and a channel named like a cache is fine.
 */
function checkNoClash(
	where: string,
	instance: InstanceConfig<object, object>,
): void {
	refuseClash(where, [
		['cache', wiredOf(instance.caches, isCache)],
		['rate limit', wiredOf(instance.limits, isRateLimit)],
		['idempotency', wiredOf(instance.idempotency, isIdempotency)],
	]);
	refuseClash(where, [['channel', wiredOf(instance.channels, isChannel)]]);
}
