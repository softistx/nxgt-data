# Troubleshooting

Every heading is the message as it is printed, with the stack and the row ids
cut, and a long one ended in `…`. The table, column and constraint names in
them are an example — the message you get names yours, so search for the
words around the name. The errors this package raises are the classes
`@nxgt/drizzle` exports: `DataError` and its subclasses for what the database
answered, and `ArgumentError` for an argument refused before any SQL is
built. Every one of them carries a `code` you can switch on —
`ArgumentError`'s is `INVALID_ARGUMENT`, beside the `argument` it is about
(`where`, `orderBy`, `patch`, `values`, `actor`, or `paginateByCursor`
for the column a cursor page is ordered by) and the `key` inside it when one is at fault. It
extends `TypeError`, which these refusals were before 0.2.0, so a `catch`
written against `TypeError` still catches them. A `where` or an `orderBy`
assembled from a query string is user input, so that is the class a handler
answers 400 on rather than 500; a refusal that no request could cause stays
a **bare** `TypeError` and is a 500. What is left is a plain `TypeError` or
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
  - [`createRepository: optimisticLock needs a "version" column, and "tickets" has none`](#createrepository-optimisticlock-needs-a-version-column-and-tickets-has-none)
  - [`createRepository: optimisticLock needs an integer NOT NULL "version" column, and "tickets"'s is not one`](#createrepository-optimisticlock-needs-an-integer-not-null-version-column-and-ticketss-is-not-one)
  - [`as on "teams": the table has no createdBy, updatedBy or deletedBy column to stamp`](#as-on-teams-the-table-has-no-createdby-updatedby-or-deletedby-column-to-stamp)
- **Reading and writing**
  - [`Unique constraint "users_email_unique" violated on "users"`](#unique-constraint-users_email_unique-violated-on-users)
  - [`Foreign key "posts_author_id_fkey" violated on "posts"`](#foreign-key-posts_author_id_fkey-violated-on-posts)
  - [`Check constraint "users_age_check" violated on "users"`](#check-constraint-users_age_check-violated-on-users)
  - [`Column "email" on "users" cannot be null`](#column-email-on-users-cannot-be-null)
  - [`invalid input syntax for type uuid: "nope"`](#invalid-input-syntax-for-type-uuid-nope)
  - [`No row in "users" with id …`](#no-row-in-users-with-id-)
  - [`where: "teamId" is undefined. Leave the key out, or pass null for IS NULL`](#where-teamid-is-undefined-leave-the-key-out-or-pass-null-for-is-null)
  - [`where: "users" has no column under the key "teamID"`](#where-users-has-no-column-under-the-key-teamid)
  - [`updateMany needs a where. …`](#updatemany-needs-a-where-)
  - [`where: expected a Drizzle condition or an object`](#where-expected-a-drizzle-condition-or-an-object)
  - [`orderBy: "createdAt" must be 'asc' or 'desc', not DESC`](#orderby-createdat-must-be-asc-or-desc-not-desc)
  - [`orderBy: expected a Drizzle ordering, a list, or an object`](#orderby-expected-a-drizzle-ordering-a-list-or-an-object)
- **Upsert, locking and actors**
  - [`update on "tickets": the row is no longer at the version the patch expected: it changed since it was read`](#update-on-tickets-the-row-is-no-longer-at-the-version-the-patch-expected-it-changed-since-it-was-read)
  - [`update on "tickets": the expected "version" must be a whole number, not a string`](#update-on-tickets-the-expected-version-must-be-a-whole-number-not-a-string)
  - [`updateMany on "tickets": "version" is the optimistic lock, which only update checks. Leave it out; every write raises it`](#updatemany-on-tickets-version-is-the-optimistic-lock-which-only-update-checks-leave-it-out-every-write-raises-it)
  - [`as on "tickets": the actor is undefined. Pass who is writing, or use the repository without as()`](#as-on-tickets-the-actor-is-undefined-pass-who-is-writing-or-use-the-repository-without-as)
  - [`upsert on "tickets": the row with this (slug) is soft-deleted. Restore it, or hard-delete it, before writing over its key`](#upsert-on-tickets-the-row-with-this-slug-is-soft-deleted-restore-it-or-hard-delete-it-before-writing-over-its-key)
  - [`upsert on "posts": no unique constraint covers exactly (title), the where's columns. Add one, or name the columns one covers`](#upsert-on-posts-no-unique-constraint-covers-exactly-title-the-wheres-columns-add-one-or-name-the-columns-one-covers)
  - [`upsert on "tickets": the where must be an object of column values, not SQL`](#upsert-on-tickets-the-where-must-be-an-object-of-column-values-not-sql)
  - [`upsert on "tickets": the where is empty. Name the columns a unique constraint covers`](#upsert-on-tickets-the-where-is-empty-name-the-columns-a-unique-constraint-covers)
  - [`upsert on "tickets": the where names "nope", which is no column of the table`](#upsert-on-tickets-the-where-names-nope-which-is-no-column-of-the-table)
  - [`upsert on "tickets": "slug" in the where is null. It is inserted as well as matched, so it must be a value, and NULL never conflicts`](#upsert-on-tickets-slug-in-the-where-is-null-it-is-inserted-as-well-as-matched-so-it-must-be-a-value-and-null-never-conflicts)
  - [`upsert on "tickets": "version" is the optimistic lock, which only update checks. Leave it out; every write raises it`](#upsert-on-tickets-version-is-the-optimistic-lock-which-only-update-checks-leave-it-out-every-write-raises-it)
  - [`upsert on "tickets": "version" is the optimistic lock, which the repository keeps. Leave it out`](#upsert-on-tickets-version-is-the-optimistic-lock-which-the-repository-keeps-leave-it-out)
  - [`upsert on "tickets": the values must be an object, not an array`](#upsert-on-tickets-the-values-must-be-an-object-not-an-array)
  - [`upsert on "tickets": "slug" is in both the where and the values. Name it in the where alone`](#upsert-on-tickets-slug-is-in-both-the-where-and-the-values-name-it-in-the-where-alone)
- **Pagination**
  - [`Invalid cursor in paginateByCursor on "users": it cannot be decoded`](#invalid-cursor-in-paginatebycursor-on-users-it-cannot-be-decoded)
  - [`Invalid cursor in paginateByCursor on "users": unexpected shape`](#invalid-cursor-in-paginatebycursor-on-users-unexpected-shape)
  - [`Invalid cursor in paginateByCursor on "users": it was written for the ordering createdAt:asc, not id:asc`](#invalid-cursor-in-paginatebycursor-on-users-it-was-written-for-the-ordering-createdatasc-not-idasc)
  - [`Invalid cursor in paginateByCursor on "users": it holds 1 value(s) where the ordering createdAt:asc needs 2 (createdAt, id)`](#invalid-cursor-in-paginatebycursor-on-users-it-holds-1-values-where-the-ordering-createdatasc-needs-2-createdat-id)
  - [`paginateByCursor: "users" has no column under the key "createdAtt"`](#paginatebycursor-users-has-no-column-under-the-key-createdatt)
  - [`paginateByCursor: "createdAt" is null in a row of "users". Page along a NOT NULL column.`](#paginatebycursor-createdat-is-null-in-a-row-of-users-page-along-a-not-null-column)
  - [`paginate on "users": page must be an integer of at least 1, not 0`](#paginate-on-users-page-must-be-an-integer-of-at-least-1-not-0)
- **Transactions**
  - [`withTransaction: a nested transaction is a savepoint, which takes no isolation level or access mode`](#withtransaction-a-nested-transaction-is-a-savepoint-which-takes-no-isolation-level-or-access-mode)
  - [`The repository for "users" is bound to the database withTransaction is holding open, …`](#the-repository-for-users-is-bound-to-the-database-withtransaction-is-holding-open-)
  - [A repository call inside a transaction still never settles, after `.with(db)`](#a-repository-call-inside-a-transaction-still-never-settles-after-withdb)
  - [A `serializable` transaction fails with `sqlState: '40001'`](#a-serializable-transaction-fails-with-sqlstate-40001)

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

### `createRepository: optimisticLock needs a "version" column, and "tickets" has none`

**When:** at `createRepository`, with `optimisticLock: true`.
**Why:** the lock is a `version` column the repository raises and checks, and
the table has none under that key. The lock is on by itself whenever the
table has an integer `NOT NULL` `version`, so `true` is only ever needed to
assert it. A bare `TypeError`: no request can cause it.
**Fix:**

```ts
import { version } from '@nxgt/drizzle/pg';

export const tickets = pgTable('tickets', { /* … */ ...version() });
// alter table tickets add column version integer not null default 0;
```

### `createRepository: optimisticLock needs an integer NOT NULL "version" column, and "tickets"'s is not one`

**When:** at `createRepository`, with `optimisticLock: true`, on a table whose
`version` is nullable, `text`, `bigint` in `bigint` mode, or anything but a
JavaScript `number` integer.
**Why:** the lock raises it with `version + 1` and compares it with the
number a patch gives. `null + 1` is `null`, so a nullable one would check
nothing, and a `text` one is data, not a counter. Without the option, such a
column is simply an ordinary one.
**Fix:**

```sql
alter table tickets alter column version type integer using version::integer;
update tickets set version = 0 where version is null;
alter table tickets alter column version set default 0;
alter table tickets alter column version set not null;
```

Or leave the column alone and drop `optimisticLock: true`.

### `as on "teams": the table has no createdBy, updatedBy or deletedBy column to stamp`

**When:** `as(actor)` on a table with none of the three actor columns — or
the `actor` option there, whose message starts `createRepository on`. The types refuse it already; this
is a caller they do not reach.
**Why:** there is nothing to stamp the actor into. A bare `TypeError`: it is
wiring, not input.
**Fix:**

```ts
import { actors } from '@nxgt/drizzle/pg';

export const teams = pgTable('teams', { /* … */ ...actors() });
// or drop the as() for this table
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
sets it to `null`. An `upsert` too, **even when the row is there**: PostgreSQL
checks the row it would insert before it looks for a conflict, so the values
must name every required column the `where` does not.
**Why:** SQLSTATE `23502`, as a `NotNullViolationError` whose `columns` holds
the one column PostgreSQL named.
**Fix:**

```ts
await users.create({ email }); // every NOT NULL column without a default
```

### `invalid input syntax for type uuid: "nope"`

**When:** any query handed a value the column's type cannot read — most often
a URL parameter passed straight to `findById`.
**Why:** PostgreSQL's SQLSTATE `22P02`, as an `InvalidValueError` with
`code: 'INVALID_VALUE'` since 0.3.0. It is the caller's input rather than the
query's own doing, so it is a 400: before that it was a plain `DataError` with
`code: 'DATABASE'`, which is what a database that is down answers too, so a
handler mapping codes to statuses returned 500 for a mistyped id. Its
siblings are the same class — `22001` (a value too long for the column),
`22003` (out of the type's range), `22007` and `22008` (a date or a time that
is not one). Measured on PGlite 0.5.8: none of them carries `table`, `column`
or `detail`, so the database's own sentence is all there is, and it can hold
the value that was refused — log it, do not send it to a client.
**Fix:** validate the parameter, or answer the error with a 400:

```ts
// a route parameter is checked before it is used as an id
const id = z.uuid().safeParse(request.params.id);
if (!id.success) return notFound();
await users.findById(id.data);
```

```ts
import { InvalidValueError } from '@nxgt/drizzle';

try {
	return await users.getById(request.params.id);
} catch (error) {
	if (error instanceof InvalidValueError) return badRequest('id'); // not a 500
	throw error;
}
```

A division by zero (`22012`) is deliberately **not** one of these: that is the
query rather than a value handed to it, and it stays a `DataError` with
`code: 'DATABASE'`.

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

## Upsert, locking and actors

### `update on "tickets": the row is no longer at the version the patch expected: it changed since it was read`

**When:** `update(id, { …, version })` on a row that another write raised
since it was read.
**Why:** an `OptimisticLockError`, `code: 'OPTIMISTIC_LOCK'`: the row is
there, live, at another version, and nothing was written. It carries `id`,
`expectedVersion` (what the patch said) and `actualVersion` (where the row
is); the message leaves the values out.
**Fix:** read the row again, show the person what changed, and let them
decide; answer the request with a 409.

```ts
import { OptimisticLockError } from '@nxgt/drizzle';

if (error instanceof OptimisticLockError) {
	return c.json({ error: 'Changed since you read it', version: error.actualVersion }, 409);
}
```

A row that is missing or soft-deleted is a `NotFoundError` instead.

### `update on "tickets": the expected "version" must be a whole number, not a string`

**When:** `update` on a table that locks, with a `version` that is not a whole
number of at least 0: `'3'` from a form, `1.5`, `-1`, `null`, SQL. The
message says which shape it was, never the value.
**Why:** the version in a patch is the version the row must be at, compared
in the `WHERE`; it is never written. An `ArgumentError`, `argument: 'patch'`,
`key: 'version'` — usually a request body, so a 400.
**Fix:**

```ts
if (!Number.isInteger(body.version) || body.version < 0) {
	return c.json({ error: 'version must be the whole number that was read' }, 400);
}
await tickets.update(id, { title: body.title, version: body.version });
```

To write a version by hand, use a repository with `optimisticLock: false`.

### `updateMany on "tickets": "version" is the optimistic lock, which only update checks. Leave it out; every write raises it`

**When:** `updateMany` with `version` in the patch, on a table that locks.
`upsert` says the same about its values, under its own name, below.
**Why:** one version cannot stand for many rows, and a row an upsert may
insert has no version to be at. Every update raises it anyway. An
`ArgumentError`, `argument: 'patch'`, `key: 'version'`.
**Fix:**

```ts
await tickets.updateMany({ slug }, { title: 'Closed' }); // no version
// one row, conditionally: update(id, { …, version })
```

### `as on "tickets": the actor is undefined. Pass who is writing, or use the repository without as()`

**When:** `as(undefined)` or `as(null)` — usually a session that was never
read — or the `actor` option set to `null`, whose message starts
`createRepository on`.
**Why:** an actor that did not arrive would stamp nothing, silently, on
every write. An `ArgumentError`, `argument: 'actor'`.
**Fix:**

```ts
const userId = c.get('userId');
if (!userId) return c.json({ error: 'Sign in' }, 401);
await tickets.as(userId).create(values);
// a script with nobody acting: tickets.create(values)
```

### `upsert on "tickets": the row with this (slug) is soft-deleted. Restore it, or hard-delete it, before writing over its key`

**When:** `upsert` on a key whose row is there but soft-deleted.
**Why:** the update half is scoped to live rows, like every other write, so
nothing was written and nothing came back. A `ConflictError` with the
`table` and the conflict `columns`: the key is taken, by a row you cannot
see.
**Fix:** decide which of the two you mean.

```ts
const gone = await tickets.findFirst({ slug }, { withDeleted: true });
if (gone?.deletedAt) await tickets.restore(gone.id); // or hardDelete(gone.id)
await tickets.upsert({ slug }, { title });
```

### `upsert on "posts": no unique constraint covers exactly (title), the where's columns. Add one, or name the columns one covers`

**When:** `upsert` whose `where` names columns no unique constraint or unique
index covers exactly — a subset of a composite one, a partial index, or
none at all.
**Why:** the `where`'s columns are the `ON CONFLICT` target, and PostgreSQL
refuses a target it cannot match to a constraint (SQLSTATE `42P10`). A
`DataError` with `code: 'DATABASE'`, `sqlState: '42P10'`, the `table` and the
`columns`: a mistake in the code, so a 500.
**Fix:**

```sql
alter table posts add constraint posts_title_unique unique (title);
```

Or name the columns a constraint covers: `{ teamId, email }` for
`unique (team_id, email)`, not `{ email }`. A partial unique index
(`… where deleted_at is null`) serves no upsert.

### `upsert on "tickets": the where must be an object of column values, not SQL`

**When:** `upsert` with a Drizzle condition, an array, or anything that is not
a plain object as its `where`. The message says which.
**Why:** the `where` is inserted as well as matched, and a condition says
nothing an insert could write. An `ArgumentError`, `argument: 'where'`.
**Fix:**

```ts
await tickets.upsert({ slug: 'a' }, { title: 'A' }); // not eq(tickets.slug, 'a')
```

### `upsert on "tickets": the where is empty. Name the columns a unique constraint covers`

**When:** `upsert({}, values)`, usually a `where` built from a request that
came out empty.
**Why:** there is nothing to conflict on. An `ArgumentError`,
`argument: 'where'`.
**Fix:** name the key, or use `create` when every call is a new row.

### `upsert on "tickets": the where names "nope", which is no column of the table`

**When:** `upsert` whose `where` has a key that is no column key of the
table. The types refuse it; this is a caller they do not reach.
**Why:** a key that is no column can be neither written nor matched. An
`ArgumentError`, `argument: 'where'`, with the `key`.
**Fix:** use the column's key on the table object (`teamId`), not its SQL
name (`team_id`).

### `upsert on "tickets": "slug" in the where is null. It is inserted as well as matched, so it must be a value, and NULL never conflicts`

**When:** `upsert` whose `where` holds `null`, `undefined` or SQL under a
key — the message names which of the three.
**Why:** a `NULL` never equals another under a unique constraint, so every
call would insert a new row; SQL is not a value an insert can seed from. An
`ArgumentError`, `argument: 'where'`, with the `key`.
**Fix:**

```ts
if (!body.slug) return c.json({ error: 'slug is required' }, 400);
await tickets.upsert({ slug: body.slug }, { title: body.title });
```

### `upsert on "tickets": "version" is the optimistic lock, which only update checks. Leave it out; every write raises it`

**When:** `upsert` with `version` in the values, on a table that locks.
**Why:** a row an upsert may insert has no version to be at, and the update
half raises it anyway. An `ArgumentError`, `argument: 'values'`,
`key: 'version'`.
**Fix:** leave it out of the values; to write only while a row is at a
version, read it and `update(id, { …, version })`.

### `upsert on "tickets": "version" is the optimistic lock, which the repository keeps. Leave it out`

**When:** `upsert` with `version` in the `where`, on a table that locks.
**Why:** the version is not a key: the repository starts it at 0 and raises
it on every update. An `ArgumentError`, `argument: 'where'`.
**Fix:** identify the row by a unique key; check a version with `update`.

### `upsert on "tickets": the values must be an object, not an array`

**When:** `upsert` whose `values` are not a plain object — an array, SQL,
`null`. The message says which.
**Why:** the values are the columns to write. An `ArgumentError`,
`argument: 'values'`.
**Fix:** one call per row, `values` an object; `{}` when there is nothing
to write beyond the `where`.

### `upsert on "tickets": "slug" is in both the where and the values. Name it in the where alone`

**When:** `upsert` whose `values` repeat a key the `where` names. The types
leave it out; this is a caller they do not reach.
**Why:** the `where` is what is inserted under that key; a second value for
it would either be ignored or change the key of the row it matched. An
`ArgumentError`, `argument: 'values'`, with the `key`.
**Fix:**

```ts
const { slug, ...rest } = body;
await tickets.upsert({ slug }, rest);
```

## Pagination

### `Invalid cursor in paginateByCursor on "users": it cannot be decoded`

**When:** `paginateByCursor({ after })` with a cursor that was not written by
this package — truncated in a URL, re-encoded, or made up. The call and the
table are named in the sentence, because every paginated call takes the same
`after`.
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

### `Invalid cursor in paginateByCursor on "users": unexpected shape`

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
[`Invalid cursor in paginateByCursor on "users": it cannot be decoded`](#invalid-cursor-in-paginatebycursor-on-users-it-cannot-be-decoded)
for the shape of that `catch`.

### `Invalid cursor in paginateByCursor on "users": it was written for the ordering createdAt:asc, not id:asc`

**When:** paging on with a cursor taken from a page that was ordered
differently, or sorted in the other direction.
**Why:** the ordering is part of the cursor, because a keyset is only valid
for the order it was cut in.
**Fix:**

```ts
// carry orderBy and direction along with the cursor, for every page
await users.paginateByCursor({ orderBy: 'createdAt', direction: 'asc', after });
```

### `Invalid cursor in paginateByCursor on "users": it holds 1 value(s) where the ordering createdAt:asc needs 2 (createdAt, id)`

**When:** `paginateByCursor({ after })` with a cursor written for the same
ordering but holding another number of values — a cursor issued before the
repository's `primaryKey` changed, or one that was edited.
**Why:** the keyset is one column when the ordering **is** the primary key,
and two — the ordering column, then the primary key to break its ties — for
any other, and a cursor carries one value per column. The ordering name in
the cursor still matches, so this check is what catches it. The sentence
names the call, the table and the columns the ordering needs, and the error
carries the `table`.
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

### `paginate on "users": page must be an integer of at least 1, not 0`

**When:** `paginate({ page })` or `paginate({ pageSize })` with a number that
is not a positive integer — usually a query string turned into a number. The
same message names `pageSize` for that option, and
`paginateByCursor on "users": limit must be …` for a cursor page's: the call
and the table open the sentence, since every paginated call takes the same
option names.
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

### `The repository for "users" is bound to the database withTransaction is holding open, …`

**When:** inside `withTransaction`, when a repository built on `db` is used
instead of `repository.with(tx)`. Since 0.4.0 this is a bare `TypeError`;
before it, the call simply never resolved and nothing was thrown.
**Why:** the repository on `db` runs outside the transaction and asks the pool
for a connection. The open transaction is holding one and will not release it
until it ends, and it cannot end while it is waiting for this call. On a pool
of one — PGlite, or `max: 1` — nobody ever hands one over.
**Fix:**

```ts
await withTransaction(db, async (tx) => {
	const team = await teams.with(tx).create({ name: 'Core' });
	await users.with(tx).update(userId, { teamId: team.id });
});
```

Every repository in the callback takes `.with(tx)`; there is no ambient
transaction. Three shapes are deliberately **not** refused:
`createRepository(tx, table)`, which is already on the transaction; a
repository on a **different** database, because the refusal compares against
the database *this* transaction holds rather than asking whether a
transaction is open anywhere; and a repository bound to the outer transaction
used inside a nested `withTransaction`, because that nested call is a
savepoint on the connection the outer one already holds.

A **bare** `TypeError`, on purpose: it is a programming mistake rather than a
client's input, so it is not an `ArgumentError` and a handler that answers
400 to that class does not pick it up. It falls through to the 500 branch.

### A repository call inside a transaction still never settles, after `.with(db)`

**When:** `repository.with(db)` inside `withTransaction`, on PGlite or on a
pool of one. No error, and no refusal either.
**Why:** naming the database is how a caller says they mean it — work that
should survive a rollback — so it is deliberately not refused. It then needs
a **second** connection, which a pooled driver hands over and a
single-connection driver does not. The deadlock is the driver's, and the same
one that existed before the refusal.
**Fix:** on `node-postgres`, give the pool room:

```ts
const pool = new Pool({ connectionString, max: 10 });   // not max: 1
```

On PGlite there is no second connection to take, so the work cannot run beside
the transaction at all: do it after the transaction returns.

```ts
const rows = await withTransaction(db, (tx) => importRows(tx));
await attempts.create({ action: 'import', rows: rows.length });
```

**Three more shapes deadlock the same way, and the refusal does not see any
of them** — each measured on PGlite 0.5.8, each waiting forever with nothing
thrown:

- **A repository on a second `drizzle({ client })` over the same client.**
  It is the same database, but not the same *object*, and the refusal
  compares by identity. One `drizzle()` handle per client is the fix.
- **A transaction opened with Drizzle's own `db.transaction(…)`** rather than
  `withTransaction`. Nothing records what it holds, so nothing is refused
  inside it. `withTransaction` is the one that guards.
- **`withTransaction(db, …)` nested inside `withTransaction(db, …)`** — the
  inner call names `db`, not `tx`, so it asks for a second connection exactly
  as `.with(db)` does. Nest on `tx`, which opens a savepoint.

`paginate(db, query, options)`, the standalone paginator, is unguarded for
the same reason as `.with(db)`: the caller hands it the database by name.

### A `serializable` transaction fails with `sqlState: '40001'`

**When:** under `isolationLevel: 'serializable'` or `'repeatable read'`, when
two transactions touched the same rows and PostgreSQL could not order them.
**Why:** those levels are enforced by refusing one of the two transactions,
not by making it wait. It arrives as a `DataError` with `code: 'DATABASE'`
and `sqlState: '40001'`. A lost optimistic-lock race arrives this way too
under those levels, when the other writer committed after this
transaction's snapshot, rather than as an `OptimisticLockError` — see
[Under `repeatable read` or `serializable`](guide/stamps.md#under-repeatable-read-or-serializable). This package does not retry: a retry re-runs the
callback, and only the caller knows whether that is safe.
**Fix:** match on `sqlState`, never on the message — PostgreSQL words it
differently per isolation level — and retry the whole transaction, not the
statement that failed:

```ts
import { DataError } from '@nxgt/drizzle';
import { withTransaction } from '@nxgt/drizzle/pg';

async function serializable<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			const retryable =
				error instanceof DataError && error.sqlState === '40001';
			if (!retryable || attempt === attempts) throw error;
			await Bun.sleep(attempt * 10);
		}
	}
}

await serializable(() =>
	withTransaction(db, (tx) => transfer(tx), {
		isolationLevel: 'serializable',
	}),
);
```

Nothing inside the callback may have an effect the retry cannot repeat — send
the email after the transaction returns, not inside it.
