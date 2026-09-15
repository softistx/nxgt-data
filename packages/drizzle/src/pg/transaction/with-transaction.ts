import { is } from 'drizzle-orm';
import {
	PgAsyncTransaction,
	type PgTransactionConfig,
} from 'drizzle-orm/pg-core';
import { toDataError } from '../../errors/to-data-error';
import type { PgDatabase } from '../repository/types';

/** The transaction a database's `transaction` callback receives. */
export type TransactionOf<TDb extends PgDatabase> = Parameters<
	Parameters<TDb['transaction']>[0]
>[0];

/**
 * Runs `fn` in a transaction: committed when it resolves, rolled back when it
 * throws, and a database error turned into a `DataError` on the way out.
 * Given a transaction, it opens a savepoint in it, as Drizzle does: a failure
 * inside rolls back to the savepoint, and the outer transaction goes on.
 *
 * ```ts
 * await withTransaction(db, async (tx) => {
 *   const team = await teams.with(tx).create({ name: 'Core' });
 *   await users.with(tx).update(userId, { teamId: team.id });
 * });
 * ```
 */
export async function withTransaction<TDb extends PgDatabase, T>(
	db: TDb,
	fn: (tx: TransactionOf<TDb>) => Promise<T>,
	config?: PgTransactionConfig,
): Promise<T> {
	if (config && is(db, PgAsyncTransaction)) {
		throw new TypeError(
			'withTransaction: a nested transaction is a savepoint, which takes no isolation level or access mode',
		);
	}
	try {
		return await db.transaction(fn as never, config);
	} catch (error) {
		throw toDataError(error);
	}
}
