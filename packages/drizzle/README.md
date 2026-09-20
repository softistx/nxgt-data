# @nxgt/drizzle

The code you write around every table in a [Drizzle ORM](https://orm.drizzle.team)
app, written once: a typed repository per table, offset and cursor pagination,
transactions, database errors you can `instanceof`, and the columns every
table has.

```ts
const users = createRepository(db, usersTable);

const ada = await users.create({ email: 'ada@example.com' });
await users.update(ada.id, { name: 'Ada' });
const page = await users.paginate({ where: { teamId: 1 }, page: 2 });
```

Everything is typed from the table: rows are `table.$inferSelect`, what
`create` takes is `table.$inferInsert`, a `where` object only takes the
table's columns, with their types.

PostgreSQL today, through any Drizzle driver (`node-postgres`,
`postgres-js`, PGlite, Neon…). MySQL and SQLite will come as their own
subpaths.

> **0.x, on drizzle-orm 1.0 (RC).** The API is still settling.

## Install

```sh
bun add @nxgt/drizzle drizzle-orm@rc
```

- `drizzle-orm` `>=1.0.0-rc.4 <2`: required peer. This package builds on
  Drizzle 1.0; it does not run on 0.x.
- `typescript` 6: required peer, the version every `@nxgt` package pins.
- A driver for Drizzle: yours.

## Setup

Declare the table with the column helpers, or with your own columns:

```ts
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { id, softDelete, timestamps } from '@nxgt/drizzle/pg';

export const users = pgTable('users', {
	id: id(), // uuid primary key default gen_random_uuid()
	email: text('email').notNull().unique(),
	name: text('name'),
	teamId: integer('team_id'),
	...timestamps(), // createdAt, updatedAt
	...softDelete(), // deletedAt
});
```

Then a repository per table, on your database:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { createRepository } from '@nxgt/drizzle/pg';

export const db = drizzle(process.env.DATABASE_URL!);
export const userRepository = createRepository(db, users);
```

| Option | Default | |
| --- | --- | --- |
| `primaryKey` | `'id'` | the key of the column `findById`, `update(id)` and `delete(id)` use. See [Primary keys](#primary-keys) |
| `softDelete` | on when the table has a `deletedAt` column | `false` makes `delete` a real `DELETE`. See [Soft delete](#soft-delete) |
| `touchUpdatedAt` | `true` | sets the `updatedAt` column to `now()` on update. See [updatedAt](#updatedat) |
| `maxPageSize` | `100` | the largest `pageSize` or `limit` a page may ask for; a larger one is lowered to it |

## Subpaths

| Import | For |
| --- | --- |
| `@nxgt/drizzle` | what does not depend on a database: the errors, `toDataError`, the cursor and the page types |
| `@nxgt/drizzle/pg` | PostgreSQL: `createRepository`, `paginate`, `withTransaction`, the column helpers |

The errors `@nxgt/drizzle/pg` throws are the classes `@nxgt/drizzle`
exports: `instanceof` works across the two.

## Repository

### Reading

```ts
await users.findById(id); // the row, or undefined
await users.getById(id); // the row, or throws NotFoundError
await users.findFirst({ email: 'ada@example.com' });
await users.findMany({
	where: { teamId: 1 },
	orderBy: { createdAt: 'desc' },
	limit: 20,
	offset: 40,
});
await users.count({ teamId: 1 });
await users.exists({ email: 'ada@example.com' });
```

### Where

A `where` is an object of equalities, or any Drizzle condition:

```ts
import { and, gt, ilike } from 'drizzle-orm';

await users.findMany({ where: { teamId: 1, name: null } }); // team_id = 1 and name is null
await users.findMany({ where: and(gt(usersTable.createdAt, since), ilike(usersTable.name, 'a%')) });
```

In an object, keys are joined with `AND` and `null` matches `IS NULL`. A key
set to `undefined` throws an `ArgumentError` instead of being left out: left
out, `{ id: maybeId }` would match every row.

### Ordering

`orderBy` takes an object of directions, in its key order, or anything
Drizzle's `orderBy` takes:

```ts
import { asc, desc } from 'drizzle-orm';

await users.findMany({ orderBy: { teamId: 'asc', createdAt: 'desc' } });
await users.findMany({ orderBy: [asc(usersTable.teamId), desc(usersTable.createdAt)] });
```

### Writing

```ts
const ada = await users.create({ email: 'ada@example.com' }); // the row, with its defaults
const rows = await users.createMany([{ email: 'a@example.com' }, { email: 'b@example.com' }]);

await users.update(ada.id, { name: 'Ada' }); // the row, or throws NotFoundError
await users.update(ada.id, { loginCount: sql`${usersTable.loginCount} + 1` });
await users.updateMany({ teamId: 1 }, { teamId: 2 }); // the rows

await users.delete(ada.id); // the row, or throws NotFoundError
await users.deleteMany({ teamId: 2 }); // the rows
```

`createMany([])` sends nothing and returns `[]`. `update(id, {})` sends no
update and returns the row. `updateMany` and `deleteMany` need a `where`:
pass `` sql`true` `` to target every row.

### Primary keys

The methods by id use the column under the key `id`. For a table whose key
is another column, name it; that types the id too:

```ts
const tags = pgTable('tags', { slug: text('slug').primaryKey(), label: text('label') });
const tagRepository = createRepository(db, tags, { primaryKey: 'slug' });
await tagRepository.getById('drizzle');
```

A table with a composite primary key, or none, has no method by id: they do
not compile, and throw a `TypeError` that says why. Its other methods work,
and `primaryKey` can name any unique column.

### Soft delete

A table with a `deletedAt` column is soft-deleted:

- `delete` and `deleteMany` set `deletedAt` to `now()`, and return the rows.
- every read leaves soft-deleted rows out. `withDeleted: true` keeps them:

```ts
await users.findById(id, { withDeleted: true });
await users.findMany({ withDeleted: true });
await users.count(undefined, { withDeleted: true });
```

- `update` and `updateMany` only touch live rows: restore a row first.
- three more methods: `restore(id)` clears `deletedAt`; `hardDelete(id)` and
  `hardDeleteMany(where)` really delete, soft-deleted rows included. They
  exist only on a table with soft delete, in the types too.

`createRepository(db, table, { softDelete: false })` turns it off.

### updatedAt

On a table with an `updatedAt` column, `update`, `updateMany`, `delete`
(soft) and `restore` set it to `now()`, unless the patch sets it. A column
declared with `$onUpdate`, as `timestamps()` declares it, is left to Drizzle.
`touchUpdatedAt: false` turns it off.

```ts
// `postsTable.updatedAt` is a plain timestamp column, declared without
// `$onUpdate` — so the repository is what sets it.
const posts = createRepository(db, postsTable);
const post = await posts.create({ title: 'a' });          // updatedAt: null

await posts.update(post.id, { title: 'b' });              // updatedAt: now()
await posts.update(post.id, { updatedAt: new Date(0) });  // kept: the patch wins

const untouched = createRepository(db, postsTable, { touchUpdatedAt: false });
await untouched.update(post.id, { title: 'c' });          // updatedAt: still null
```

### Running on a transaction

A repository runs on the database it was given. `with(tx)` gives the same
repository on a transaction:

```ts
await withTransaction(db, async (tx) => {
	const team = await teamRepository.with(tx).create({ name: 'Core' });
	await userRepository.with(tx).update(userId, { teamId: team.id });
});
```

A repository can also be created on a transaction directly:
`createRepository(tx, users)`.

## Pagination

### Offset

```ts
const page = await users.paginate({ page: 2, pageSize: 20, where: { teamId: 1 } });
// { items, total, page: 2, pageSize: 20, pageCount }
```

`page` is 1-based, and `pageSize` defaults to 20. Without `orderBy`, rows
are ordered by the primary key, so pages do not overlap. A page past the
last one has no items and the same `total`. A `page` or `pageSize` that is
not a positive integer throws a `RangeError` naming the call and the table:

```ts
await users.paginate({ page: 0 });
// RangeError: paginate on "users": page must be an integer of at least 1, not 0
```

### Cursor

```ts
const first = await users.paginateByCursor({ limit: 20 });
// { items, nextCursor }
const second = await users.paginateByCursor({ limit: 20, after: first.nextCursor });
```

`nextCursor` is `null` on the last page. It is an opaque, URL-safe string,
for a client to send back as it is.

Rows are ordered by the primary key, or along another column, followed by
the primary key to break its ties:

```ts
await users.paginateByCursor({ orderBy: 'createdAt', direction: 'desc', after });
```

A cursor written for another ordering, or not by this package, throws
`InvalidCursorError`. It names the call and the table too, after the lead a
consumer searches for:

```ts
await users.paginateByCursor({ after: 'garbage' });
// InvalidCursorError: Invalid cursor in paginateByCursor on "users": it cannot be decoded
```

### Any query

`paginate` pages any select, joins included, and counts it:

```ts
import { eq } from 'drizzle-orm';
import { paginate } from '@nxgt/drizzle/pg';

const page = await paginate(
	db,
	db
		.select({ email: users.email, team: teams.name })
		.from(users)
		.innerJoin(teams, eq(users.teamId, teams.id))
		.orderBy(users.email),
	{ page: 1, pageSize: 50 },
);
// Page<{ email: string; team: string }>
```

The total is a `count(*)` over the query as a subquery. The query must not
have a `limit` or an `offset` yet; the types refuse one that does.

## Transactions

```ts
import { withTransaction } from '@nxgt/drizzle/pg';

const order = await withTransaction(db, async (tx) => {
	const created = await orders.with(tx).create({ customerId });
	await stock.with(tx).updateMany({ productId }, { reserved: sql`reserved + 1` });
	return created;
});
```

It commits when `fn` resolves and rolls back when it throws, then rethrows,
with a database error turned into a [`DataError`](#errors). Given a
transaction, it opens a savepoint: a failure inside rolls back to the
savepoint, and the outer transaction goes on.

```ts
await withTransaction(db, async (tx) => {
	await audit.with(tx).create({ action: 'import' });
	await withTransaction(tx, async (savepoint) => importRows(savepoint)).catch(report);
});
```

The third argument is Drizzle's transaction config, at the top level only:

```ts
await withTransaction(db, fn, { isolationLevel: 'serializable' });
```

## Errors

Every error this package throws is a `DataError`, with a `code`:

| Class | `code` | When |
| --- | --- | --- |
| `NotFoundError` | `NOT_FOUND` | `getById`, `update(id)`, `delete(id)`, `restore(id)`, `hardDelete(id)` found no row |
| `ConflictError` | `CONFLICT` | a unique constraint refused the write: SQLSTATE `23505` |
| `ForeignKeyError` | `FOREIGN_KEY` | a foreign key refused it: `23503`, a missing parent or a row still referenced |
| `CheckViolationError` | `CHECK_VIOLATION` | a `CHECK` refused it: `23514` |
| `NotNullViolationError` | `NOT_NULL_VIOLATION` | a `NOT NULL` column got no value: `23502` |
| `InvalidValueError` | `INVALID_VALUE` | a value the column's type could not read: `22P02`, `22001`, `22003`, `22007`, `22008` |
| `InvalidCursorError` | `INVALID_CURSOR` | a cursor this package did not write |
| `DataError` | `DATABASE` | any other database error, with its `sqlState` |

```ts
import { ConflictError, NotFoundError } from '@nxgt/drizzle';

try {
	await users.create({ email });
} catch (error) {
	if (error instanceof ConflictError && error.columns.includes('email')) {
		return reply(409, 'This email is taken');
	}
	throw error;
}
```

Each carries what the database said: `sqlState`, `table`, `constraint`,
`columns` and `detail`. `cause` is the error it was made from: Drizzle's
`DrizzleQueryError`, with the query, around the driver's.

`InvalidValueError` is the caller's input rather than the query's own doing —
a `uuid` path parameter a client mistyped, a number past `integer`, a date
that is not one — so it is a **400**, beside `INVALID_CURSOR`:

```ts
import { InvalidValueError } from '@nxgt/drizzle';

if (error instanceof InvalidValueError) return reply(400, 'Invalid value');
```

Measured on PGlite 0.5.8, these five carry no `table`, no `column` and no
`detail`, so `table` is `undefined` and `columns` is `[]` where a constraint
violation fills both; the message is the database's own sentence —
`invalid input syntax for type uuid: "nope"` — and it can hold the value that
was refused, so log it rather than sending it on. A division by zero
(`22012`) is deliberately not one of them: that is the query, not a value
handed to it, and it stays a `DataError` with `code: 'DATABASE'`.

`ArgumentError` is the other half, and it is **not** a `DataError`: a
`DataError` is what the database said, an `ArgumentError` is what the call
said — a `where` that is not an object, a key that is not a column, a
direction that is not `'asc'`, an `updateMany` with no `where`. A `where`
built from a query string is user input, so a handler answers 400 rather than
500:

```ts
import { ArgumentError } from '@nxgt/drizzle';

if (error instanceof ArgumentError) {
	return reply(400, `${error.argument}: ${error.message}`); // code: 'INVALID_ARGUMENT'
}
```

It carries `argument` and `key`, and extends `TypeError`, so a `catch` written
against `TypeError` still matches it. Every case is in
[docs/guide/errors.md](docs/guide/errors.md).

The repository, `paginate` and `withTransaction` map errors themselves. For
your own queries, `toDataError`:

```ts
import { toDataError } from '@nxgt/drizzle';

try {
	await db.insert(orders).values(values);
} catch (error) {
	throw toDataError(error);
}
```

It reads the SQLSTATE on the error or anywhere down its `cause` chain, under
`node-postgres`, PGlite or `postgres.js` field names. An error with none, a
`TypeError` say, comes back as it is, so `throw toDataError(error)` is
always safe.

## Columns

```ts
import { id, softDelete, timestamps } from '@nxgt/drizzle/pg';

pgTable('teams', { id: id('identity'), name: text('name').notNull() });
```

| Helper | Gives |
| --- | --- |
| `id()` | `id uuid primary key default gen_random_uuid()` |
| `id('identity')` | `id integer primary key generated by default as identity` |
| `timestamps()` | `createdAt` and `updatedAt`, as `created_at` and `updated_at timestamptz(3) not null default now()`; `updatedAt` has `$onUpdate` |
| `softDelete()` | `deletedAt`, as `deleted_at timestamptz(3)`, nullable |

Each call returns new builders, as Drizzle needs: a builder cannot be shared
between two tables. The timestamps are to the millisecond, as a JavaScript
`Date` is: see [Traps](#traps).

## API

### The `@nxgt/drizzle` subpath

#### Error classes

- `class ArgumentError extends TypeError`: `code: 'INVALID_ARGUMENT'`, `argument: string`, `key: string | undefined`. `new ArgumentError(argument, message, options?: { key?: string; cause?: unknown })`.
- `class DataError extends Error`: `code: DataErrorCode`, `sqlState: string | undefined`, `table: string | undefined`, `constraint: string | undefined`, `columns: readonly string[]`, `detail: string | undefined`, `cause`. `new DataError(message, options?: DataErrorOptions & { code?: DataErrorCode })`.
- `class NotFoundError extends DataError`: adds `id: unknown`. `new NotFoundError(message = 'Not found', options?)`.
- `class ConflictError`, `class ForeignKeyError`, `class CheckViolationError`, `class NotNullViolationError`, `class InvalidValueError`, `class InvalidCursorError`, all `extends DataError`, all `new X(message?, options?: DataErrorOptions)`.
- `type DataErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'FOREIGN_KEY' | 'CHECK_VIOLATION' | 'NOT_NULL_VIOLATION' | 'INVALID_VALUE' | 'INVALID_CURSOR' | 'DATABASE'`.
- `interface DataErrorOptions { cause?; sqlState?; table?; constraint?; columns?; detail? }`.
- `toDataError(error: unknown): unknown`: the `DataError` for a database error, the error itself otherwise.

#### Pagination helpers

- `interface Page<T> { items: T[]; total: number; page: number; pageSize: number; pageCount: number }`.
- `interface CursorPage<T> { items: T[]; nextCursor: string | null }`.
- `interface PageOptions { page?: number; pageSize?: number }`.
- `pageWindow(options?: PageOptions, maxPageSize = 100, where?: string): PageWindow`: checks a page and turns it into `{ page, pageSize, limit, offset }`. `where` names the call in the `RangeError`, the way `paginate` names itself.
- `cursorLimit(limit: number | undefined, maxPageSize = 100, where?: string): number`: the cursor half of the same check — a `limit` lowered to the maximum, refused the same way.
- `toPage<T>(items: T[], total: number, window: PageWindow): Page<T>`.
- `encodeCursor(payload: CursorPayload): string` and `decodeCursor(cursor: string, expectedKey?: string, where?: string): CursorPayload`, with `CursorPayload = { key: string; values: readonly unknown[] }`: for a cursor pagination of your own. `Date` and `bigint` values survive the round trip, and `where` names the call in the `InvalidCursorError`.
- `DEFAULT_PAGE_SIZE = 20`, `DEFAULT_MAX_PAGE_SIZE = 100`.

### The `@nxgt/drizzle/pg` subpath

#### `createRepository(db, table, options?)`

```ts
function createRepository<TTable extends PgTable, TKey = 'id', TSoft = /* has deletedAt */>(
	db: PgDatabase,
	table: TTable,
	options?: RepositoryOptions<TTable, TKey, TSoft>,
): Repository<TTable, TKey, TSoft>;
```

`Repository<TTable, TKey, TSoft>`, where `Row` is `TTable['$inferSelect']`
and `Id` is `Row[TKey]`:

| Member | |
| --- | --- |
| `table`, `db` | what it was created with |
| `with(db: PgDatabase)` | the same repository on another database or transaction |
| `findById(id, options?: ReadOptions): Promise<Row \| undefined>` | |
| `getById(id, options?: ReadOptions): Promise<Row>` | throws `NotFoundError` |
| `findFirst(where?, options?: FindFirstOptions): Promise<Row \| undefined>` | `options.orderBy`, `options.withDeleted` |
| `findMany(options?: FindManyOptions): Promise<Row[]>` | `where`, `orderBy`, `limit`, `offset`, `withDeleted` |
| `create(values: Insert): Promise<Row>` | |
| `createMany(values: readonly Insert[]): Promise<Row[]>` | |
| `update(id, patch: Patch): Promise<Row>` | throws `NotFoundError` |
| `updateMany(where, patch: Patch): Promise<Row[]>` | |
| `delete(id): Promise<Row>` | soft on a table with soft delete; throws `NotFoundError` |
| `deleteMany(where): Promise<Row[]>` | |
| `count(where?, options?: ReadOptions): Promise<number>` | |
| `exists(where, options?: ReadOptions): Promise<boolean>` | |
| `paginate(options?: PaginateOptions): Promise<Page<Row>>` | `page`, `pageSize`, `where`, `orderBy`, `withDeleted` |
| `paginateByCursor(options?: CursorPaginateOptions): Promise<CursorPage<Row>>` | `after`, `limit`, `where`, `orderBy` (a column key), `direction`, `withDeleted` |
| `restore(id): Promise<Row>` | soft delete only; throws `NotFoundError` |
| `hardDelete(id): Promise<Row>` | soft delete only; throws `NotFoundError` |
| `hardDeleteMany(where): Promise<Row[]>` | soft delete only |

The types it uses:

- `type PgDatabase = PgAsyncDatabase<PgQueryResultHKT, any>`: any PostgreSQL database or transaction.
- `type Row<TTable>`, `type Insert<TTable>` (`PgInsertValue`), `type Patch<TTable>` (`PgUpdateSetSource`).
- `type Where<TTable> = SQL | WhereObject<TTable> | undefined`; `type WhereObject<TTable> = { [K in keyof Row]?: Row[K] }`.
- `type OrderBy<TTable> = SQL | SQL.Aliased | PgColumn | ReadonlyArray<SQL | SQL.Aliased | PgColumn> | { [K in keyof Row]?: 'asc' | 'desc' }`; `type OrderDirection = 'asc' | 'desc'`.
- `interface RepositoryOptions<TTable, TKey, TSoft> { primaryKey?: TKey; softDelete?: TSoft; touchUpdatedAt?: boolean; maxPageSize?: number }`.
- `interface ReadOptions { withDeleted?: boolean }`, and `FindFirstOptions`, `FindManyOptions`, `PaginateOptions`, `CursorPaginateOptions` as in the table.
- `type BaseRepository<TTable, TKey, TSoft>` and `type SoftDeleteMethods<TTable, TKey>`, the two halves of `Repository`.
- `type ColumnKey<TTable>`, `type PrimaryKeyOf<TTable>` (`'id'` when the table has it, else `never`), `type HasColumn<TTable, K>`.

#### `paginate(db, query, options?)`

```ts
function paginate<TRow>(
	db: PgDatabase,
	query: PaginatableQuery<TRow>,
	options?: PaginateQueryOptions, // page, pageSize, maxPageSize
): Promise<Page<TRow>>;
```

`PaginatableQuery<TRow>` is any Drizzle select that can still take a `limit`
and an `offset`.

#### `withTransaction(db, fn, config?)`

```ts
function withTransaction<TDb extends PgDatabase, T>(
	db: TDb,
	fn: (tx: TransactionOf<TDb>) => Promise<T>,
	config?: PgTransactionConfig,
): Promise<T>;
```

`TransactionOf<TDb>` is the transaction type of that database's driver.
`config` on a transaction, a savepoint, throws a `TypeError`.

#### Column helpers

- `id(): uuid builder`, `id('uuid')`, `id('identity'): integer builder`.
- `timestamps(): { createdAt, updatedAt }`.
- `softDelete(): { deletedAt }`.

## Traps

- **The id is `id`, unless you say otherwise.** Drizzle 1.0's column types
  do not carry `.primaryKey()`, so the repository cannot read the key from
  the table's type. It types and uses the column under `id`; for a key under
  any other name, pass `primaryKey`. A table whose primary key is another
  column fails at the first call by id, with a message naming the option.
- **A cursor needs a `NOT NULL` column, at a `Date`'s precision.** A row
  whose ordering column is `null` cannot be paged past, and throws. A
  `timestamptz` at PostgreSQL's default precision holds microseconds; read
  into a `Date`, it loses them, and a cursor on it repeats or skips rows.
  Declare it `precision: 3`, as `timestamps()` does.
- **Soft-deleted rows still hold their unique values.** Delete
  `ada@example.com`, create her again, and the unique constraint answers
  `ConflictError`. Make the constraint a partial unique index,
  `... where deleted_at is null`, or `hardDelete`.
- **Inside a transaction, use `with(tx)`.** A repository on `db` is not in
  the transaction. On a driver with a single connection, PGlite for one, a
  query on `db` while a transaction holds it waits forever.
- **`detail` can hold the refused value**: `Key (email)=(ada@example.com)
  already exists.` Log it; do not send it to a client. The messages
  themselves name the constraint and table only.
- **`updateMany` and `deleteMany` return every row they touch**, through
  `RETURNING *`. For a million rows, write the query with Drizzle.
- **`paginate` counts and reads in two queries.** They go together, not one
  after the other, but they are still two: under concurrent writes, `total`
  can be off by the rows written in between. Run it in a `repeatable read` transaction when it must be exact.
  And a subquery refuses two columns with one name: in a join, select the
  columns you need, under distinct keys, not `select()`.
- **`findById` with a value the column's type refuses is an error, not
  `undefined`.** The value reaches PostgreSQL, which answers `22P02`, so
  `findById('nope')` on a `uuid` primary key throws — measured on PGlite
  0.5.8, an `InvalidValueError` with `code: 'INVALID_VALUE'` and the message
  `invalid input syntax for type uuid: "nope"`. Map that code to a **400** and
  a mistyped path parameter is answered as the client's mistake; catch it in
  the route, and answer 404, if a malformed id should read as "no such row".
- **A cursor is encoded, not signed.** A client can read the values of the
  last row's ordering columns in it, and forge one. It can only ask for rows
  its `where` already allows.
- **`timestamps()` has two clocks.** `defaultNow()` is the database's
  `now()`; `$onUpdate` is `new Date()`, in your process.
- **An `ArgumentError` is a 400, not a 500.** Test for it *before* any
  `TypeError` branch in an error handler — it extends `TypeError`, so a
  broader branch placed first swallows it.

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/schema.md](docs/guide/schema.md) — the column helpers, and what the repository reads from a table.
- [docs/guide/repository.md](docs/guide/repository.md) — reads, writes, `where`, ordering, primary keys and soft delete.
- [docs/guide/pagination.md](docs/guide/pagination.md) — offset pages, cursor pages, one page of any query.
- [docs/guide/transactions.md](docs/guide/transactions.md) — `withTransaction`, `with(tx)`, savepoints and isolation.
- [docs/guide/errors.md](docs/guide/errors.md) — the `DataError` classes and `toDataError`, `ArgumentError` for an argument refused before any SQL, and one handler for the app.
- [docs/troubleshooting.md](docs/troubleshooting.md) — an error message, and its fix.
- [docs/roadmap.md](docs/roadmap.md) — what is next, and what is not planned.

## License

MIT
