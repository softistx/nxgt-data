import type { Db } from 'mongodb';
import { type PingResult, ping } from '../connection/connect';
import type { WiringContext } from './context';

/**
 * `ping` on a database the configuration handed a `client`, which has no
 * `MongoConnection` and so no `ping` of its own: the package's own `ping`
 * (`connection/connect.ts`), raced against a timer.
 *
 * The timer is for this case alone. Measured on mongodb 7.6.0, `timeoutMS`
 * does not bound the connect a client that was never connected makes on its
 * first command: that waits `serverSelectionTimeoutMS` (30 s by default).
 * `connectMongo`'s clients are always connected, so a database the Mongo
 * opened keeps the original alone, and the driver's own
 * `MongoOperationTimeoutError` — a timer started with the same deadline would
 * always fire first and hide it, which is what the first version of this did.
 */
async function pingDb(db: Db, timeoutMS = 2_000): Promise<PingResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<PingResult>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					ok: false,
					error: new Error(`ping: no answer in ${timeoutMS}ms`),
				}),
			timeoutMS,
		);
	});
	try {
		return await Promise.race([ping(db, timeoutMS), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** Every database's `ping`, at once, under its name. Never throws. */
export async function pingMongo(
	ctx: WiringContext,
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
