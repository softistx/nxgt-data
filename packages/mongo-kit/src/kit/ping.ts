import type { PingResult } from '@nxgt/mongo';
import type { Db } from 'mongodb';
import type { KitContext } from './context';

/**
 * `ping` on one database, answering within `timeoutMS` either way. A copy of
 * `@nxgt/mongo`'s own (`connection/connect.ts`), which lives on the
 * `MongoConnection` alone: a database the configuration handed a `client`
 * has none, and a health route should read the same answer for both.
 *
 * What the copy adds is the timer. Measured on mongodb 7.6.0, `timeoutMS`
 * does not bound the connect a client that was never connected makes on its
 * first command: that waits `serverSelectionTimeoutMS` (30 s by default), and
 * `connectMongo`'s clients are always connected, which is why the original
 * needs no timer and a client the configuration handed over does.
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
				[database.name, await pingDb(database.db, options?.timeoutMS)] as const,
		),
	);
	return Object.fromEntries(entries);
}
