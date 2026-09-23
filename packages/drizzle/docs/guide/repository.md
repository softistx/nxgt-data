# The repository

One object per table: typed reads and writes, by id or by `where`, with soft
delete, `updatedAt` and database errors handled for you.

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { createRepository } from '@nxgt/drizzle/pg';
import { users } from './schema';

const db = drizzle(process.env.DATABASE_URL!);
const userRepository = createRepository(db, users);

const ada = await userRepository.create({ email: 'ada@example.com' });
await userRepository.update(ada.id, { name: 'Ada' });
const live = await userRepository.findMany({ where: { name: null } });
```

Everything is typed from the table: a row is `users.$inferSelect`, `create`
takes `users.$inferInsert`, and a `where` object only accepts the table's
columns with their types. Nothing is declared twice.

## Creating one

```ts
function createRepository<TTable extends PgTable, TKey, TSoft, TLock>(
	db: PgDatabase,
	table: TTable,
	options?: RepositoryOptions<TTable, TKey, TSoft, TLock>,
): Repository<TTable, TKey, TSoft, TLock>;
```

`PgDatabase` is any PostgreSQL Drizzle database — `node-postgres`,
`postgres-js`, PGlite, Neon — and a transaction is one too, so
`createRepository(tx, users)` works.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `primaryKey` | a column key of the table | the column under `id` | the column `findById`, `getById`, `update(id)`, `delete(id)`, `restore(id)` and `hardDelete(id)` use, and the type of the id |
| `softDelete` | `boolean` | `true` when the table has a `deletedAt` column | `false` makes `delete` a real `DELETE` and stops reads from filtering |
| `touchUpdatedAt` | `boolean` | `true` | sets the `updatedAt` column to `now()` on every update the patch does not set it in |
| `optimisticLock` | `boolean` | `true` when the table has an integer `NOT NULL` `version` column | every update raises `version`, and `update` checks the one a patch gives; `false` makes it an ordinary column — see [guide/stamps.md](stamps.md#optimistic-locking) |
| `actor` | the type of the actor columns | — | who is writing, stamped into `createdBy`, `updatedBy`, `deletedBy`; `as(actor)` is the same thing later — see [guide/stamps.md](stamps.md#who-is-writing) |
| `maxPageSize` | `number` | `100` | the largest `pageSize` or `limit` a page may ask for; a larger one is lowered to it |

```ts
const tags = pgTable('tags', { slug: text('slug').primaryKey(), label: text('label') });

