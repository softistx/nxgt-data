# Pagination

Two ways to hand out a list: by page number, which can show a total and jump
to page 7, and by cursor, which is stable while the collection is written to.

```ts
import { getCollection } from '@nxgt/mongo';
import { posts } from './collections';

const collection = getCollection(db, posts);

const page = await collection.paginate({ page: 2, pageSize: 20, sort: { title: 1 } });
page.items;       // ReadDocumentOf<typeof posts>[]
page.total;       // every document that matches, across all pages
page.page;        // 2
page.pageSize;    // 20
page.pageCount;   // Math.ceil(total / pageSize), 0 when nothing matches
```

Both leave soft-deleted documents out, as every read does, and both take the
same `filter` a read takes — strings that arrive from outside included.

## By page number

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `page` | `number` | `1` | 1-based. Not a positive integer: a `RangeError` naming the call |
| `pageSize` | `number` | `20` | lowered to `maxPageSize` (`100`) when it is larger |
| `filter` | `FilterOf<Def>` | `{}` | what to count and to list |
| `sort` | `SortOf<Def>` | `{ _id: 1 }` | so that pages are stable |
| `withDeleted` | `boolean` | `false` | include soft-deleted documents |

```ts
const collection = getCollection(db, posts, { maxPageSize: 500 });
await collection.paginate({ pageSize: 200 });   // 200 here, 100 by default

await collection.paginate({ page: 0 });
// RangeError: paginate on "posts": page must be an integer of at least 1, not 0
await collection.paginate({ pageSize: -1 });
// RangeError: paginate on "posts": pageSize must be an integer of at least 1, not -1
```

