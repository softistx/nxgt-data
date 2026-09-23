# Upsert, optimistic locking and who wrote it

Three things a table that several people edit needs, and that
`@nxgt/mongo` already gives a collection: one write that inserts or updates,
a version that stops the second of two editors overwriting the first, and
the id of whoever wrote each row.

```ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { actors, createRepository, id, softDelete, timestamps, version } from '@nxgt/drizzle/pg';

export const tickets = pgTable('tickets', {
	id: id(),
	slug: text('slug').notNull().unique('tickets_slug_unique'),
	title: text('title').notNull(),
	...timestamps(),
	...softDelete(),
	...version(),  // version integer not null default 0
	...actors(),   // created_by, updated_by, deleted_by uuid
});

const ticketRepository = createRepository(db, tickets);
```

The repository recognises the columns by their key on the table, as it does
`deletedAt` and `updatedAt`: a table declared with plain Drizzle columns
under `version`, `createdBy`, `updatedBy` and `deletedBy` behaves the same.

## Upsert

```ts
upsert(where: UpsertWhere<TTable>, values: UpsertValues<TTable, keyof where, TLock>): Promise<Row>;
```

`where` identifies the row, `values` is what to write either way. It is one
statement, so there is no read to go stale between the look-up and the write:

```sql
insert into "tickets" ("slug", "title", …) values ($1, $2, …)
on conflict ("slug") do update set "title" = excluded."title", "updated_at" = …, "version" = "tickets"."version" + 1
where "tickets"."deleted_at" is null
returning *
```

```ts
const ticket = await ticketRepository.upsert(
	{ slug: 'login-broken' },        // what identifies it
	{ title: 'Login is broken' },    // what to write, either way
);
```

### The unique constraint is the guarantee

The columns of the `where` are the `ON CONFLICT` target, so a unique
constraint or unique index must cover **exactly** those columns. Two requests
racing on the same key then leave one row — the loser of the race waits for
the winner and updates what it inserted. Without one, PostgreSQL refuses the
statement (SQLSTATE `42P10`), and the call says which columns it needed:

```
upsert on "tickets": no unique constraint covers exactly (title), the where's columns. Add one, or name the columns one covers
```

A composite key is a `where` of several columns:

```ts
// unique (team_id, user_id)
await memberships.upsert({ teamId, userId }, { role: 'owner' });
```

