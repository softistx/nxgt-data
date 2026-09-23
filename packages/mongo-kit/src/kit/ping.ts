import type { PingResult } from '@nxgt/mongo';
import type { Db } from 'mongodb';
import type { KitContext } from './context';

/**
 * `ping` on a database the configuration handed a `client`, which has no
 * `MongoConnection` and so no `ping` of its own. A copy of `@nxgt/mongo`'s
 * (`connection/connect.ts`), plus a timer.
 *
 * The timer is for this case alone. Measured on mongodb 7.6.0, `timeoutMS`
 * does not bound the connect a client that was never connected makes on its
 * first command: that waits `serverSelectionTimeoutMS` (30 s by default).
 * `connectMongo`'s clients are always connected, so a database the kit
 * opened keeps the original, and the driver's own `MongoOperationTimeoutError`
 * — a timer started with the same deadline would always fire first and hide
 * it, which is what the first version of this did.
 */
async function pingDb(db: Db, timeoutMS = 2_000): Promise<PingResult> {
	const started = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`ping: no answer in ${timeoutMS}ms`)),
			timeoutMS,
		);
	});
	try {
		await Promise.race([db.command({ ping: 1 }, { timeoutMS }), deadline]);
		return { ok: true, latencyMs: performance.now() - started };
	} catch (error) {
		return { ok: false, error };
	} finally {
		clearTimeout(timer);
	}
}

/** Every database's `ping`, at once, under its name. Never throws. */
export async function pingKit(
	ctx: KitContext,
	options?: { timeoutMS?: number },
): Promise<Record<string, PingResult>> {
	const entries = await Promise.all(
		ctx.databases.map(
			async (database) =>
				[
					database.name,
					database.connection
						? await database.connection.ping(options)
						: await pingDb(database.db, options?.timeoutMS),
				] as const,
		),
	);
	return Object.fromEntries(entries);
}
