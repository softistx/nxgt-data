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
| `page` | `number` | `1` | 1-based. Not a positive integer: `RangeError` |
| `pageSize` | `number` | `20` | lowered to `maxPageSize` (`100`) when it is larger |
| `filter` | `FilterOf<Def>` | `{}` | what to count and to list |
| `sort` | `SortOf<Def>` | `{ _id: 1 }` | so that pages are stable |
| `withDeleted` | `boolean` | `false` | include soft-deleted documents |

```ts
const collection = getCollection(db, posts, { maxPageSize: 500 });
await collection.paginate({ pageSize: 200 });   // 200 here, 100 by default
await collection.paginate({ page: 0 });         // RangeError: page must be … at least 1
```

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
| `limit` | `number` | `20` | lowered to `maxPageSize`; below 1 is a `RangeError` |
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
// InvalidCursorError

// Paging along a field a document does not have cannot produce a cursor:
await collection.paginateByCursor({ orderBy: 'rank' });
// TypeError: "rank" is null in a document of "posts". Page along a field every document has.
```

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
