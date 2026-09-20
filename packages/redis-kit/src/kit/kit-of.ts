import type { LockOptions, PingResult } from '@nxgt/redis';
import { RedisError, withLock } from '@nxgt/redis';
import {
	type InstanceContext,
	instanceAt,
	type KitContext,
	prefixed,
} from './context';
import { cacheScopeOf, channelScopeOf } from './scope';
import type { KitLockOptions, RedisKit } from './types';

/**
 * One instance's scope, built once.
 *
 * Once, and not per read: `kit.cache` and `kit.instances.<name>.cache` are
 * the same object, so an application can hold on to one and compare it. The
 * two scopes inside it are still built on first read, and the bound caches
 * and channels inside those on first read of their key.
 */
function scopeFor(
	ctx: KitContext,
	instance: InstanceContext,
): LooseInstanceScope {
	let caches: object | undefined;
	let channels: object | undefined;
	return {
		get cache() {
			caches ??= cacheScopeOf(ctx, instance);
			return caches;
		},
		get channels() {
			channels ??= channelScopeOf(ctx, instance);
			return channels;
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
	readonly client: unknown;
	readonly prefix: string | undefined;
	lock<T>(
		key: string,
		work: () => Promise<T> | T,
		options?: LockOptions,
	): Promise<T>;
	ping(options?: { timeoutMs?: number }): Promise<PingResult>;
}

/**
 * `PING` on a client the application opened, which carries no `ping` of its
 * own — `RedisConnection.ping` belongs to what `connectRedis` returned.
 *
 * A copy of `@nxgt/redis`'s own `ping` (`connection/connect.ts`), down to the
 * message and the `PING_TIMEOUT` code: a health route reads the same answer
 * whether the kit opened the client or the configuration handed one in. It is
 * a row in `AGENTS.md`'s duplication table — a fix in one is a fix to make in
 * the other. It answers within `timeoutMs` either way and never throws.
 */
async function pingClient(
	instance: InstanceContext,
	options: { timeoutMs?: number } = {},
): Promise<PingResult> {
	const timeoutMs = options.timeoutMs ?? 2_000;
	const started = performance.now();
	try {
		const answer = instance.client.send('PING', []);
		const timer = new Promise<never>((_, reject) => {
			setTimeout(
				() =>
					reject(
						new RedisError(
							'PING_TIMEOUT',
							'',
							`ping: no answer in ${timeoutMs}ms`,
						),
					),
				timeoutMs,
			).unref?.();
		});
		await Promise.race([answer, timer]);
		return { ok: true, latencyMs: performance.now() - started };
	} catch (error) {
		return { ok: false, error };
	}
}

/**
 * Closes the subscriptions first, then the clients.
 *
 * In that order, and not the other way: a subscription holds a connection
 * duplicated from the client, and unsubscribing on a closed client is an
 * error nobody asked for. Idempotent — `@nxgt/redis` memoises both closes,
 * and the set is emptied as it goes.
 */
async function closeKit(ctx: KitContext): Promise<void> {
	for (const subscription of [...ctx.subscriptions]) {
		ctx.subscriptions.delete(subscription);
		await subscription.close();
	}
	for (const instance of ctx.instances) {
		await instance.connection?.close();
	}
}

/** The object a kit is. Every method is a plain function over the context. */
export function kitOf<C>(ctx: KitContext): RedisKit<C> {
	const instances: Record<string, LooseInstanceScope> = {};
	const clients: Record<string, unknown> = {};
	for (const instance of ctx.instances) {
		instances[instance.name] = scopeFor(ctx, instance);
		clients[instance.name] = instance.client;
	}

	/** The sole instance's scope, or the refusal naming the call that asked. */
	const sole = (what: string) =>
		instances[
			instanceAt(ctx, undefined, `kit.${what}`).name
		] as LooseInstanceScope;

	const kit = {
		// A getter, so the refusal lands when the property is read rather than
		// when the kit is built — the message can then name the call.
		get cache() {
			return sole('cache').cache;
		},
		get channels() {
			return sole('channels').channels;
		},
		instances: Object.freeze(instances),
		clients: Object.freeze(clients),

		// `async`, so naming an instance this kit does not have comes back as a
		// rejection rather than a synchronous throw. A function that returns a
		// promise and also throws is two error paths for one call, and the one
		// nobody writes is `try` around `kit.lock(…).catch(…)`.
		lock: async <T>(
			key: string,
			work: () => Promise<T> | T,
			options: KitLockOptions<C> = {},
		) => {
			const { on, ...rest } = options;
			const instance = instanceAt(ctx, on as string | undefined, 'kit.lock');
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

		close: () => closeKit(ctx),
		[Symbol.asyncDispose]: () => closeKit(ctx),
	};
	return kit as unknown as RedisKit<C>;
}
