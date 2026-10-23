import type { ClientSession, MongoClient, TransactionOptions } from 'mongodb';
import { DataError } from '../errors/data-error';
import { toDataError } from '../errors/to-data-error';

/** What a transaction can be started from: a client, or a session. */
export type TransactionHost = MongoClient | ClientSession;

/** What `withTransaction` takes: the driver's transaction options, and one of its own. */
export type WithTransactionOptions = TransactionOptions & {
	/**
	 * Whether the driver reruns `fn` on a `TransientTransactionError`.
	 * Default `true`. `false` runs `fn` **exactly once**: the first transient
	 * error comes back as a `DataError` whose
	 * `hasErrorLabel('TransientTransactionError')` is true, for the caller's
	 * own bounded retry. A failed commit is not retried either. It belongs to
	 * this call alone: a joined transaction refuses it.
	 */
	retryTransient?: boolean;
};

/** A session, read without `instanceof`: two copies of the driver. */
function isSession(host: TransactionHost): host is ClientSession {
	return typeof (host as ClientSession).inTransaction === 'function';
}

/**
 * The one label the driver acts on when it comes out of the callback: it
 * aborts and reruns `fn`. `UnknownTransactionCommitResult` there is passed
 * on as it is (the driver takes it as a manual commit), so it is not handed
 * back.
 */
const RETRY_LABEL = 'TransientTransactionError';

/**
 * `fn`, with a transient driver error handed back as the driver's own.
 *
 * The driver retries only an error that is its own `MongoError` labelled
 * `TransientTransactionError`, and a collection method has already turned that error into a
 * `DataError`. The driver error sits on its `cause`: throwing that one lets
 * the driver see it. Whatever else `fn` throws goes through unchanged.
 */
function retryableByDriver<T>(
	fn: (session: ClientSession) => Promise<T>,
): (session: ClientSession) => Promise<T> {
	return async (session) => {
		try {
			return await fn(session);
		} catch (error) {
			if (error instanceof DataError) {
				const cause = error.cause as
					| { hasErrorLabel?: (label: string) => boolean }
					| undefined;
				if (
					typeof cause?.hasErrorLabel === 'function' &&
					cause.hasErrorLabel(RETRY_LABEL)
				) {
					throw cause;
				}
			}
			throw error;
		}
	};
}

/**
 * `fn` in a transaction, run exactly once: started, `fn`, committed, and
 * aborted on any error, which is then rethrown as it is.
 *
 * The driver's `session.withTransaction` is not used: it also reruns `fn`
 * when the commit fails with `TransientTransactionError`, and it retries a
 * raw driver error thrown through `.raw`.
 */
async function runOnce<T>(
	session: ClientSession,
	fn: (session: ClientSession) => Promise<T>,
	options: TransactionOptions | undefined,
): Promise<T> {
	session.startTransaction(options);
	try {
		const result = await fn(session);
		await session.commitTransaction();
		return result;
	} catch (error) {
		if (session.inTransaction()) {
			await session.abortTransaction().catch(() => {});
		}
		throw error;
	}
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
 * - it **retries `fn`** from the start on a `TransientTransactionError`, until
 *   120 seconds have passed (and the commit alone when the commit reports an
 *   unknown result). `fn` must therefore be safe to run twice, or the call
 *   given `retryTransient: false`, which runs `fn` once and hands the first
 *   transient error back for the caller's own bounded retry. A failure
 *   labelled transient that will happen again every time, such as a
 *   deterministic collision the server aborts the transaction for, is retried
 *   for the whole window; what comes back at the end is a `DataError` whose
 *   `cause` is the driver's error (its timeout error, when the client was
 *   given a `timeoutMS`).
 * - `session.abortTransaction()` inside `fn` ends the transaction without
 *   throwing: `withTransaction` then resolves.
 */
export async function withTransaction<T>(
	host: TransactionHost,
	fn: (session: ClientSession) => Promise<T>,
	options?: WithTransactionOptions,
): Promise<T> {
	const { retryTransient = true, ...driverOptions } = options ?? {};
	const transactionOptions =
		options && Object.keys(driverOptions).length > 0
			? (driverOptions as TransactionOptions)
			: undefined;
	try {
		if (isSession(host)) {
			if (host.inTransaction()) {
				if (options) {
					throw new TypeError(
						'withTransaction: this session is already in a transaction, which ' +
							'this call joins. MongoDB has no savepoints, so the read ' +
							'concern, the write concern, the read preference and ' +
							'`retryTransient` are the outer transaction’s.',
					);
				}
				return await fn(host);
			}
			return retryTransient
				? await host.withTransaction(retryableByDriver(fn), transactionOptions)
				: await runOnce(host, fn, transactionOptions);
		}

		const session = host.startSession();
		try {
			return retryTransient
				? await session.withTransaction(
						retryableByDriver(fn),
						transactionOptions,
					)
				: await runOnce(session, fn, transactionOptions);
		} finally {
			await session.endSession();
		}
	} catch (error) {
		throw toDataError(error);
	}
}
