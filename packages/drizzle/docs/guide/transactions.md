# Transactions

`withTransaction` runs a function in a transaction: committed when it
resolves, rolled back when it throws, and a database error turned into a
[`DataError`](errors.md) on the way out.

```ts
import { withTransaction } from '@nxgt/drizzle/pg';
import { teamRepository, userRepository } from './repositories';
import { db } from './db';

const team = await withTransaction(db, async (tx) => {
	const created = await teamRepository.with(tx).create({ name: 'Core' });
	await userRepository.with(tx).update(userId, { teamId: created.id });
	return created;
});
```

Whatever the callback returns is what `withTransaction` resolves to.

## `with(tx)`, every time

A repository runs on the database it was created with. Inside the callback,
`repository.with(tx)` gives the same repository on the transaction; a call on
the original repository runs **outside** it — and on a single-connection
driver such as PGlite, it waits for a connection the transaction is holding,
forever.

```ts
await withTransaction(db, async (tx) => {
	await userRepository.with(tx).create({ email });   // in the transaction
	await userRepository.create({ email: other });     // outside it: do not
	await tx.insert(auditEntries).values({ action: 'import' }); // tx is a Drizzle database
});
```

`tx` is an ordinary Drizzle database, so raw statements and
`createRepository(tx, table)` both work.

## What it does with an error

| The callback | `withTransaction` |
| --- | --- |
| resolves | commits, and resolves to its value |
| throws a database error | rolls back, and throws the matching `DataError` (`ConflictError`, `ForeignKeyError`…) |
| throws anything else | rolls back, and rethrows it unchanged |
| calls `tx.rollback()` | rolls back, and throws Drizzle's `TransactionRollbackError` |

```ts
import { ConflictError } from '@nxgt/drizzle';

try {
	await withTransaction(db, async (tx) => {
		await tx.insert(teams).values({ name: 'Core' });
		await tx.insert(teams).values({ name: 'Core' }); // the unique constraint
	});
} catch (error) {
	if (error instanceof ConflictError) {
		// Nothing was written: the whole transaction was rolled back.
	}
}
```

Raw statements inside the callback are mapped too, not only repository calls:
the mapping happens where the transaction ends.

## Nested: a savepoint

Given a transaction instead of a database, `withTransaction` opens a
savepoint in it, as Drizzle does. A failure inside rolls back to the
savepoint, and the outer transaction goes on:

```ts
await withTransaction(db, async (tx) => {
	await auditRepository.with(tx).create({ action: 'import' });

	for (const row of rows) {
		// One bad row loses that row, not the audit entry and not the rest.
		await withTransaction(tx, async (savepoint) => {
			await importRepository.with(savepoint).create(row);
		}).catch(report);
	}
});
```

## Isolation

The third argument is Drizzle's `PgTransactionConfig`:

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `isolationLevel` | `'read uncommitted' \| 'read committed' \| 'repeatable read' \| 'serializable'` | the server's (`read committed`) | PostgreSQL's isolation level for this transaction |
| `accessMode` | `'read only' \| 'read write'` | the server's | a read-only transaction refuses every write |
| `deferrable` | `boolean` | `false` | only with `serializable` + `read only` |

```ts
const report = await withTransaction(
	db,
	async (tx) => {
		const page = await userRepository.with(tx).paginate({ page: 1 });
		return summarise(page); // the count and the page see the same snapshot
	},
	{ isolationLevel: 'repeatable read', accessMode: 'read only' },
);
```

A config on a **nested** call throws a `TypeError` before anything is sent: a
savepoint has no isolation level of its own.

```ts
await withTransaction(tx, fn, { isolationLevel: 'serializable' });
// TypeError: withTransaction: a nested transaction is a savepoint, which takes
// no isolation level or access mode
```

A `serializable` transaction can be refused by PostgreSQL with SQLSTATE
`40001`, which arrives as a `DataError` with `code: 'DATABASE'` and
`sqlState: '40001'`. Retrying it is the caller's decision — this package does
not retry.

## Signature

```ts
function withTransaction<TDb extends PgDatabase, T>(
	db: TDb,
	fn: (tx: TransactionOf<TDb>) => Promise<T>,
	config?: PgTransactionConfig,
): Promise<T>;

/** The transaction type of that database's driver. */
type TransactionOf<TDb extends PgDatabase> = Parameters<Parameters<TDb['transaction']>[0]>[0];
```

`TransactionOf` keeps the driver's own transaction type, so a helper that
takes one stays typed:

```ts
import type { TransactionOf } from '@nxgt/drizzle/pg';
import type { db } from './db';

async function chargeCustomer(tx: TransactionOf<typeof db>, id: string) {
	await customerRepository.with(tx).update(id, { charged: true });
}
```