**The refusal names the call and the collection.** Every paginated call takes
the same `page`, `pageSize` and `limit`, so a log line reading only
`pageSize must be an integer of at least 1` said nothing about which listing
of an application produced it. `paginateByCursor` and a bucket's
[`paginate`](gridfs.md#listing) name themselves the same way —
`paginateByCursor on "posts": limit must be …`, `paginate on "uploads":
limit must be …`.

The count and the page are read together, so `total` costs a second query:
it is the price of showing one.

## By cursor

```ts
let after: string | null = null;
do {
	const page = await collection.paginateByCursor({
		after,
		limit: 100,
		orderBy: 'rank',
		direction: 'desc',
	});
	await send(page.items);
	after = page.nextCursor;
} while (after);
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `after` | `string \| null` | — | the `nextCursor` of the page before; omit it for the first |
| `limit` | `number` | `20` | lowered to `maxPageSize`; below 1 is a `RangeError` naming the call |
| `orderBy` | `FieldOf<Def>` | `'_id'` | the field to page along. A field the schema does not have is a `TypeError` |
| `direction` | `'asc' \| 'desc'` | `'asc'` | |
| `filter` | `FilterOf<Def>` | `{}` | |
| `withDeleted` | `boolean` | `false` | |

The cursor is a keyset on the field **and** `_id`, which breaks its ties: no
document is repeated or skipped while the collection is written to, where
`skip` would do both. `nextCursor` is `null` on the last page.

It is opaque and URL-safe, and it survives `ObjectId`, `Date` and `bigint`
values. **It is encoded, not signed**: a client can read it, and forge one.

Two refusals to know about:

```ts
// A cursor written for another ordering — or a forged one — is refused:
await collection.paginateByCursor({ after: cursor, orderBy: 'title' });
// InvalidCursorError: Invalid cursor in paginateByCursor on "posts": it was
// written for the ordering _id:asc, not title:asc

// Paging along a field a document does not have cannot produce a cursor:
await collection.paginateByCursor({ orderBy: 'rank' });
// TypeError: paginateByCursor: "rank" is null in a document of "posts".
//            Page along a field every document has.
```

### What a refused cursor says

The message leads with `Invalid cursor`, which is the part to search for, then
names the call and the collection, then what is wrong with it:

| The message ends | What happened |
| --- | --- |
| `: it cannot be decoded` | not base64url of JSON: a truncated query string, or a cursor from somewhere else |
| `: unexpected shape` | it decodes, but it is not `[key, values]` |
| `: it was written for the ordering createdAt:asc, not rank:desc` | the page before was ordered differently — `orderBy` or `direction` changed between two pages |
| `: it holds 2 value(s) where the ordering _id:asc needs 1 (_id)` | the ordering pages along one field here and two there |

```ts
await collection.paginateByCursor({ after: 'garbage' });
// InvalidCursorError: Invalid cursor in paginateByCursor on "posts": it cannot be decoded
```

All four are a client's input — a cursor travels in a query string — so all
four are a 400, and all four are an `InvalidCursorError` carrying
`code: 'INVALID_CURSOR'`. One `catch` takes the lot, and
[a map from the code alone](errors.md#turning-them-into-answers) answers
them:

```ts
import { InvalidCursorError } from '@nxgt/mongo';

if (error instanceof InvalidCursorError) return c.json({ error: 'Bad page' }, 400);
```

The last of the four used to arrive as a plain `DataError` with
`code: 'DATABASE'`, so a handler mapping codes answered 500 to a forged
cursor. Since 0.17.0 it does not.

`orderBy` wants an index to be quick: `{ key: { rank: -1, _id: -1 } }` is the
one this page reads.

## A list endpoint

```ts
app.get('/posts', async (c) => {
	const tag = c.req.query('tag');
	const page = await getCollection(c.env.db, posts).paginateByCursor({
		after: c.req.query('cursor') ?? null,
		limit: Number(c.req.query('limit') ?? 20),
		orderBy: 'createdAt',
		direction: 'desc',
		filter: tag ? { tags: tag } : {},
	});
	return c.json({
		items: page.items,
		next: page.nextCursor && `/posts?cursor=${page.nextCursor}`,
	});
});
```

`limit` comes from the query string, so `maxPageSize` is what stops a caller
asking for the whole collection; it needs no check of its own.

## Paging, then populating

[`populate`](aggregation.md#populate) sends one query per relation, holding
every id at once — so page first:

```ts
const page = await collection.paginate({ pageSize: 50 });
const withAuthors = await collection.populate(page.items, {
	author: { from: users, by: 'authorId' },
});
```

## The pieces

The same cursor and window helpers the collection uses, for a list this
package does not produce — an aggregation of your own:

```ts
import {
	cursorLimit,
	decodeCursor,
	DEFAULT_MAX_PAGE_SIZE,
	DEFAULT_PAGE_SIZE,
	encodeCursor,
	pageWindow,
	toPage,
} from '@nxgt/mongo';

const window = pageWindow({ page: 3, pageSize: 25 });   // { page, pageSize, limit, skip }
const documents = await collection.raw
	.aggregate([{ $sort: { rank: -1 } }, { $skip: window.skip }, { $limit: window.limit }])
	.toArray();
const page = toPage(documents, await collection.count(), window);

const cursor = encodeCursor({ key: 'rank:desc', values: [3, lastId] });
decodeCursor(cursor, 'rank:desc');   // { key, values } — or InvalidCursorError
cursorLimit(500);                    // 100: DEFAULT_MAX_PAGE_SIZE
```

`decodeCursor`, `cursorLimit` and `pageWindow` each take a last argument
naming the call, which they put in the message the way the collection's own
do — so a refusal from a listing of your own is as easy to place as one from
`paginate`:

```ts
cursorLimit(0, 100, 'topPosts');
// RangeError: topPosts: limit must be an integer of at least 1, not 0
decodeCursor('garbage', 'rank:desc', 'topPosts');
// InvalidCursorError: Invalid cursor in topPosts: it cannot be decoded
```

It is optional on all three, so a call that passes none reads exactly as it
did.

```ts
function pageWindow(options?: PageOptions, maxPageSize?: number, where?: string): PageWindow;
function cursorLimit(limit: number | undefined, maxPageSize?: number, where?: string): number;
function decodeCursor(cursor: string, expectedKey?: string, where?: string): CursorPayload;
```

## The signatures

```ts
paginate(options?: PaginateOptions<Def>): Promise<Page<ReadDocumentOf<Def>>>;
paginateByCursor(options?: CursorPaginateOptions<Def>): Promise<CursorPage<ReadDocumentOf<Def>>>;

interface Page<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
	pageCount: number;
}

interface CursorPage<T> {
	items: T[];
	nextCursor: string | null;
}
```

A bucket pages the same way: [Files](gridfs.md#listing).

## Next

- [Documents](documents.md) — the reads these are built on.
- [Aggregation](aggregation.md) — grouping and relations over a page.
