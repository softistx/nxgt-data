import { durationMs } from '../queue/duration';
import { closeLife } from '../queue/life';
import type { WiringContext } from './context';

/**
 * Closes the queues, then the subscriptions, then the clients.
 *
 * In that order, and not the other way: the queues' workers and pending
 * `finished` calls ride on the clients and the subscriptions, and a worker
 * given its `grace` must finish its jobs while the connections are still up.
 * A subscription holds a connection duplicated from the client, and
 * unsubscribing on a closed client is an error nobody asked for. The last two
 * sit in a `finally`: a worker error `closeLife` rethrows still leaves the
 * Redis closed. `grace` is already checked; `undefined` is each worker's default.
 */
export async function closeAll(
	ctx: WiringContext,
	grace: number | undefined,
): Promise<void> {
	try {
		await closeLife(ctx.life, grace);
	} finally {
		for (const subscription of [...ctx.subscriptions]) {
			ctx.subscriptions.delete(subscription);
			await subscription.close();
		}
		for (const instance of ctx.instances) {
			await instance.connection?.close();
		}
	}
}

/**
 * `redis.close`: checks `grace`, then closes once.
 *
 * Not `async`: a second call must return the first call's promise itself, and
 * a refused `grace` is a rejection before anything is memoised, so a refused
 * call closes nothing.
 */
export function closeRedis(
	ctx: WiringContext,
	options?: { grace?: unknown },
): Promise<void> {
	const given = options?.grace;
	const grace = given === undefined ? undefined : durationMs(given);
	if (given !== undefined && grace === undefined) {
		return Promise.reject(
			new TypeError(
				"close: grace is not a duration; a duration is a whole number of milliseconds or a string such as '10m'",
			),
		);
	}
	ctx.closing ??= closeAll(ctx, grace);
	return ctx.closing;
}
