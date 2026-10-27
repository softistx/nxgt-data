import { bindCache } from '../cache/bind-cache';
import { bindIdempotency } from '../idempotency/bind-idempotency';
import { bindQueueWith } from '../queue/binding/bind-queue';
import { bindRateLimit } from '../rate-limit/bind-rate-limit';
import { channelOf } from './channel-of';
import type { Wired, WiringContext } from './context';
import type {
	AnyCache,
	AnyChannel,
	AnyIdempotency,
	AnyQueue,
	AnyRateLimit,
} from './types';
import { underPrefix } from './under-prefix';

/**
 * The value at one key of a scope, built the first time it is read and kept.
 *
 * Nothing is built ahead of the first read: an application wires every cache
 * and every channel it has, and a request touches two of them. The same
 * pattern as `@nxgt/mongo`'s `collectionAt`.
 *
 * Keyed by the **wired key**, not by the definition's `name`: the two happen
 * to be one-to-one only because `checkNoClash` refuses one definition under
 * two keys, and a memo that would silently collide the day that check moves
 * is not worth the saving.
 */
function at<T>(
	cache: Map<string, Map<string, unknown>>,
	instance: InstanceContext,
	key: string,
	build: () => T,
): T {
	let forInstance = cache.get(instance.name);
	if (!forInstance) {
		forInstance = new Map();
		cache.set(instance.name, forInstance);
	}
	const held = forInstance.get(key);
	if (held !== undefined) return held as T;
	const built = build();
	forInstance.set(key, built);
	return built;
}

/**
 * A scope over the wired definitions: one own enumerable getter per key.
 *
 * Getters rather than a `Proxy`: unlike `@nxgt/mongo`'s wiring, which augments the
 * driver's `Db` and must fall through to it, nothing here has a member to
 * fall through to. `Object.keys` therefore lists what is wired, and a key
 * that is not wired is plainly `undefined` rather than a driver method that
 * happens to share the name.
 */
function scopeOf<D>(
	wired: readonly Wired<D>[],
	build: (key: string, definition: D) => unknown,
): object {
	const scope: Record<string, unknown> = {};
	for (const [key, definition] of wired) {
		Object.defineProperty(scope, key, {
			enumerable: true,
			get: () => build(key, definition),
		});
	}
	return Object.freeze(scope);
}

export function cacheScopeOf(
	ctx: WiringContext,
	instance: InstanceContext,
): object {
	return scopeOf(instance.caches, (key: string, definition: AnyCache) =>
		at(ctx.caches, instance, key, () =>
			bindCache(instance.client, underPrefix(instance, definition)),
		),
	);
}

export function channelScopeOf(
	ctx: WiringContext,
	instance: InstanceContext,
): object {
	return scopeOf(instance.channels, (key: string, definition: AnyChannel) =>
		at(ctx.channels, instance, key, () => channelOf(ctx, instance, definition)),
	);
}

/**
 * Rate limits bound with the prefix in their name, so a stored key is
 * `<prefix>:<name>:<key>`. `bindRateLimit` takes no prefix of its own: the
 * definition copy carries it, as a cache's does.
 */
export function limitScopeOf(
	ctx: WiringContext,
	instance: InstanceContext,
): object {
	return scopeOf(instance.limits, (key: string, definition: AnyRateLimit) =>
		at(ctx.limits, instance, key, () =>
			bindRateLimit(instance.client, underPrefix(instance, definition)),
		),
	);
}

export function idempotencyScopeOf(
	ctx: WiringContext,
	instance: InstanceContext,
): object {
	return scopeOf(
		instance.idempotency,
		(key: string, definition: AnyIdempotency) =>
			at(ctx.idempotency, instance, key, () =>
				bindIdempotency(instance.client, underPrefix(instance, definition)),
			),
	);
}

/**
 * Queues bound with the prefix kept apart from the name, and the Redis's life
 * handed to each: `work` and `add` refuse once the Redis closes, and its
 * workers close with it. Nothing here touches the server: a queue connects
 * on its first call.
 */
export function queueScopeOf(
	ctx: WiringContext,
	instance: InstanceContext,
): object {
	return scopeOf(instance.queues, (key: string, definition: AnyQueue) =>
		at(ctx.queues, instance, key, () =>
			bindQueueWith(instance.client, definition, {
				prefix: instance.prefix,
				life: ctx.life,
			}),
		),
	);
}
