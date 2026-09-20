import type { CacheDefinition, ChannelDefinition } from '@nxgt/redis';
import type { z } from 'zod';
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
		typeof it.name === 'string' &&
		typeof it.key === 'function' &&
		typeof it.ttl === 'number' &&
		it.schema !== undefined
	);
}

/** Whether a module export is a channel definition. */
export function isChannel(
	value: unknown,
): value is ChannelDefinition<z.ZodType> {
	if (typeof value !== 'object' || value === null) return false;
	const it = value as Record<string, unknown>;
	return (
		typeof it.name === 'string' &&
		it.schema !== undefined &&
		it.ttl === undefined &&
		typeof it.key !== 'function'
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
 * sentence, which is the rule in `AGENTS.md`. `@nxgt/mongo-kit` is the
 * exception to it because it has seven; `@nxgt/mongo-search-kit`, which is
 * the closer neighbour in size, carries no error class either.
 */
export function checkInstance(
	call: 'defineConfig' | 'connectKit',
	name: string,
	instance: InstanceConfig<object, object>,
): void {
	// The call that raised it, not always `defineConfig`: the same checks run
	// again in `connectKit`, and a message naming a function the application
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
	const caches = wiredOf(instance.caches, isCache);
	const channels = wiredOf(instance.channels, isChannel);
	if (caches.length === 0 && channels.length === 0) {
		throw new TypeError(
			`${where} wires no cache and no channel. Pass the module that ` +
				'exports them, or drop the instance.',
		);
	}
}

/**
 * Refuses one definition wired twice, under two keys.
 *
 * Two keys pointing at the same definition write the same Redis keys, so one
 * of them is silently dead: `kit.cache.a.delete(p)` empties what
 * `kit.cache.b.set(p, v)` wrote. It is a copy-paste in the module that
 * exports them, and nothing downstream can see it.
 */
function checkNoClash(
	where: string,
	instance: InstanceConfig<object, object>,
): void {
	for (const [kind, wired] of [
		['cache', wiredOf(instance.caches, isCache)],
		['channel', wiredOf(instance.channels, isChannel)],
	] as const) {
		const seen = new Map<string, string>();
		for (const [key, definition] of wired) {
			const first = seen.get(definition.name);
			if (first !== undefined) {
				throw new TypeError(
					`${where} wires the ${kind} named "${definition.name}" twice, ` +
						`under "${first}" and "${key}". They would share every key ` +
						'in Redis. Export one of them, or give it a name of its own.',
				);
			}
			seen.set(definition.name, key);
		}
	}
}
