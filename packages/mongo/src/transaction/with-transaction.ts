import type { ClientSession, MongoClient, TransactionOptions } from 'mongodb';
import { toDataError } from '../errors/to-data-error';

/** What a transaction can be started from: a client, or a session. */
export type TransactionHost = MongoClient | ClientSession;

/** A session, read without `instanceof`: two copies of the driver. */
function isSession(host: TransactionHost): host is ClientSession {
	return typeof (host as ClientSession).inTransaction === 'function';
}

/**
 * Runs `fn` in a transaction: committed when it resolves, aborted when it
 * throws, and a MongoDB error turned into a `DataError` on the way out. The
 * session is the argument, and **every operation inside has to be given it**:
 * MongoDB has no ambient session, so an operation without one runs outside the
 * transaction and is not rolled back. `collection.withSession(session)` is how
 * a collection takes it.
 *
 * ```ts
 * await withTransaction(client, async (session) => {
 * 	const team = await teams.withSession(session).create({ name: 'Core' });
 * 	await users.withSession(session).update(userId, { teamId: team._id });
 * });
 * ```
 *
 * Given a session that is already in a transaction, it **joins** it: `fn` runs
 * with that session and nothing is committed until the outer one commits.
 * MongoDB has no savepoints, so an inner failure cannot be rolled back on its
 * own, and starting a second transaction on one session throws
 * `MongoTransactionError`.
 *
 * Two things the driver does that are easy to be surprised by:
 *
 * - it **retries `fn`** from the start on a `TransientTransactionError`, and
 *   the commit alone on an `UnknownTransactionCommitResult`, until 120 seconds
 *   have passed. `fn` must therefore be safe to run twice.
 * - `session.abortTransaction()` inside `fn` ends the transaction without
 *   throwing: `withTransaction` then resolves.
 */
export async function withTransaction<T>(
	host: TransactionHost,
	fn: (session: ClientSession) => Promise<T>,
	options?: TransactionOptions,
): Promise<T> {
	try {
		if (isSession(host)) {
			if (host.inTransaction()) {
				if (options) {
					throw new TypeError(
						'withTransaction: this session is already in a transaction, which ' +
							'this call joins. MongoDB has no savepoints, so the read ' +
							'concern, the write concern and the read preference are the ' +
							'outer transaction’s.',
					);
				}
				return await fn(host);
			}
			return await host.withTransaction(fn, options);
		}

		const session = host.startSession();
		try {
			return await session.withTransaction(fn, options);
		} finally {
			await session.endSession();
		}
	} catch (error) {
		throw toDataError(error);
	}
}
