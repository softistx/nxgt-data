# Pagination

Three ways to return a page: numbered pages with a total, cursor pages for an
infinite list, and one page of any query you wrote yourself.

```ts
import { createRepository } from '@nxgt/drizzle/pg';
import { users } from './schema';
import { db } from './db';

const userRepository = createRepository(db, users);

const page = await userRepository.paginate({ page: 2, pageSize: 20 });
// { items: Row[], total: 57, page: 2, pageSize: 20, pageCount: 3 }
```

## Offset pages

`paginate` runs the page and its `count(*)` together and assembles a
`Page<Row>`.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `page` | `number` | `1` | 1-based |
| `pageSize` | `number` | `20` | lowered to the repository's `maxPageSize` (`100`) when larger |
| `where` | `WhereObject` or a Drizzle condition | none | as in [`findMany`](repository.md#where) |
| `orderBy` | an object of directions, a column, a list | the primary key, ascending | a page with no order can repeat or skip rows between pages |
| `withDeleted` | `boolean` | `false` | include soft-deleted rows |

```ts
const page = await userRepository.paginate({
	page: 1,
	pageSize: 50,
	where: { teamId: 1 },
	orderBy: { createdAt: 'desc', id: 'asc' },
});
```

```ts
interface Page<T> {
	items: T[];
	/** Every row that matches, across all pages. */
	total: number;
	/** 1-based. */
	page: number;
	pageSize: number;
	/** Math.ceil(total / pageSize): 0 when nothing matches. */
	pageCount: number;
}
```

A page past the last one has `items: []` and the same `total`. A `page` or a
`pageSize` that is not a positive integer throws a `RangeError` — the value a
client sent, so answer it with a 400:

```ts
await userRepository.paginate({ page: 0 });
// RangeError: page must be an integer of at least 1, not 0
```

The count and the page are two queries. They are sent together, but under
concurrent writes `total` can still be off by the rows written between them.
When it has to be exact, run the call inside a `repeatable read`
[transaction](transactions.md#isolation).

## Cursor pages

An infinite list — a feed, an export — pages along a column instead of
counting: no `total`, and no row repeated or skipped when rows are inserted
while the client reads.

```ts
const first = await userRepository.paginateByCursor({ limit: 20 });
const second = await userRepository.paginateByCursor({
	limit: 20,
	after: first.nextCursor,
});
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `after` | `string \| null \| undefined` | none: the first page | the `nextCursor` of the previous page |
| `limit` | `number` | `20` | lowered to `maxPageSize` (`100`) when larger |
| `orderBy` | a column key | the primary key | any other column is followed by the primary key, which breaks its ties |
| `direction` | `'asc' \| 'desc'` | `'asc'` | |
| `where` | `WhereObject` or a Drizzle condition | none | applied to every page |
| `withDeleted` | `boolean` | `false` | include soft-deleted rows |

```ts
interface CursorPage<T> {
	items: T[];
	/** Pass it as `after` for the next page; `null` on the last one. */
	nextCursor: string | null;
}
```

Walking the whole table is a `do … while`:

```ts
let after: string | null = null;
do {
	const page = await userRepository.paginateByCursor({ limit: 500, after });
	await handle(page.items);
	after = page.nextCursor;
} while (after);
```

Along another column, newest first:

```ts
const page = await userRepository.paginateByCursor({
	orderBy: 'createdAt',
	direction: 'desc',
	limit: 20,
	after,
});
```

Two rules the column must follow:

- **`NOT NULL`.** A row whose ordering column is `null` cannot be paged past,
  and throws a `TypeError` naming the column.
- **No precision the type cannot hold.** A `timestamptz` at PostgreSQL's
  default microsecond precision, read into a `Date`, loses digits, and the
  next page starts at the wrong place. Declare it `precision: 3`, as
  [`timestamps()`](schema.md#why-timestamptz3) does.

A cursor written for another ordering, or not written by this package, throws
`InvalidCursorError` — also a client's input, so also a 400:

```ts
await userRepository.paginateByCursor({ after: 'garbage' });
// InvalidCursorError: Invalid cursor: it cannot be decoded

const byId = await userRepository.paginateByCursor({ limit: 2 });
await userRepository.paginateByCursor({ after: byId.nextCursor, orderBy: 'createdAt' });
// InvalidCursorError: it was written for the ordering id:asc, not createdAt:asc
```

A cursor is base64url of the last row's ordering values. It is **encoded, not
signed**: a client can read those values and forge one. A forged cursor can
only ask for rows the `where` already allows.

## One page of any query

`paginate(db, query, options)` pages a select you wrote yourself — joins,
aggregates, a projection — and counts it.

```ts
import { eq } from 'drizzle-orm';
import { paginate } from '@nxgt/drizzle/pg';
import { teams, users } from './schema';

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

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `page` | `number` | `1` | 1-based |
| `pageSize` | `number` | `20` | |
| `maxPageSize` | `number` | `100` | the largest `pageSize` this call accepts |

The total is `count(*)` over the query as a subquery, so the query must not
carry a `limit` or an `offset` yet — the types refuse one that does. And a
subquery cannot have two columns under one name: in a join, select the
columns you need under distinct keys rather than `db.select()`.

```ts
function paginate<TRow>(
	db: PgDatabase,
	query: PaginatableQuery<TRow>,
	options?: PaginateQueryOptions,
): Promise<Page<TRow>>;

interface PaginatableQuery<TRow> {
	limit(limit: number): { offset(offset: number): PromiseLike<TRow[]> };
	as(alias: string): unknown;
}
```

## Paging something that is not a table

The pieces are exported from `@nxgt/drizzle`, with no dialect and no
database: a page of an external API, of a Redis list, of anything.

```ts
import { DEFAULT_PAGE_SIZE, pageWindow, toPage } from '@nxgt/drizzle';

const window = pageWindow({ page: 2, pageSize: 25 }, 200);
// { page: 2, pageSize: 25, limit: 25, offset: 25 }

const rows = await someApi.list({ take: window.limit, skip: window.offset });
const page = toPage(rows.items, rows.total, window);
// { items, total, page: 2, pageSize: 25, pageCount }
```

```ts
function pageWindow(options?: PageOptions, maxPageSize?: number): PageWindow;
function toPage<T>(items: T[], total: number, window: PageWindow): Page<T>;

interface PageOptions { page?: number; pageSize?: number }
interface PageWindow { page: number; pageSize: number; limit: number; offset: number }

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGE_SIZE = 100;
```

And the cursor itself, for a keyset of your own. `Date` and `bigint` values
survive the round trip, which plain JSON does not do:

```ts
import { decodeCursor, encodeCursor } from '@nxgt/drizzle';

const cursor = encodeCursor({ key: 'publishedAt:desc', values: [last.publishedAt, last.id] });
const { values } = decodeCursor(cursor, 'publishedAt:desc');
// values: readonly unknown[] — the Date and the id, as they were written
```

```ts
interface CursorPayload {
	/** The ordering it was written for: `<column>:<asc|desc>`. */
	readonly key: string;
	readonly values: readonly unknown[];
}

function encodeCursor(payload: CursorPayload): string;
/** Throws InvalidCursorError for anything else, or another ordering. */
function decodeCursor(cursor: string, expectedKey?: string): CursorPayload;
```

## In a Hono route

```ts
import { Hono } from 'hono';
import { InvalidCursorError } from '@nxgt/drizzle';
import { createRepository } from '@nxgt/drizzle/pg';
import { db } from './db';
import { users } from './schema';

const userRepository = createRepository(db, users);

export const app = new Hono()
	.get('/users', async (c) => {
		const page = await userRepository.paginate({
			page: Number(c.req.query('page') ?? 1),
			pageSize: Number(c.req.query('pageSize') ?? 20),
			orderBy: { createdAt: 'desc', id: 'asc' },
		});
		return c.json(page); // RangeError on a bad page: a 400 in the app's handler
	})
	.get('/users/feed', async (c) => {
		try {
			const { items, nextCursor } = await userRepository.paginateByCursor({
				after: c.req.query('after'),
				limit: 20,
				orderBy: 'createdAt',
				direction: 'desc',
			});
			return c.json({ items, nextCursor });
		} catch (error) {
			if (error instanceof InvalidCursorError) {
				return c.json({ error: 'Invalid cursor' }, 400);
			}
			throw error;
		}
	});
```

Next: [guide/errors.md](errors.md) for the one handler that answers both.
