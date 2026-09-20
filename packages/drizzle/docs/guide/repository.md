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
function createRepository<TTable extends PgTable, TKey, TSoft>(
	db: PgDatabase,
	table: TTable,
	options?: RepositoryOptions<TTable, TKey, TSoft>,
): Repository<TTable, TKey, TSoft>;
```

`PgDatabase` is any PostgreSQL Drizzle database — `node-postgres`,
`postgres-js`, PGlite, Neon — and a transaction is one too, so
`createRepository(tx, users)` works.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `primaryKey` | a column key of the table | the column under `id` | the column `findById`, `getById`, `update(id)`, `delete(id)`, `restore(id)` and `hardDelete(id)` use, and the type of the id |
| `softDelete` | `boolean` | `true` when the table has a `deletedAt` column | `false` makes `delete` a real `DELETE` and stops reads from filtering |
| `touchUpdatedAt` | `boolean` | `true` | sets the `updatedAt` column to `now()` on every update the patch does not set it in |
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

A key set to `undefined` throws a `TypeError` rather than being dropped:

```ts
await userRepository.findMany({ where: { teamId: maybeTeamId } });
// TypeError: where: "teamId" is undefined. Leave the key out, or pass null for IS NULL
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
throws a `TypeError` naming it.

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
| `updateMany(where, …)` / `deleteMany(where)` with no `where` | throws a `TypeError`: pass `` sql`true` `` to mean every row |

```ts
await userRepository.deleteMany(sql`true`); // yes, all of them
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
| `update(id, patch)` | `Row` | `NotFoundError`, and the above |
| `updateMany(where, patch)` | `Row[]` | `TypeError` without a `where` |
| `delete(id)` | `Row` | `NotFoundError` |
| `deleteMany(where)` | `Row[]` | `TypeError` without a `where` |
| `count(where?, options?)` | `number` | |
| `exists(where, options?)` | `boolean` | |
| `paginate(options?)` | `Page<Row>` | `RangeError` on a bad page |
| `paginateByCursor(options?)` | `CursorPage<Row>` | `InvalidCursorError` |
| `restore(id)`, `hardDelete(id)`, `hardDeleteMany(where)` | soft delete only | `NotFoundError` |
| `with(db)` | the same repository on another database or transaction | |
| `table`, `db` | what it was created with | |

Pagination has its own page: [guide/pagination.md](pagination.md). Every
error is a `DataError`: [guide/errors.md](errors.md).

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
type Repository<TTable, TKey = PrimaryKeyOf<TTable>, TSoft = HasColumn<TTable, 'deletedAt'>> =
	BaseRepository<TTable, TKey, TSoft> &
		(TSoft extends true ? SoftDeleteMethods<TTable, TKey> : unknown);

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
