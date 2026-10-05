import { type PingResult, ping } from '../connection/connect';
import type { LockOptions } from '../lock/with-lock';
import { withLock } from '../lock/with-lock';
import {
	type InstanceContext,
	instanceAt,
	prefixed,
	type WiringContext,
} from './context';
import {
	cacheScopeOf,
	channelScopeOf,
	idempotencyScopeOf,
	limitScopeOf,
} from './scope';
import type { Redis, RedisLockOptions } from './types';

/**
 * One instance's scope, built once.
 *
 * Once, and not per read: `redis.cache` and `redis.instances.<name>.cache` are
 * the same object, so an application can hold on to one and compare it. The
 * two scopes inside it are still built on first read, and the bound caches
 * and channels inside those on first read of their key.
 */
function scopeFor(
	ctx: WiringContext,
	instance: InstanceContext,
): LooseInstanceScope {
	let caches: object | undefined;
	let channels: object | undefined;
	let limits: object | undefined;
	let idempotency: object | undefined;
	return {
		get cache() {
			caches ??= cacheScopeOf(ctx, instance);
			return caches;
		},
		get channels() {
			channels ??= channelScopeOf(ctx, instance);
			return channels;
		},
		get limits() {
			limits ??= limitScopeOf(ctx, instance);
			return limits;
		},
		get idempotency() {
			idempotency ??= idempotencyScopeOf(ctx, instance);
			return idempotency;
		},
		client: instance.client,
		prefix: instance.prefix,
		/**
		 * The prefix lands inside `lock:`, not in front of it —
		 * `lock:myapp:import`, where a cache key is `myapp:user:ada`. That is
		 * `@nxgt/redis`'s doing: `withLock` writes `lock:${key}` itself, and
		 * this package does not reach into a sibling to reorder it. Two
		 * deployments are still kept apart, which is what the prefix is for.
		 */
		lock: <T>(key: string, work: () => Promise<T> | T, options?: LockOptions) =>
			withLock(instance.client, prefixed(instance, key), work, options),
		ping: (options?: { timeoutMs?: number }) =>
			instance.connection
				? instance.connection.ping(options)
				: pingClient(instance, options),
	};
}

/**
 * One instance's scope as this file handles it, loosely typed.
 *
 * `Loose` in the name on purpose: `InstanceScope<Ca, Ch>` next door in
 * `types.ts` is the published one, and a reader landing on a cast should not
 * have to work out which of the two it means. `AnyCache` and `AnyChannel`
 * name the loose forms of the definitions the same way.
 */
interface LooseInstanceScope {
	readonly cache: object;
	readonly channels: object;
	readonly limits: object;
	readonly idempotency: object;
	readonly client: unknown;
	readonly prefix: string | undefined;
	lock<T>(
		key: string,
		work: () => Promise<T> | T,
		options?: LockOptions,
	): Promise<T>;
	ping(options?: { timeoutMs?: number }): Promise<PingResult>;
}

/** `PING` on a client the application opened, which has no `ping` of its own. */
function pingClient(
	instance: InstanceContext,
	options: { timeoutMs?: number } = {},
): Promise<PingResult> {
	return ping(instance.client, options.timeoutMs);
}

/**
 * Closes the subscriptions first, then the clients.
 *
 * In that order, and not the other way: a subscription holds a connection
 * duplicated from the client, and unsubscribing on a closed client is an
 * error nobody asked for. Idempotent — `@nxgt/redis` memoises both closes,
 * and the set is emptied as it goes.
 */
async function closeAll(ctx: WiringContext): Promise<void> {
	for (const subscription of [...ctx.subscriptions]) {
		ctx.subscriptions.delete(subscription);
		await subscription.close();
	}
	for (const instance of ctx.instances) {
		await instance.connection?.close();
	}
}

/** The object a Redis is. Every method is a plain function over the context. */
export function wire<C>(ctx: WiringContext): Redis<C> {
	const instances: Record<string, LooseInstanceScope> = {};
	const clients: Record<string, unknown> = {};
	for (const instance of ctx.instances) {
		instances[instance.name] = scopeFor(ctx, instance);
		clients[instance.name] = instance.client;
	}

	/** The sole instance's scope, or the refusal naming the call that asked. */
	const sole = (what: string) =>
		instances[instanceAt(ctx, undefined, what).name] as LooseInstanceScope;

	const redis = {
		// A getter, so the refusal lands when the property is read rather than
		// when the Redis is built — the message can then name the call.
		get cache() {
			return sole('cache').cache;
		},
		get channels() {
			return sole('channels').channels;
		},
		get limits() {
			return sole('limits').limits;
		},
		get idempotency() {
			return sole('idempotency').idempotency;
		},
		instances: Object.freeze(instances),
		clients: Object.freeze(clients),

		// `async`, so naming an instance this Redis does not have comes back as a
		// rejection rather than a synchronous throw. A function that returns a
		// promise and also throws is two error paths for one call, and the one
		// nobody writes is `try` around `redis.lock(…).catch(…)`.
		lock: async <T>(
			key: string,
			work: () => Promise<T> | T,
			options: RedisLockOptions<C> = {},
		) => {
			const { on, ...rest } = options;
			const instance = instanceAt(ctx, on as string | undefined, 'lock');
			return withLock(
				instance.client,
				prefixed(instance, key),
				work,
				rest as LockOptions,
			);
		},

		ping: async (options?: { timeoutMs?: number }) => {
			const entries = await Promise.all(
				ctx.instances.map(
					async (instance) =>
						[
							instance.name,
							await (instances[instance.name] as LooseInstanceScope).ping(
								options,
							),
						] as const,
				),
			);
			return Object.fromEntries(entries);
		},

		close: () => closeAll(ctx),
		[Symbol.asyncDispose]: () => closeAll(ctx),
	};
	return redis as unknown as Redis<C>;
}
