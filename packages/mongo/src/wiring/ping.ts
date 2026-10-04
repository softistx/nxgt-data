import { type PingResult, ping } from '../connection/connect';
import type { WiringContext } from './context';

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
						: await ping(database.db, options?.timeoutMS),
				] as const,
		),
	);
	return Object.fromEntries(entries);
}
