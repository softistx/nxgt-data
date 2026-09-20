import {
	bindCache,
	publish,
	type SubscribeOptions,
	type Subscription,
	subscribe,
} from '@nxgt/redis';
import {
	type InstanceContext,
	type KitContext,
	prefixed,
	type Wired,
} from './context';
import type { AnyCache, AnyChannel, BoundChannel } from './types';

/**
 * A definition with this instance's prefix in its name.
 *
 * A copy, never a mutation: the definition came from the application's own
 * module and is shared by every kit that wires it — two kits with two
 * prefixes on one definition is an ordinary thing to want in a test.
 */
function underPrefix<D extends { name: string }>(
	instance: InstanceContext,
	definition: D,
): D {
	return { ...definition, name: prefixed(instance, definition.name) };
}

/** One bound channel: publish, and a subscribe the kit keeps track of. */
function channelOf(
	ctx: KitContext,
	instance: InstanceContext,
	definition: AnyChannel,
): BoundChannel<AnyChannel> {
	const prefixedDefinition = underPrefix(instance, definition);
	return {
		name: prefixedDefinition.name,
		publish: (payload) =>
			publish(instance.client, prefixedDefinition, payload as never),
		subscribe: async (
			handler: (payload: never) => void | Promise<void>,
			options?: SubscribeOptions,
		): Promise<Subscription> => {
			const subscription = await subscribe(
				instance.client,
				prefixedDefinition,
				handler as (payload: unknown) => void | Promise<void>,
				options,
			);
			// Recorded so `kit.close()` closes the ones nobody did. Closing it
			// twice is safe: `@nxgt/redis` memoises its `close`.
			ctx.subscriptions.add(subscription);
			const forget = async () => {
				ctx.subscriptions.delete(subscription);
				await subscription.close();
			};
			// `Object.create`, not a spread: a spread would snapshot the
			// sibling's members, and the day `@nxgt/redis` puts a live one on a
			// `Subscription` — a `closed` promise, a counter — the copy would
			// freeze it without a word. The prototype keeps everything but the
			// two this layer replaces.
			return Object.create(subscription, {
				close: { enumerable: true, value: forget },
				[Symbol.asyncDispose]: { enumerable: false, value: forget },
			}) as Subscription;
		},
	};
}

/**
 * The value at one key of a scope, built the first time it is read and kept.
 *
 * Nothing is built ahead of the first read: an application wires every cache
 * and every channel it has, and a request touches two of them. The same
 * pattern as `@nxgt/mongo-kit`'s `collectionAt`.
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
 * Getters rather than a `Proxy`: unlike `@nxgt/mongo-kit`, which augments the
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
	ctx: KitContext,
	instance: InstanceContext,
): object {
	return scopeOf(instance.caches, (key: string, definition: AnyCache) =>
		at(ctx.caches, instance, key, () =>
			bindCache(instance.client, underPrefix(instance, definition)),
		),
	);
}

export function channelScopeOf(
	ctx: KitContext,
	instance: InstanceContext,
): object {
	return scopeOf(instance.channels, (key: string, definition: AnyChannel) =>
		at(ctx.channels, instance, key, () => channelOf(ctx, instance, definition)),
	);
}
