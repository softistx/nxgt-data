# Errors

What the database refused is a `DataError`, with a `code` you can switch on
and the fields the database sent; what the *call* got wrong is an
`ArgumentError`. A unique violation becomes a 409, and a bad `orderBy` a 400,
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
| `InvalidValueError` | `INVALID_VALUE` | a value the column's type could not read: `22P02`, `22001`, `22003`, `22007`, `22008` |
| `InvalidCursorError` | `INVALID_CURSOR` | a cursor this package did not write, or wrote for another ordering. The message [names the call and the table](pagination.md#cursor-pages) |
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
it is the safe one to show — on a constraint violation. On an
[`InvalidValueError`](#invalidvalueerror-a-value-the-column-refused) the
message is the database's own sentence, and that one can hold the value.

## `InvalidValueError`: a value the column refused

The caller handed a value the column's type could not read: `'nope'` where a
`uuid` goes, a number past `integer`, a date that is not one. It is the
input, not the query, so it is a **400** — the same answer as
`InvalidCursorError`, and not the 500 that `code: 'DATABASE'` means.

```ts
import { Hono } from 'hono';
import { InvalidValueError } from '@nxgt/drizzle';
import { createRepository } from '@nxgt/drizzle/pg';
import { db } from './db';
import { users } from './schema';

const userRepository = createRepository(db, users);

export const app = new Hono().get('/users/:id', async (c) => {
	try {
		// A path parameter a client mistyped, handed straight to the repository.
		const user = await userRepository.findById(c.req.param('id'));
		return user ? c.json(user) : c.json({ error: 'No such user' }, 404);
	} catch (error) {
		if (error instanceof InvalidValueError) {
			error.code; // 'INVALID_VALUE'
			error.sqlState; // '22P02'
			error.message; // 'invalid input syntax for type uuid: "nope"'
			return c.json({ error: 'Invalid id' }, 400);
		}
		throw error;
	}
});
```

| SQLSTATE | What it is |
| --- | --- |
| `22P02` | the text is not a value of that type: `invalid input syntax for type uuid` |
| `22001` | longer than the column — measured, only on an *assignment* to a column; `'abcdef'::varchar(3)` truncates instead |
| `22003` | out of the type's range: `2147483648::integer` |
| `22007` | text where a date or a time goes |
| `22008` | a date or a time that is not one: `'2026-13-45'::timestamptz` |

Two measured facts about this family, on PGlite 0.5.8:

- **It carries nothing but the sentence.** No `table`, no `column`, no
  `detail` — so `table` is `undefined` and `columns` is `[]`, where a
  constraint violation fills both. There is nothing to read the column name
  out of.
- **The sentence can hold the refused value**, since it is the database's
  own: `invalid input syntax for type uuid: "nope"`. Log it; answer the
  client with a sentence of your own.

**A division by zero is not one of these.** `22012` is the query, not a value
handed to it, so it stays a `DataError` with `code: 'DATABASE'` and is a 500
like any other failing statement.

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

## `ArgumentError`: what the call said

`DataError` is what the **database** said. `ArgumentError` is what the *call*
said — an argument refused before any SQL is built — and the two are worth
telling apart, because a `where` or an `orderBy` assembled from a query string
is user input: the answer is 400, not 500.

```ts
import { ArgumentError } from '@nxgt/drizzle';

try {
	await userRepository.findMany({ where: { teamId: maybeTeamId } });
} catch (error) {
	if (error instanceof ArgumentError) {
		error.code;     // 'INVALID_ARGUMENT'
		error.argument; // 'where' — which argument was refused
		error.key;      // 'teamId', or undefined when the whole argument is wrong
	}
	throw error;
}
```

```ts
class ArgumentError extends TypeError {
	readonly code: 'INVALID_ARGUMENT';
	/** The argument it is about: `where`, `orderBy`, `paginateByCursor`. */
	readonly argument: string;
	/** The key inside that argument, when one is at fault. */
	readonly key: string | undefined;

	constructor(
		argument: string,
		message: string,
		options?: { key?: string | undefined; cause?: unknown },
	);
}
```

It extends **`TypeError`**, not `Error`: these were bare `TypeError`s before
the class existed, so a `catch` that tests for `TypeError` keeps working and
gains a `code` to switch on instead of a message to match.

| `argument` | `key` | Refused |
| --- | --- | --- |
| `where` | — | a `where` that is neither a Drizzle condition nor an object |
| `where` | the key | a key set to `undefined` — dropped, `{ id: undefined }` would match every row |
| `where` | the key | a key that is not a column of the table |
| `where` | — | `updateMany`, `deleteMany` or `hardDeleteMany` with an empty `where`; pass `` sql`true` `` to mean every row |
| `orderBy` | — | an `orderBy` that is not an ordering, a list or an object |
| `orderBy` | the key | a key that is not a column, or a direction that is not `'asc'` or `'desc'` |
| `paginateByCursor` | the key | an `orderBy` column the table does not have |

`ArgumentError` is **not** a `DataError`: `error instanceof DataError` is
false, and a handler that only catches `DataError` lets it through.

## One handler for the app

Map the code once, at the edge, and let every route throw.

```ts
import { Hono } from 'hono';
import { ArgumentError, DataError, type DataErrorCode } from '@nxgt/drizzle';

const STATUS: Record<DataErrorCode, 400 | 404 | 409 | 422 | 500> = {
	NOT_FOUND: 404,
	CONFLICT: 409,
	FOREIGN_KEY: 422,
	CHECK_VIOLATION: 422,
	NOT_NULL_VIOLATION: 422,
	// Both are the client's input rather than the query's own doing.
	INVALID_VALUE: 400,
	INVALID_CURSOR: 400,
	DATABASE: 500,
};

export const app = new Hono().onError((error, c) => {
	// What the call said, not what the database said: the client's input.
	if (error instanceof ArgumentError) {
		return c.json({ error: error.message, argument: error.argument }, 400);
	}
	if (error instanceof RangeError) return c.json({ error: error.message }, 400);
	if (!(error instanceof DataError)) return c.json({ error: 'Internal error' }, 500);

	// `detail` can hold the refused value: it goes to the log, not to the client.
	console.error({ code: error.code, constraint: error.constraint, detail: error.detail });
	return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
});
```

`RangeError` is there for
[`paginate({ page: 0 })`](pagination.md#offset-pages), which is a client's
input like the rest; its message names the call and the table —
`paginate on "users": page must be an integer of at least 1, not 0` — so the
log line says which listing refused, not only which option. `ArgumentError` comes first because it **is** a
`TypeError`, and a later `instanceof TypeError` branch would swallow it.

## Two other errors that are not `DataError`

- **`TypeError`** is left for a mistake in the wiring rather than in a call: a
  table whose primary key needs the `primaryKey` option, a `restore` on a
  table with no soft delete, a config on a nested
  [`withTransaction`](transactions.md#isolation). The message says what to
  change. `ArgumentError` extends it, so a `catch` on `TypeError` takes both.
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
// InvalidValueError, InvalidCursorError: new X(message?, options?: DataErrorOptions)

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