A **partial** unique index — `… where deleted_at is null`, which
[guide/schema.md](schema.md#migrations) suggests for a soft-deleted table —
serves no `ON CONFLICT` that does not repeat its predicate, and this package
sends none. A table that upserts on a key needs a plain unique constraint on
it.

### The `where` is written, not only matched

The `where` goes into the row an insert writes, so it is held to what a
write is held to. Each of these is an `ArgumentError` naming the call and the
table, before anything is sent:

| The `where` | Why it cannot stand |
| --- | --- |
| `` sql`slug = 'a'` `` | a condition says nothing an insert could write |
| `{ slug: null }` | `NULL` never conflicts: every call would insert |
| `` { slug: sql`'a'` } `` | the same: a value, not SQL |
| `{ nope: 1 }` | no such column |
| `{ version: 0 }` | the repository keeps the version |
| `{}` | nothing to conflict on |

Every row of that table is refused by the types too, and `version` in the
`where` only on a table that locks.

The values do not repeat a key the `where` names — the types leave it out,
and a caller the types do not reach gets an `ArgumentError`.

### Every required column, every time

PostgreSQL checks the row it would insert **before** it looks for a
conflict. A `NOT NULL` column without a default has to be in the values even
when the row is already there, or the call is a `NotNullViolationError` on a
row that exists. The types require it, so this is a compile error:

```ts
// @ts-expect-error title is required: the insert half needs it
await ticketRepository.upsert({ slug: 'login-broken' }, {});
```

`@nxgt/mongo`'s upsert has the same rule for the same reason: nothing can
know in advance which half will run.

### What each half writes

**The insert** writes what `create` would: the `where` and the values, the
columns' defaults — `createdAt`, version 0 — and `createdBy` and `updatedBy`
when someone is [acting](#who-is-writing).

**The update** does what `update` does: the values, `updatedAt = now()`
(unless the values set it, or the column has `$onUpdate`), `updatedBy`, and
`version + 1`. It **never** moves `createdAt` or `createdBy`, even when the
values name them — they say how the row came to be — nor the primary key: an
`id` in the values is the id an insert gets, and a row already there keeps
its own. Each value is read back
from `excluded`, so it is sent once, SQL included:

```ts
await users.upsert({ email }, { loginCount: sql`1` });
```

With nothing to write, a row that is there comes back untouched — no
`updatedAt`, no version — as an empty `update` does.

### A soft-deleted row is not written over

The update half runs only on a live row. On a soft-deleted one, nothing is
written and nothing comes back, and the call throws a `ConflictError`:

```
upsert on "tickets": the row with this (slug) is soft-deleted. Restore it, or hard-delete it, before writing over its key
```

`restore(id)` it or `hardDelete(id)` it first — which of the two is a
decision this package should not take for you.

### A route that takes a webhook twice

```ts
app.post('/webhooks/contact', async (c) => {
	const body = await c.req.json();
	const contact = await contactRepository.upsert(
		{ externalId: body.id },                // unique (external_id)
		{ email: body.email, name: body.name },
	);
	return c.json(contact);
});
```

## Optimistic locking

A repository on a table with an integer `NOT NULL` `version` column locks.

- **Every update raises it by one**: `update`, `updateMany`, a soft `delete`
  or `deleteMany`, `restore`, and the update half of `upsert`. `create` starts
  it at the column's default, 0, and keeps a version it is given — an import
  keeps its number.
- **The `version` a patch gives `update` is a condition, not a value.**
  `{ version: 3 }` never sets the version to 3: it adds
  `and "version" = 3` to the `WHERE`, and the update leaves the row at 4.

```ts
import { OptimisticLockError } from '@nxgt/drizzle';

const ticket = await ticketRepository.getById(id);   // version 3
try {
	await ticketRepository.update(id, { title: 'Edited', version: ticket.version });
} catch (error) {
	if (error instanceof OptimisticLockError) {
		error.expectedVersion;   // 3, what the patch said
		error.actualVersion;     // 4: someone else wrote first
	}
	throw error;
}
```

The message leaves the values out, and names the call and the table:

```
update on "tickets": the row is no longer at the version the patch expected: it changed since it was read
```

A row that is missing, or soft-deleted, is still a `NotFoundError`: an
`UPDATE` that matched nothing cannot tell the three apart, so a second read
does, and only a row that is there at another version is a lock failure. A
patch that holds a version and nothing else writes nothing, and still checks
it.

### In a route

The version travels to the client with the row, and back with the edit:

```ts
app.patch('/tickets/:id', async (c) => {
	const body = await c.req.json();   // { title, version }
	try {
		const ticket = await ticketRepository
			.as(c.get('userId'))
			.update(c.req.param('id'), { title: body.title, version: body.version });
		return c.json(ticket);
	} catch (error) {
		if (error instanceof OptimisticLockError) {
			return c.json({ error: 'Changed since you read it', version: error.actualVersion }, 409);
		}
		throw error;
	}
});
```

A version that came off a request body and is not a whole number — `'3'`,
`1.5`, `-1` — is an `ArgumentError` (a 400), saying what it was without
printing it:

```
update on "tickets": the expected "version" must be a whole number, not a string
```

### What refuses a version

- `updateMany` and `upsert`: one version cannot stand for many rows, and a
  row that may not exist has no version to be at. The types refuse it, and an
  `ArgumentError` does at run time.
- `update` with SQL as the version: it is compared, never written.

### Turning it off

`optimisticLock: false` makes `version` an ordinary column: written as
given, never raised, never checked.

```ts
const importer = createRepository(db, tickets, { optimisticLock: false });
await importer.update(id, { version: 12 });   // written as it is
```

`optimisticLock: true` on a table without an integer `NOT NULL` `version`
does not compile, and is a `TypeError` when the repository is created for a
caller the types do not reach. A nullable one does not lock by
default — `null + 1` is `null`, and a lock on it checks nothing — and neither
does a `text` `version`, which is somebody's data, not a counter.

### Which one to reach for

A transaction makes several writes atomic; a version makes one write
conditional on nothing having changed since it was read — a form a person
filled in over a minute. They compose: an `update` inside
[`withTransaction`](transactions.md) can carry its expected version too.

## Who is writing

`as(actor)` gives back the same repository, stamping the actor:

| Write | Stamps |
| --- | --- |
| `create`, `createMany`, the insert half of `upsert` | `createdBy`, `updatedBy` |
| `update`, `updateMany`, the update half of `upsert`, `restore` | `updatedBy` |
| a soft `delete`, `deleteMany` | `deletedBy`, `updatedBy` |
| `restore` | clears `deletedBy` |

```ts
const acting = ticketRepository.as(session.userId);
await acting.create({ slug: 'a', title: 'A' });
await acting.update(id, { title: 'B' });
```

- The actor is typed by the columns: a `uuid` column takes a `string`, an
  `integer` one a `number`. `as` does not compile on a table with none of the
  three, and throws a `TypeError` for a caller the types do not reach; the
  `actor` option is refused the same way, under the name `createRepository`.
- `as(undefined)` and `as(null)` are an `ArgumentError`: an actor that never
  arrived is a session nobody read, and a repository that quietly stamped
  nothing would hide it. Use the repository without `as()` for a script.
- Nobody acting stamps nothing: a row written without an actor holds `null`.
- A stamp the values give is kept: `create({ …, createdBy: importedAuthor })`
  keeps the author of an imported row.
- `as` returns a new repository and leaves the one you hold alone;
  `with(tx)` keeps the actor, and so does `as` after `with`.
- The actor is not read or converted: the database checks it on the first
  write, and a string that is not a `uuid` is an `InvalidValueError`.

`createRepository(db, table, { actor })` is the same thing up front — for a
repository made per request:

```ts
app.use(async (c, next) => {
	c.set('tickets', createRepository(db, tickets, { actor: c.get('userId') }));
	await next();
});
```

## How this differs from `@nxgt/mongo`

The names and the shapes are the same — `upsert(where, values)`, a `version`
checked by `update`, `OptimisticLockError` with `expectedVersion` and
`actualVersion`, `as(actor)` and the `actor` option. What differs, on
purpose:

| | `@nxgt/drizzle` | `@nxgt/mongo` | Why |
| --- | --- | --- | --- |
| Turning the stamps on | read off the table, by column key | declared in `defineCollection` | a Drizzle table is already the definition; this is how `deletedAt` and `updatedAt` work here |
| A stamp the write gives itself | kept | refused, at compile and run time | a table is the application's own, and an import keeps its author and its dates |
| `version` given to `create` | kept | refused | the same: an import keeps its number |
| `optimisticLock: false` | `version` is an ordinary column | an expected version is refused | the column exists without the lock here; there it exists because of it |
| A refused version, `where` or actor | `ArgumentError` (a `TypeError`, with `code: 'INVALID_ARGUMENT'`) | a bare `TypeError` | this package has an `ArgumentError`; `@nxgt/mongo` has none |
| A soft delete and a restore | also stamp `updatedAt` and `updatedBy` | stamp `deletedAt`/`deletedBy` only | this package already raised `updatedAt` on both |
| The upsert target | a unique constraint on the `where`'s columns, which PostgreSQL requires | a unique index, which MongoDB does not require | `ON CONFLICT` needs a target; MongoDB can insert twice without one |
| Which half ran | not reported | told to the hooks | there are no hooks here yet |
| Hooks | none | `beforeCreate`, `afterUpdate`… | not built yet — see the [roadmap](../roadmap.md) |

## Signatures

```ts
interface BaseRepository<TTable, TKey, TSoft, TLock> {
	as(actor: ActorOf<TTable>): Repository<TTable, TKey, TSoft, TLock>;
	update(id: Row[TKey], patch: UpdatePatch<TTable, TLock>): Promise<Row>;
	updateMany(where: Where<TTable>, patch: ManyPatch<TTable, TLock>): Promise<Row[]>;
	upsert<const W extends UpsertWhere<TTable, TLock>>(
		where: UpsertWhereOf<TTable, TLock, W>,   // W, with no other key, and at least one
		values: UpsertValues<TTable, keyof W, TLock>,
	): Promise<Row>;
	// …and the rest of guide/repository.md
}

interface RepositoryOptions<TTable, TKey, TSoft, TLock> {
	optimisticLock?: LockOf<TTable> extends true ? TLock : false;   // default: LockOf<TTable>
	actor?: ActorOf<TTable>;
	// …primaryKey, softDelete, touchUpdatedAt, maxPageSize
}

type UpdatePatch<TTable, TLock> = TLock extends true
	? Omit<Patch<TTable>, 'version'> & { version?: number }
	: Patch<TTable>;
type ManyPatch<TTable, TLock> = TLock extends true
	? Omit<Patch<TTable>, 'version'> & { version?: never }
	: Patch<TTable>;
type UpsertWhere<TTable, TLock> = { [K in keyof Row<TTable>]?: NonNullable<Row<TTable>[K]> };   // no `version` where it locks
type UpsertValues<TTable, TWhereKey, TLock> = TLock extends true
	? Omit<Insert<TTable>, TWhereKey | 'version'> & { version?: never }
	: Omit<Insert<TTable>, TWhereKey>;
type ActorOf<TTable>;   // createdBy's type, else updatedBy's, else deletedBy's; never without any
type LockOf<TTable>;    // true when `version` is NOT NULL and its Drizzle dataType is 'number int16|int32|int53'

class OptimisticLockError extends DataError {
	readonly code: 'OPTIMISTIC_LOCK';
	readonly id: unknown;
	readonly expectedVersion: number | undefined;
	readonly actualVersion: number | undefined;
}
```

Next: [guide/errors.md](errors.md), for the classes these throw.