// `slug` is the id: `getById` now takes a string named slug, not `id`.
const tagRepository = createRepository(db, tags, { primaryKey: 'slug' });
await tagRepository.getById('drizzle');
```

```ts
// A table with `deletedAt`, deleted for real anyway.
const sessionRepository = createRepository(db, sessions, { softDelete: false });
```

Nothing is sent when the repository is created: it only reads the table's
definition, once.

## Reading

```ts
await userRepository.findById(id);                    // Row | undefined
await userRepository.getById(id);                     // Row, or throws NotFoundError
await userRepository.findFirst({ email: 'ada@example.com' });
await userRepository.findMany({
	where: { teamId: 1 },
	orderBy: { createdAt: 'desc' },
	limit: 20,
	offset: 40,
});
await userRepository.count({ teamId: 1 });            // number
await userRepository.exists({ email: 'ada@example.com' }); // boolean
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `where` | `WhereObject` or a Drizzle condition | none: every row | see [Where](#where) |
| `orderBy` | an object of directions, a column, a list | none, so PostgreSQL's order | see [Ordering](#ordering) |
| `limit`, `offset` | `number` | none | passed straight to the query; for pages, use [pagination](pagination.md) |
| `withDeleted` | `boolean` | `false` | include soft-deleted rows |

`findById`, `getById`, `count` and `exists` take `{ withDeleted }` as their
last argument:

```ts
await userRepository.findById(id, { withDeleted: true });
await userRepository.count(undefined, { withDeleted: true });
```

**`findById` with a value the column's type refuses throws**, rather than
answering `undefined`: the value goes to PostgreSQL, which will not read it.
Measured on PGlite 0.5.8, `findById('nope')` on a `uuid` primary key throws
an [`InvalidValueError`](errors.md#invalidvalueerror-a-value-the-column-refused)
with `code: 'INVALID_VALUE'` and the message
`invalid input syntax for type uuid: "nope"` — a 400, since it is the
caller's input, where a row that is simply not there is `undefined` and a
404.

### Where

A `where` is an object of equalities, or any Drizzle condition:

```ts
import { and, gt, ilike } from 'drizzle-orm';

await userRepository.findMany({ where: { teamId: 1, name: null } });
// where team_id = 1 and name is null

await userRepository.findMany({
	where: and(gt(users.createdAt, since), ilike(users.name, 'a%')),
});
```

In an object, the keys are joined with `AND`, and `null` means `IS NULL`.

A key set to `undefined` throws an [`ArgumentError`](errors.md#argumenterror-what-the-call-said)
rather than being dropped:

```ts
import { ArgumentError } from '@nxgt/drizzle';

try {
	await userRepository.findMany({ where: { teamId: maybeTeamId } });
} catch (error) {
	if (error instanceof ArgumentError) {
		error.code;      // 'INVALID_ARGUMENT'
		error.argument;  // 'where'
		error.key;       // 'teamId'
		error.message;   // 'where: "teamId" is undefined. Leave the key out, or pass null for IS NULL'
	}
}
```

Dropped, `{ id: undefined }` would match every row — and an `updateMany` with
it would rewrite the table. Build the object conditionally instead:

```ts
const where = teamId === undefined ? {} : { teamId };
await userRepository.findMany({ where });
```

### Ordering

`orderBy` takes an object of directions, in its key order, or anything
Drizzle's own `orderBy` takes:

```ts
import { asc, desc, sql } from 'drizzle-orm';

await userRepository.findMany({ orderBy: { teamId: 'asc', createdAt: 'desc' } });
await userRepository.findMany({ orderBy: [asc(users.teamId), desc(users.createdAt)] });
await userRepository.findMany({ orderBy: sql`lower(${users.name}) asc` });
```

A key that is not a column, or a direction that is not `'asc'` or `'desc'`,
throws an [`ArgumentError`](errors.md#argumenterror-what-the-call-said) naming
it — `argument: 'orderBy'`, `key: 'rank'`:

```ts
import type { OrderDirection } from '@nxgt/drizzle/pg';

// A direction off a query string: a string, whatever the type says.
const direction = c.req.query('direction') as OrderDirection;

await userRepository.findMany({ orderBy: { createdAt: direction } });
// ArgumentError: orderBy: "createdAt" must be 'asc' or 'desc', not sideways
//   argument: 'orderBy', key: 'createdAt'
```

That is the case to care about: an ordering built from a query string is a
client's input, and `ArgumentError` is what a handler answers 400 on.

## Writing

```ts
const ada = await userRepository.create({ email: 'ada@example.com' });
const both = await userRepository.createMany([
	{ email: 'a@example.com' },
	{ email: 'b@example.com' },
]);

await userRepository.update(ada.id, { name: 'Ada' });
await userRepository.updateMany({ teamId: 1 }, { teamId: 2 });

await userRepository.delete(ada.id);
await userRepository.deleteMany({ teamId: 2 });
```

Every write returns the rows it wrote, through `RETURNING *`: `create` gives
the row with its defaults filled in, `updateMany` and `deleteMany` give every
row they touched. For a million rows, write the statement with Drizzle
directly and wrap it in [`toDataError`](errors.md#your-own-queries).

A value can be SQL, as anywhere in Drizzle:

```ts
import { sql } from 'drizzle-orm';

await userRepository.update(ada.id, { loginCount: sql`${users.loginCount} + 1` });
```

Three edges worth knowing:

| Call | Does |
| --- | --- |
| `createMany([])` | sends nothing, returns `[]` |
| `update(id, {})` | sends no update, returns the row (and still throws `NotFoundError` when there is none) |
| `updateMany(where, …)` / `deleteMany(where)` with no `where` | throws an `ArgumentError`: pass `` sql`true` `` to mean every row |

```ts
await userRepository.deleteMany(sql`true`); // yes, all of them
```

One write inserts or updates, in a single `INSERT … ON CONFLICT`:
`upsert(where, values)`. A `version` in `update`'s patch is checked rather
than written on a table that locks, and `as(actor)` stamps who wrote. All
three are [guide/stamps.md](stamps.md).

```ts
await userRepository.upsert({ email: 'ada@example.com' }, { name: 'Ada' });
```

## Primary keys

The methods by id use the column under the key `id`. Drizzle 1.0's column
types do not carry `.primaryKey()`, so the key cannot be read from the
table's type — which is why `id` is the default and `primaryKey` is an
option.

- A primary key under another key: pass `primaryKey: 'slug'`. Without it, the
  first call by id throws a `TypeError` naming the option.
- A composite primary key, or none: the methods by id do not compile
  (`PrimaryKeyOf` is `never`) and throw a `TypeError` that says why. Every
  method that takes a `where` still works.

```ts
const membershipRepository = createRepository(db, memberships); // composite key
await membershipRepository.findMany({ where: { userId, teamId } }); // fine

// @ts-expect-error: the id is `never` — "memberships" has a composite primary key
await membershipRepository.getById(userId);
```

## Soft delete

A table with a `deletedAt` column is soft-deleted, and the repository gains
three methods — in the types too, through `SoftDeleteMethods`:

```ts
await userRepository.delete(ada.id);      // sets deleted_at = now(), returns the row
await userRepository.findById(ada.id);    // undefined
await userRepository.restore(ada.id);     // clears deleted_at, returns the row
await userRepository.hardDelete(ada.id);  // a real DELETE, live or deleted
await userRepository.hardDeleteMany({ teamId: 2 });
```

Every read leaves soft-deleted rows out unless `withDeleted: true`, and
`update` and `updateMany` only touch live rows: restore a row before
updating it. A unique constraint still sees the deleted rows — see
[guide/schema.md](schema.md#migrations) for the partial index that fixes
that.

## The methods, in one table

`Row` is `table.$inferSelect` and `Id` is the type of the primary key column.

| Method | Returns | Throws |
| --- | --- | --- |
| `findById(id, options?)` | `Row \| undefined` | |
| `getById(id, options?)` | `Row` | `NotFoundError` |
| `findFirst(where?, options?)` | `Row \| undefined` | |
| `findMany(options?)` | `Row[]` | |
| `create(values)` | `Row` | `ConflictError`, `ForeignKeyError`… |
| `createMany(values)` | `Row[]` | the same |
| `update(id, patch)` | `Row` | `NotFoundError`, `OptimisticLockError` for a `version` the row is no longer at, and the above |
| `updateMany(where, patch)` | `Row[]` | `ArgumentError` without a `where`, or with a `version` on a table that locks |
| `upsert(where, values)` | `Row` | `ConflictError` on a soft-deleted row; `ArgumentError` for a `where` that cannot be inserted; see [guide/stamps.md](stamps.md#upsert) |
| `delete(id)` | `Row` | `NotFoundError` |
| `deleteMany(where)` | `Row[]` | `ArgumentError` without a `where` |
| `count(where?, options?)` | `number` | |
| `exists(where, options?)` | `boolean` | |
| `paginate(options?)` | `Page<Row>` | `RangeError` on a bad page |
| `paginateByCursor(options?)` | `CursorPage<Row>` | `InvalidCursorError` |
| `restore(id)`, `hardDelete(id)`, `hardDeleteMany(where)` | soft delete only | `NotFoundError`; `ArgumentError` for a `hardDeleteMany` without a `where` |
| `with(db)` | the same repository on another database or transaction | |
| `as(actor)` | the same repository, stamping the actor columns | `ArgumentError` for no actor; `TypeError` on a table without actor columns |
| `table`, `db` | what it was created with | |

**Every method that reaches the database also throws a bare `TypeError`**
when the repository is the one built on the outer database and the call is
made inside `withTransaction`. A programming mistake rather than a client's
input, which is why it is not an `ArgumentError`:
[Forgetting `with(tx)` is refused, not hung](transactions.md#forgetting-it-is-refused-not-hung).

Pagination has its own page: [guide/pagination.md](pagination.md). What the
database said is a `DataError`, what the call said is an `ArgumentError`, and
[guide/errors.md](errors.md) tells the two apart.

## In a Hono route

```ts
import { Hono } from 'hono';
import { ConflictError } from '@nxgt/drizzle';
import { createRepository } from '@nxgt/drizzle/pg';
import { db } from './db';
import { users } from './schema';

const userRepository = createRepository(db, users);

export const app = new Hono()
	.get('/users/:id', async (c) => {
		const user = await userRepository.findById(c.req.param('id'));
		if (!user) return c.json({ error: 'No such user' }, 404);
		return c.json(user);
	})
	.post('/users', async (c) => {
		const body = await c.req.json<{ email: string; name?: string }>();
		try {
			return c.json(await userRepository.create(body), 201);
		} catch (error) {
			if (error instanceof ConflictError) {
				return c.json({ error: 'This email is taken' }, 409);
			}
			throw error;
		}
	})
	.delete('/users/:id', async (c) => {
		await userRepository.delete(c.req.param('id')); // NotFoundError → the app's handler
		return c.body(null, 204);
	});
```

One handler for every `DataError` beats a `try` per route:
[guide/errors.md](errors.md#one-handler-for-the-app).

## In a test

A repository is an ordinary object over a database, so a test gets one by
pointing it at a test database — PGlite runs PostgreSQL in the process:

```ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, test } from 'bun:test';
import { NotFoundError } from '@nxgt/drizzle';
import { createRepository } from '@nxgt/drizzle/pg';
import { users } from './schema';

const client = new PGlite();
await client.exec(CREATE_TABLES); // your DDL, or drizzle-kit's migrations
const userRepository = createRepository(drizzle({ client }), users);

test('a deleted user is gone', async () => {
	const ada = await userRepository.create({ email: 'ada@example.com' });
	await userRepository.delete(ada.id);
	expect(await userRepository.findById(ada.id)).toBeUndefined();
	await expect(userRepository.getById(ada.id)).rejects.toBeInstanceOf(NotFoundError);
});
```

## Types

```ts
type Repository<
	TTable,
	TKey = PrimaryKeyOf<TTable>,
	TSoft = HasColumn<TTable, 'deletedAt'>,
	TLock = LockOf<TTable>,          // an integer NOT NULL `version`
> = BaseRepository<TTable, TKey, TSoft, TLock> &
	(TSoft extends true ? SoftDeleteMethods<TTable, TKey> : unknown);

// What `update`, `updateMany` and `upsert` take, and who `as` takes:
// UpdatePatch, ManyPatch, UpsertWhere, UpsertValues, ActorOf and LockOf,
// spelled out in guide/stamps.md#signatures.

type Row<TTable> = InferSelectModel<TTable>;      // table.$inferSelect
type Insert<TTable> = PgInsertValue<TTable>;      // what create takes
type Patch<TTable> = PgUpdateSetSource<TTable>;   // what update takes

type WhereObject<TTable> = { [K in keyof Row<TTable>]?: Row<TTable>[K] };
type Where<TTable> = SQL | WhereObject<TTable> | undefined;

type OrderDirection = 'asc' | 'desc';
type OrderBy<TTable> =
	| SQL
	| SQL.Aliased
	| PgColumn
	| ReadonlyArray<SQL | SQL.Aliased | PgColumn>
	| { [K in keyof Row<TTable>]?: OrderDirection };

interface ReadOptions { withDeleted?: boolean }
interface FindFirstOptions<TTable> extends ReadOptions { orderBy?: OrderBy<TTable> }
interface FindManyOptions<TTable> extends ReadOptions {
	where?: Where<TTable>;
	orderBy?: OrderBy<TTable>;
	limit?: number;
	offset?: number;
}
```

`ColumnKey<TTable>`, `PrimaryKeyOf<TTable>` and `HasColumn<TTable, K>` are
exported too, for a helper of your own that takes a repository.
