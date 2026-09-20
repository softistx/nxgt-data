# Troubleshooting

Every heading is the message as it is printed, with the stack and the row ids
cut, and a long one ended in `…`. The table, column and constraint names in
them are an example — the message you get names yours, so search for the
words around the name. The errors this package raises are the classes
`@nxgt/drizzle` exports: `DataError` and its subclasses for what the database
answered, and `ArgumentError` for an argument refused before any SQL is
built. Every one of them carries a `code` you can switch on —
`ArgumentError`'s is `INVALID_ARGUMENT`, beside the `argument` it is about
(`where`, `orderBy`, or `paginateByCursor` for the column a cursor page
is ordered by) and the `key` inside it when one is at fault. It
extends `TypeError`, which these refusals were before 0.2.0, so a `catch`
written against `TypeError` still catches them. A `where` or an `orderBy`
assembled from a query string is user input, so that is the class a handler
answers 400 on rather than 500. What is left is a plain `TypeError` or
`RangeError`: a repository configured wrong, or a page number that is not
one.

- **Install and types**
  - [`Cannot find module 'drizzle-orm' or its corresponding type declarations.`](#cannot-find-module-drizzle-orm-or-its-corresponding-type-declarations)
- **Configuration**
  - [`createRepository: "users" has no column under the key "uuid"`](#createrepository-users-has-no-column-under-the-key-uuid)
  - [`"users"'s primary key is under the key "uuid", not "id". …`](#userss-primary-key-is-under-the-key-uuid-not-id-)
  - [`"order_items" has a composite primary key (order_id, sku): …`](#order_items-has-a-composite-primary-key-order_id-sku-)
  - [`"users" has no primary key: the methods by id need one. …`](#users-has-no-primary-key-the-methods-by-id-need-one-)
  - [`createRepository: softDelete needs a "deletedAt" column, and "users" has none`](#createrepository-softdelete-needs-a-deletedat-column-and-users-has-none)
  - [`restore: "users" has no soft delete`](#restore-users-has-no-soft-delete)
- **Reading and writing**
  - [`Unique constraint "users_email_unique" violated on "users"`](#unique-constraint-users_email_unique-violated-on-users)
  - [`Foreign key "posts_author_id_fkey" violated on "posts"`](#foreign-key-posts_author_id_fkey-violated-on-posts)
  - [`Check constraint "users_age_check" violated on "users"`](#check-constraint-users_age_check-violated-on-users)
  - [`Column "email" on "users" cannot be null`](#column-email-on-users-cannot-be-null)
  - [`invalid input syntax for type uuid`](#invalid-input-syntax-for-type-uuid)
  - [`No row in "users" with id …`](#no-row-in-users-with-id-)
  - [`where: "teamId" is undefined. Leave the key out, or pass null for IS NULL`](#where-teamid-is-undefined-leave-the-key-out-or-pass-null-for-is-null)
  - [`where: "users" has no column under the key "teamID"`](#where-users-has-no-column-under-the-key-teamid)
  - [`updateMany needs a where. …`](#updatemany-needs-a-where-)
  - [`where: expected a Drizzle condition or an object`](#where-expected-a-drizzle-condition-or-an-object)
  - [`orderBy: "createdAt" must be 'asc' or 'desc', not DESC`](#orderby-createdat-must-be-asc-or-desc-not-desc)
  - [`orderBy: expected a Drizzle ordering, a list, or an object`](#orderby-expected-a-drizzle-ordering-a-list-or-an-object)
- **Pagination**
  - [`Invalid cursor: it cannot be decoded`](#invalid-cursor-it-cannot-be-decoded)
  - [`Invalid cursor: unexpected shape`](#invalid-cursor-unexpected-shape)
  - [`Invalid cursor: it was written for the ordering createdAt:asc, not id:asc`](#invalid-cursor-it-was-written-for-the-ordering-createdatasc-not-idasc)
  - [`Invalid cursor: expected 2 value(s), got 1`](#invalid-cursor-expected-2-values-got-1)
  - [`paginateByCursor: "users" has no column under the key "createdAtt"`](#paginatebycursor-users-has-no-column-under-the-key-createdatt)
  - [`paginateByCursor: "createdAt" is null in a row of "users". Page along a NOT NULL column.`](#paginatebycursor-createdat-is-null-in-a-row-of-users-page-along-a-not-null-column)
  - [`page must be an integer of at least 1, not 0`](#page-must-be-an-integer-of-at-least-1-not-0)
- **Transactions**
  - [`withTransaction: a nested transaction is a savepoint, which takes no isolation level or access mode`](#withtransaction-a-nested-transaction-is-a-savepoint-which-takes-no-isolation-level-or-access-mode)
  - [A repository call inside a transaction never settles](#a-repository-call-inside-a-transaction-never-settles)

## Install and types

### `Cannot find module 'drizzle-orm' or its corresponding type declarations.`

**When:** typechecking, on the first file that imports `@nxgt/drizzle/pg`.
**Why:** `drizzle-orm` is a required peer — the package builds on your copy so
that there is only ever one `SQL` class in the tree — and a peer is not
installed for you.
**Fix:**

```sh
bun add @nxgt/drizzle drizzle-orm@rc
```

Drizzle 1.0 is a release candidate and its types move between RCs: the
supported range is `>=1.0.0-rc.4 <2`, and 0.x does not work at all.

## Configuration

### `createRepository: "users" has no column under the key "uuid"`

**When:** at `createRepository`, when `primaryKey` is given.
**Why:** `primaryKey` names the **key in the table object**, not the column
name in the database.
**Fix:**

```ts
// the key on the left of the table object, not 'user_id'
createRepository(db, users, { primaryKey: 'userId' });
```

### `"users"'s primary key is under the key "uuid", not "id". …`

**When:** at the first call by id — `findById`, `getById`, `update(id)`,
`delete(id)`, `restore(id)`, `paginateByCursor` — not at `createRepository`.
**Why:** Drizzle 1.0's column types do not carry `.primaryKey()`, so the
repository cannot read the key from the table's type. It defaults to `id`,
the one key it can know of.
**Fix:**

```ts
createRepository(db, users, { primaryKey: 'uuid' });
```

The option types the id as well, so `getById` then takes that column's type.

### `"order_items" has a composite primary key (order_id, sku): …`

**When:** at the first call by id. The full message names the two ways out:

```text
"order_items" has a composite primary key (order_id, sku): the methods by id
need one column. Pass `primaryKey` to createRepository to name a unique
column, or use the methods that take a `where`.
```

**Why:** the methods by id need one column, and a composite key has none to
pick.
**Fix:**

```ts
// name a unique column…
createRepository(db, orderItems, { primaryKey: 'lineId' });
// …or work by `where`
await orderItems.findFirst({ orderId, sku });
```

### `"users" has no primary key: the methods by id need one. …`

**When:** at the first call by id, on a table that declares no primary key
and has no `id` column.
**Why:** same as above — nothing names the row.
**Fix:**

```ts
createRepository(db, users, { primaryKey: 'email' }); // any unique column
```

### `createRepository: softDelete needs a "deletedAt" column, and "users" has none`

**When:** at `createRepository`, with `softDelete: true`.
**Why:** soft delete writes a `deletedAt` column, and the table declares
none. `softDelete` is on by itself whenever the column exists, so passing
`true` is only ever needed to assert it.
**Fix:**

```ts
import { softDelete } from '@nxgt/drizzle/pg';

export const users = pgTable('users', { /* … */ ...softDelete() });
```

### `restore: "users" has no soft delete`

**When:** calling `restore(id)` on a repository built with
`softDelete: false`, or on a table with no `deletedAt` column.
**Why:** there is no stamp to clear, so there is nothing to restore.
**Fix:**

```ts
// give the table the column, or stop calling restore on a hard-delete table
const users = createRepository(db, usersTable); // softDelete on, since the column is there
```

## Reading and writing

### `Unique constraint "users_email_unique" violated on "users"`

**When:** on a `create`, `update` or `upsert` that repeats a unique value.
**Why:** PostgreSQL answered SQLSTATE `23505`; the repository turns it into a
`ConflictError`, with `constraint`, `columns` and the database's `detail`.
A frequent surprise is a **soft-deleted** row: it still holds its unique
value.
**Fix:**

```ts
import { ConflictError } from '@nxgt/drizzle';

try {
	await users.create({ email });
} catch (error) {
	if (error instanceof ConflictError) return conflict(error.columns);
	throw error;
}
```

For the soft-delete case, make the constraint partial —
`create unique index … on users (email) where deleted_at is null` — or
`hardDelete`. And note that `error.detail` can hold the refused value
(`Key (email)=(ada@example.com) already exists.`): log it, never send it to a
client.

### `Foreign key "posts_author_id_fkey" violated on "posts"`

**When:** inserting a row that points at a row that does not exist, or
deleting a row something still points at.
**Why:** SQLSTATE `23503`, as a `ForeignKeyError` with `constraint` and
`table`.
**Fix:**

```ts
import { ForeignKeyError } from '@nxgt/drizzle';

if (error instanceof ForeignKeyError) return badRequest(error.constraint);
```

### `Check constraint "users_age_check" violated on "users"`

**When:** a `create`, `update` or `upsert` whose row fails a `CHECK` the table
declares — a negative amount, a range whose end is before its start, a status
outside the list the constraint allows.
**Why:** SQLSTATE `23514`, as a `CheckViolationError` with `constraint` and
`table`. The constraint name is the database's, so it is what tells the
rules apart; PostgreSQL does not say which column was wrong.
**Fix:**

```ts
import { CheckViolationError } from '@nxgt/drizzle';

try {
	await users.create({ email, age });
} catch (error) {
	if (error instanceof CheckViolationError) return badRequest(error.constraint);
	throw error;
}
```

Give every `check()` in the schema a name of its own, so that the branch above
reads as a rule rather than as whatever name PostgreSQL made up.

### `Column "email" on "users" cannot be null`

**When:** a write that leaves out a `NOT NULL` column with no default, or
sets it to `null`.
**Why:** SQLSTATE `23502`, as a `NotNullViolationError` whose `columns` holds
the one column PostgreSQL named.
**Fix:**

```ts
await users.create({ email }); // every NOT NULL column without a default
```

### `invalid input syntax for type uuid`

**When:** `findById('nope')` — any id whose text the column's type refuses.
**Why:** the value reaches PostgreSQL, which refuses it with SQLSTATE
`22P02`. There is no subclass for that, so it arrives as a `DataError` with
`code: 'DATABASE'` — an error, not `undefined`. Measured on PGlite with a
`uuid` primary key.
**Fix:**

```ts
// a route parameter is checked before it is used as an id
const id = z.uuid().safeParse(request.params.id);
if (!id.success) return notFound();
await users.findById(id.data);
```

### `No row in "users" with id …`

**When:** `getById`, `update(id)`, `delete(id)` or `restore(id)` on an id
nothing matches — including a row that is **soft-deleted**, which those
methods do not see.
**Why:** a `NotFoundError`, with `id` and `table` on it.
**Fix:**

```ts
import { NotFoundError } from '@nxgt/drizzle';

const row = await users.findById(id); // undefined instead of throwing
await users.getById(id, { withDeleted: true }); // or look past the stamp
```

### `where: "teamId" is undefined. Leave the key out, or pass null for IS NULL`

**When:** any call whose `where` object holds a key set to `undefined` —
usually a filter built from optional query parameters.
**Why:** an `undefined` key is dropped by most query builders, which would
make `{ id: undefined }` match **every** row, and an `updateMany` rewrite the
table. It is refused instead, as an `ArgumentError` with
`argument: 'where'`, `key: 'teamId'` and `code: 'INVALID_ARGUMENT'`.
**Fix:**

```ts
const where = { teamId, ...(email === undefined ? {} : { email }) };
await users.findMany({ where });
```

`null` is a value, not an absence: it becomes `IS NULL`.

### `where: "users" has no column under the key "teamID"`

**When:** any call whose `where` or `orderBy` names a key the table object
does not have — the same message with an `orderBy:` prefix comes from an
ordering.
**Why:** an `ArgumentError`: the key is the one **in the table object**, not
the column name in the database, so `team_id` and a mistyped `teamID` are
both refused rather than silently dropped. `error.argument` says which of
the two it came from, and `error.key` is the key.
**Fix:**

```ts
import { ArgumentError } from '@nxgt/drizzle';

try {
	await users.findMany({ where: { [query.field]: query.value } });
} catch (error) {
	if (error instanceof ArgumentError) return badRequest(error.argument, error.key);
	throw error;
}
```

Better still, build the filter from keys you list yourself, so a query string
can only name a column the handler allows.

### `updateMany needs a where. …`

**When:** `updateMany`, `deleteMany` or `hardDeleteMany` with no `where`, or
with `{}`. The full message names the table and the way out:

```text
updateMany needs a where. Pass `sql`true`` to target every row of "users".
```

**Why:** a filter that came out empty would otherwise touch every row. An
`ArgumentError` since 0.2.0, with `code: 'INVALID_ARGUMENT'` and
`argument: 'where'` — a `where` assembled from a request that comes out empty
is the caller's input, so this is a 400 rather than a 500. It is still a
`TypeError` by inheritance, which is what it threw before.
**Fix:**

```ts
import { sql } from 'drizzle-orm';

await users.deleteMany(sql`true`); // every row, said out loud
```

### `where: expected a Drizzle condition or an object`

**When:** any call whose `where` is neither a Drizzle condition nor a plain
object — a bare id, an array of conditions, `null`.
**Why:** `where` is either SQL (`eq`, `and`, `sql`…) or an object read as one
equality per key. Anything else has no reading, and guessing one would filter
on something other than what was meant. An `ArgumentError`, not a
`DataError`: nothing reached the database.
**Fix:**

```ts
import { inArray, or } from 'drizzle-orm';

await users.findMany({ where: { teamId } });                     // an object
await users.findMany({ where: inArray(usersTable.id, ids) });    // a condition
await users.findMany({ where: or(...conditions) });              // a list, joined
```

A list of conditions is combined with `and`/`or` first; the repository does
not take the array itself.

### `orderBy: "createdAt" must be 'asc' or 'desc', not DESC`

**When:** a `findMany`, `findFirst` or `paginate` whose `orderBy` object holds a
direction that is not one of the two — usually a query string taken as it
came, where `DESC`, `descending` or `-1` arrives.
**Why:** the direction is matched exactly, and lowercase: `'asc'` and
`'desc'` are the only two. It is refused rather than defaulted, because a
silently reversed page is worse than a 400. An `ArgumentError` with
`argument: 'orderBy'` and the `key` it is about, like the `where` above.
**Fix:**

```ts
const direction = query.order === 'desc' ? 'desc' : 'asc';
await users.findMany({ orderBy: { createdAt: direction } });
```

The same call also throws
[`orderBy: "users" has no column under the key "nope"`](#where-users-has-no-column-under-the-key-teamid)
when the key is not a column of the table.

### `orderBy: expected a Drizzle ordering, a list, or an object`

**When:** an `orderBy` that is none of those three — a number, a string
column name, `null`.
**Why:** an ordering is Drizzle's own (`asc(column)`, a column, a `sql`
fragment), a list of them, or an object of `key: 'asc' | 'desc'`. A bare
string is not one of them: it would have to be turned into a column, and
`orderBy: 'createdAt'` is `paginateByCursor`'s shape, not `findMany`'s. An
`ArgumentError`, before any SQL is built.
**Fix:**

```ts
import { asc, desc } from 'drizzle-orm';

await users.findMany({ orderBy: { createdAt: 'desc' } });        // an object
await users.findMany({ orderBy: [desc(usersTable.createdAt), asc(usersTable.id)] });
await users.paginateByCursor({ orderBy: 'createdAt' });          // a key, here only
```

## Pagination

### `Invalid cursor: it cannot be decoded`

**When:** `paginateByCursor({ after })` with a cursor that was not written by
this package — truncated in a URL, re-encoded, or made up.
**Why:** an `InvalidCursorError`, `code: 'INVALID_CURSOR'`. It is a client's
input, so it is a 400, not a 500.
**Fix:**

```ts
import { InvalidCursorError } from '@nxgt/drizzle';

try {
	return await users.paginateByCursor({ after: query.cursor });
} catch (error) {
	if (error instanceof InvalidCursorError) return badRequest('cursor');
	throw error;
}
```

A cursor is base64url, not a signature: a client can read the ordering values
out of it and forge one. It can only ask for rows its `where` already allows.

### `Invalid cursor: unexpected shape`

**When:** `paginateByCursor({ after })` with a value that decoded and parsed
as JSON, but is not what `encodeCursor` writes — a base64 payload from
another service, a session token, a cursor hand-built in a test.
**Why:** a cursor is the pair `[key, values]`: the ordering it was cut in and
the values of the last row. Anything else is rejected rather than read
half-way. An `InvalidCursorError` again, `code: 'INVALID_CURSOR'`, so the
same `catch` covers it.
**Fix:**

```ts
import { encodeCursor } from '@nxgt/drizzle';

// only `nextCursor`, or `encodeCursor`, produces a cursor this reads
const cursor = encodeCursor({ key: 'createdAt:asc', values: [row.createdAt, row.id] });
```

In a handler, treat every cursor that comes from a client as a 400 — see
[`Invalid cursor: it cannot be decoded`](#invalid-cursor-it-cannot-be-decoded)
for the shape of that `catch`.

### `Invalid cursor: it was written for the ordering createdAt:asc, not id:asc`

**When:** paging on with a cursor taken from a page that was ordered
differently, or sorted in the other direction.
**Why:** the ordering is part of the cursor, because a keyset is only valid
for the order it was cut in.
**Fix:**

```ts
// carry orderBy and direction along with the cursor, for every page
await users.paginateByCursor({ orderBy: 'createdAt', direction: 'asc', after });
```

### `Invalid cursor: expected 2 value(s), got 1`

**When:** `paginateByCursor({ after })` with a cursor written for the same
ordering but holding another number of values — a cursor issued before the
repository's `primaryKey` changed, or one that was edited.
**Why:** the keyset is one column when the ordering **is** the primary key,
and two — the ordering column, then the primary key to break its ties — for
any other, and a cursor carries one value per column. The ordering name in
the cursor still matches, so this check is what catches it.
**Fix:** treat it as any other bad cursor, and hand back the first page:

```ts
import { InvalidCursorError } from '@nxgt/drizzle';

try {
	return await users.paginateByCursor({ orderBy: 'createdAt', after });
} catch (error) {
	if (error instanceof InvalidCursorError) {
		return await users.paginateByCursor({ orderBy: 'createdAt' }); // from the top
	}
	throw error;
}
```

A cursor does not outlive a change of `primaryKey`; nothing needs to be
migrated, the next page is simply cut again.

### `paginateByCursor: "users" has no column under the key "createdAtt"`

**When:** `paginateByCursor` with an `orderBy` naming a column the table does
not have — typically a column name read off a query string, where the types
were not there to refuse it.
**Why:** an `ArgumentError` with `code: 'INVALID_ARGUMENT'`,
`argument: 'paginateByCursor'` and the key on `key`. Nothing was sent, and a
column name from a client is user input, so this is a 400.
**Fix:** narrow the name to the columns you page along:

```ts
const COLUMNS = ['createdAt', 'id'] as const;
const orderBy = COLUMNS.find((known) => known === c.req.query('sort')) ?? 'createdAt';

await users.paginateByCursor({ orderBy, limit: 20 });
```

### `paginateByCursor: "createdAt" is null in a row of "users". Page along a NOT NULL column.`

**When:** paging along a nullable column, at the row whose value is `null`.
**Why:** a keyset cannot step past a value it does not have.
**Fix:**

```ts
// page along a NOT NULL column…
await users.paginateByCursor({ orderBy: 'id' });
```

A `timestamptz` at PostgreSQL's default precision also holds microseconds a
`Date` cannot; declare it `precision: 3`, as `timestamps()` does, or a cursor
on it repeats or skips rows.

### `page must be an integer of at least 1, not 0`

**When:** `paginate({ page })` or `paginate({ pageSize })` with a number that
is not a positive integer — usually a query string turned into a number.
**Why:** a `RangeError`; pages are 1-based. A `pageSize` **above**
`maxPageSize` is not an error, it is lowered.
**Fix:**

```ts
const page = Number(query.page) || 1;
await users.paginate({ page });
```

## Transactions

### `withTransaction: a nested transaction is a savepoint, which takes no isolation level or access mode`

**When:** calling `withTransaction(tx, …, { isolationLevel: … })` inside
another transaction.
**Why:** PostgreSQL's nested block is a savepoint, and a savepoint cannot
change the isolation level or the access mode of the transaction it is in.
**Fix:**

```ts
await withTransaction(db, async (tx) => {
	await withTransaction(tx, async (savepoint) => { /* … */ }); // no config
}, { isolationLevel: 'repeatable read' });
```

### A repository call inside a transaction never settles

**When:** inside `withTransaction`, when a repository built on `db` is used
instead of `repository.with(tx)`. There is no error: the call simply never
resolves.
**Why:** the repository on `db` runs outside the transaction, on another
connection. On a driver with a single connection — PGlite, or a pool of one —
that connection is held by the open transaction, so the query waits for it
forever.
**Fix:**

```ts
await withTransaction(db, async (tx) => {
	const team = await teams.with(tx).create({ name: 'Core' });
	await users.with(tx).update(userId, { teamId: team.id });
});
```

Every repository in the callback takes `.with(tx)`; there is no ambient
transaction.
