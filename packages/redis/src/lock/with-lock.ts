import type { RedisClient } from 'bun';
import { RedisError } from '../errors/redis-error';

export interface LockOptions {
	/**
	 * How long the lock is held before Redis drops it, in milliseconds
	 * (default 30 s). It is a **deadline for the work**, not a hint: whatever
	 * is still running when it passes is no longer protected.
	 */
	ttl?: number;
	/** How long to keep trying to take it, in milliseconds (default 0). */
	wait?: number;
	/** How long between tries, in milliseconds (default 50). */
	retryDelay?: number;
}

/**
 * Releases the lock only if it is still the one we took. Compare-and-delete
 * has to be one step: between a `GET` and a `DEL`, the lock could expire and
 * be taken by somebody else, and the `DEL` would then free *their* lock.
 */
const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("del", KEYS[1])
else
	return 0
end`;

/**
 * Runs `work` while holding a lock, and gives it back afterwards.
 *
 * ```ts
 * await withLock(redis.client, 'invoices:nightly', async () => {
 * 	await sendInvoices();
 * }, { ttl: 60_000, wait: 5_000 });
 * ```
 *
 * The lock is `SET NX PX`, so taking it is one round trip and one step. It is
 * released with a script that checks the token first, so a run that overran
 * its `ttl` cannot free the lock somebody else has since taken.
 *
 * Throws `RedisError` with `LOCK_HELD` when `wait` runs out, and with
 * `LOCK_LOST` when the work finished but the lock had already expired — the
 * work may then have run beside another holder's, so a caller has to know.
 * An error from `work` itself is passed through untouched.
 *
 * One substitution to know about: if the work succeeds but the release itself
 * fails — a connection blip on that round trip — that failure is what the
 * caller sees, and the work's value is lost. The lock then stays until its
 * `ttl` runs out.
 */
export async function withLock<T>(
	client: RedisClient,
	key: string,
	work: () => Promise<T> | T,
	options: LockOptions = {},
): Promise<T> {
	const { ttl = 30_000, wait = 0, retryDelay = 50 } = options;
	const lockKey = `lock:${key}`;
	const token = crypto.randomUUID();
	const deadline = Date.now() + wait;

	// `SET key token PX <ttl> NX`, through the variadic overload — which takes
	// its options as strings, so the ttl is spelled as one. Taking the lock and
	// giving it an expiry is one command: a lock set without one outlives a
	// process that dies holding it, and nothing ever frees it.
	const take = () => client.set(lockKey, token, 'PX', String(ttl), 'NX');

	let taken = await take();
	while (taken === null && Date.now() < deadline) {
		await Bun.sleep(retryDelay);
		taken = await take();
	}
	if (taken === null) {
		throw new RedisError(
			'LOCK_HELD',
			lockKey,
			wait === 0
				? `The lock "${key}" is held by somebody else, and this call did ` +
						'not wait for it — pass `wait` to keep trying'
				: `The lock "${key}" is held by somebody else, and ${wait}ms was ` +
						'not long enough to wait for it',
		);
	}

	// Whether *this* call lost *its* lock — not whether the error passing
	// through happens to be a `LOCK_LOST`. A `withLock` nested inside `work`
	// throws one too, and taking that for our own would skip the release and
	// leave this lock held for the rest of its ttl.
	let lostItself = false;
	try {
		const done = await work();
		const released = Number(await client.eval(RELEASE, 1, lockKey, token));
		if (released === 0) {
			lostItself = true;
			throw new RedisError(
				'LOCK_LOST',
				lockKey,
				`The lock "${key}" expired before its work finished: it ran longer ` +
					`than the ${ttl}ms ttl, so it may have run beside another holder`,
			);
		}
		return done;
	} catch (error) {
		// `work` threw, or this lock was lost. Either way the lock is given
		// back if it is still ours — and a failure to do that must not replace
		// the error the caller is about to see.
		if (!lostItself) {
			await client.eval(RELEASE, 1, lockKey, token).catch(() => undefined);
		}
		throw error;
	}
}
