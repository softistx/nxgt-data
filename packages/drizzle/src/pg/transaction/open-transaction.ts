import { AsyncLocalStorage } from 'node:async_hooks';
import type { PgDatabase } from '../repository/types';

/** The database an open transaction is on, and whether it is still open. */
interface Held {
	readonly db: PgDatabase;
	open: boolean;
}

/**
 * The database an open `withTransaction` is holding, for the calls running
 * inside it.
 *
 * Only the **outermost** transaction stores one. A nested `withTransaction`
 * opens a savepoint on the connection the outer one already holds, so a
 * repository bound to that outer transaction goes on working inside the
 * savepoint and must not be refused.
 */
const held = new AsyncLocalStorage<Held>();

/**
 * Runs `fn` with `db` recorded as the database an open transaction holds,
 * until it commits or rolls back.
 *
 * The record is **closed** when `fn` settles, and not merely left behind with
 * the async context. A context outlives the call that made it: a promise
 * created inside `fn` and awaited after the commit still reads this store,
 * and without `open` it was refused although the connection was back in the
 * pool and the call would have worked. Worse, a fire-and-forget one —
 * `setTimeout(() => { void repository.findMany() })` — became an unhandled
 * rejection, which ends the process in Bun. Both measured on bun 1.4.2;
 * `@nxgt/mongo`'s `subscription.ts` holds a closeable state in its own
 * `AsyncLocalStorage` for the same reason.
 */
export async function whileHolding<T>(
	db: PgDatabase,
	fn: () => Promise<T>,
): Promise<T> {
	const state: Held = { db, open: true };
	try {
		return await held.run(state, fn);
	} finally {
		state.open = false;
	}
}

/**
 * Refuses a repository bound to the database an open transaction is holding.
 *
 * Without this the call simply never returns: the transaction has taken a
 * connection out of the pool and does not give it back until it commits or
 * rolls back, and a repository on the outer `db` asks the pool for another
 * one — which, on a pool of one, nobody will ever hand over. Measured on
 * PGlite 0.5.8, where the pool is a single connection: the call waits, the
 * transaction waits for the call, and the spec runs out of time with no
 * error to show for it.
 *
 * A bare `TypeError`, not `ArgumentError`. The rule in `AGENTS.md` splits on
 * where the value came from, and a repository bound to the wrong database is
 * wiring: no request can produce it, and no handler should answer it with a
 * 400. Giving it `ArgumentError` cost a `error.argument === 'db' ? 500 : 400`
 * carve-out in five documents — every consumer string-matching an argument
 * name to avoid answering 400 to a deadlock, which is the exact thing the
 * class-and-code distinction exists to prevent. `ArgumentError` extends
 * `TypeError`, so a handler that catches `TypeError` sees this either way.
 *
 * `explicit` is what `.with()` sets, and it turns the refusal off — including
 * `.with(db)`, which is how a caller says they mean the database itself and
 * want work that survives a rollback. Whether that then *works* is the
 * driver's business: with a real pool it takes another connection, and on a
 * single-connection driver it deadlocks exactly as before. The refusal is for
 * the repository nobody re-bound, which is the mistake; `.with(db)` is a
 * sentence somebody wrote on purpose.
 *
 * The message names the table rather than the method. Every method on this
 * repository fails here, for the same reason and with the same fix, so a
 * method name would vary without telling the reader anything the table does
 * not — unlike `paginate` and `paginateByCursor`, which share option names
 * and genuinely need telling apart. The stack names the method anyway.
 */
export function refuseHeldDatabase(
	table: string,
	db: PgDatabase,
	explicit: boolean,
): void {
	const state = held.getStore();
	if (explicit || !state?.open || state.db !== db) return;
	throw new TypeError(
		`The repository for "${table}" is bound to the database withTransaction ` +
			'is holding open, so this call would wait for a connection that ' +
			'transaction will not release until it ends, and never return. Call ' +
			'.with(tx) to run it in the transaction, or .with(db) to say you mean ' +
			'the database itself.',
	);
}
