# Errors

Every failure this package reports is a `DataError`, with a `code` you can
switch on and the fields the database sent. A unique violation becomes a 409
without anyone parsing a driver message.

```ts
import { ConflictError } from '@nxgt/drizzle';

try {
	await userRepository.create({ email });
} catch (error) {
	if (error instanceof ConflictError && error.columns.includes('email')) {
		return { status: 409, body: 'This email is taken' };
	}
	throw error;
}
```

The classes come from `@nxgt/drizzle`; the repository, `paginate` and
`withTransaction` in `@nxgt/drizzle/pg` throw those same classes, so
`instanceof` works across the two subpaths.

## The classes

| Class | `code` | Thrown when |
| --- | --- | --- |
| `NotFoundError` | `NOT_FOUND` | `getById`, `update(id)`, `delete(id)`, `restore(id)` or `hardDelete(id)` matched no row |
| `ConflictError` | `CONFLICT` | a unique constraint refused the write — SQLSTATE `23505` |
| `ForeignKeyError` | `FOREIGN_KEY` | `23503`: the parent row is missing, or a child still points at the row being deleted |
| `CheckViolationError` | `CHECK_VIOLATION` | `23514` |
| `NotNullViolationError` | `NOT_NULL_VIOLATION` | `23502` |
| `InvalidCursorError` | `INVALID_CURSOR` | a cursor this package did not write, or wrote for another ordering |
| `DataError` | `DATABASE` | any other database error; `sqlState` says which |

All of them extend `DataError`, so one `catch` can take the group:

```ts
import { DataError } from '@nxgt/drizzle';

if (error instanceof DataError) log.warn({ code: error.code, sqlState: error.sqlState });
```

`code` is the field to switch on: it survives a build that ends up with two
copies of the package, which `instanceof` does not.

## What an error carries

| Property | Type | Holds |
| --- | --- | --- |
| `code` | `DataErrorCode` | which error this is |
| `sqlState` | `string \| undefined` | the SQLSTATE the database answered with, `'23505'`… |
| `table` | `string \| undefined` | the table the database named |
| `constraint` | `string \| undefined` | the constraint it named: `'users_email_unique'` |
| `columns` | `readonly string[]` | the columns involved, read from the detail line; `[]` when there are none |
| `detail` | `string \| undefined` | the database's own detail line |
| `cause` | `unknown` | the error this one was made from: Drizzle's `DrizzleQueryError`, with the driver's inside |
| `id` | `unknown` | `NotFoundError` only: the id that was looked for |

```ts
try {
	await userRepository.create({ email: 'ada@example.com' });
} catch (error) {
	if (error instanceof ConflictError) {
		error.message;    // 'Unique constraint "users_email_unique" violated on "users"'
		error.constraint; // 'users_email_unique'
		error.columns;    // ['email']
		error.table;      // 'users'
	}
	throw error;
}
```

**`detail` can hold the value that was refused** —
`Key (email)=(ada@example.com) already exists.` Log it, do not send it to a
client. The `message` names the constraint and the table only, which is why
it is the safe one to show.

## Your own queries

The repository, `paginate` and `withTransaction` map errors themselves. For a
statement you wrote with Drizzle, `toDataError`:

```ts
import { toDataError } from '@nxgt/drizzle';

try {
	await db.insert(orders).values(rows);
} catch (error) {
	throw toDataError(error);
}
```

```ts
function toDataError(error: unknown): unknown;
```

It returns `unknown` on purpose: what goes in may not be a database error.

- It reads the SQLSTATE on the error, or anywhere down its `cause` chain (up
  to eight links), so it takes Drizzle's `DrizzleQueryError` and a bare
  driver error alike.
- It reads both field spellings: `constraint`/`table` (`node-postgres`,
  PGlite) and `constraint_name`/`table_name` (`postgres.js`).
- An error with no SQLSTATE — a `TypeError`, an aborted fetch — comes back
  unchanged, and a `DataError` comes back as it is. `throw toDataError(error)`
  is always safe in a `catch`.

## One handler for the app

Map the code once, at the edge, and let every route throw.

```ts
import { Hono } from 'hono';
import { DataError, type DataErrorCode } from '@nxgt/drizzle';

const STATUS: Record<DataErrorCode, 400 | 404 | 409 | 422 | 500> = {
	NOT_FOUND: 404,
	CONFLICT: 409,
	FOREIGN_KEY: 422,
	CHECK_VIOLATION: 422,
	NOT_NULL_VIOLATION: 422,
	INVALID_CURSOR: 400,
	DATABASE: 500,
};

export const app = new Hono().onError((error, c) => {
	if (error instanceof RangeError) return c.json({ error: error.message }, 400);
	if (!(error instanceof DataError)) return c.json({ error: 'Internal error' }, 500);

	// `detail` can hold the refused value: it goes to the log, not to the client.
	console.error({ code: error.code, constraint: error.constraint, detail: error.detail });
	return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
});
```

`RangeError` is there for
[`paginate({ page: 0 })`](pagination.md#offset-pages), which is a client's
input like the rest.

## Two errors that are not `DataError`

- **`TypeError`** is a programming mistake, not a database answer: a `where`
  key set to `undefined`, an `updateMany` with no `where`, a table whose
  primary key needs the `primaryKey` option, a config on a nested
  [`withTransaction`](transactions.md#isolation). The message says what to
  change.
- **`RangeError`** is a `page`, `pageSize` or `limit` that is not a positive
  integer.

## Making one yourself

The classes are exported, so a service layer can raise the same errors as the
repository and the handler above will answer them:

```ts
import { NotFoundError } from '@nxgt/drizzle';

export async function getInvoice(id: string) {
	const invoice = await cache.get(id);
	if (!invoice) throw new NotFoundError(`No invoice ${id}`, { table: 'invoices', id });
	return invoice;
}
```

```ts
class DataError extends Error {
	constructor(message: string, options?: DataErrorOptions & { code?: DataErrorCode });
}
class NotFoundError extends DataError {
	constructor(message?: string, options?: Omit<DataErrorOptions, 'sqlState'> & { id?: unknown });
}
// ConflictError, ForeignKeyError, CheckViolationError, NotNullViolationError,
// InvalidCursorError: new X(message?, options?: DataErrorOptions)

interface DataErrorOptions {
	cause?: unknown;
	sqlState?: string | undefined;
	table?: string | undefined;
	constraint?: string | undefined;
	columns?: readonly string[] | undefined;
	detail?: string | undefined;
}
```

Error messages, symptom by symptom, are in
[troubleshooting.md](../troubleshooting.md).
