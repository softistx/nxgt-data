# Wiring a sync

A sync is the pairing of one PostgreSQL table with one Meilisearch index:
`createSearchSync` describes it, and the methods it gives back do the work.

```ts
import { createRepository } from '@nxgt/drizzle/pg';
import { bindIndex } from '@nxgt/meilisearch';
import { createSearchSync } from '@nxgt/drizzle-meilisearch';
import { db, meili } from './clients';              // a Drizzle db, an SDK client
import { articles, articleIndex } from './search';

export const articleRepository = createRepository(db, articles);

export const articleSearch = createSearchSync({
	repository: articleRepository,
	index: bindIndex(meili, articleIndex),
	toIndexId: (article) => article.id,
	transform: (article) =>
		article.draft ? null : { id: article.id, title: article.title },
});
```

`createSearchSync` **does no I/O**: it checks its options, resolves the
defaults, and gives back an object. Nothing reaches PostgreSQL or Meilisearch
until [a write call](indexing-writes.md) or [`reindexAll`](reindex.md).

## The two definitions

The table is declared with Drizzle and `@nxgt/drizzle`'s column helpers, the
index with `@nxgt/meilisearch`. Neither knows about this package.

```ts
import { id, softDelete, timestamps } from '@nxgt/drizzle/pg';
import { defineIndex } from '@nxgt/meilisearch';
import { boolean, pgTable, text } from 'drizzle-orm/pg-core';

export const articles = pgTable('articles', {
	id: id(), // uuid primary key default gen_random_uuid()
	title: text('title').notNull(),
	draft: boolean('draft').notNull().default(false),
	...timestamps(), // createdAt, updatedAt
	...softDelete(), // deletedAt
});

export interface ArticleHit {
	id: string;
	title: string;
}

export const articleIndex = defineIndex<ArticleHit>()({
	uid: 'articles',
	primaryKey: 'id',
	settings: { searchableAttributes: ['title'] },
});
```

The index's **settings** are `@nxgt/meilisearch`'s to apply, as a startup or
deployment step:

```ts
const index = bindIndex(meili, articleIndex);
await index.sync(); // creates the index and applies its settings
```

Worth doing before anything else: Meilisearch creates an index on a write of
documents but not on a delete, so a `remove(...)` on an index nothing has
written to yet fails. See [Indexing after a write](indexing-writes.md).

## The transform

It takes the table's row — `Row<typeof articles>`, every column, `deletedAt`
included — and gives the index's document, typed by its definition. `null`
keeps a row **out** of the index, and takes it out if it was in.

```ts
import type { Transform } from '@nxgt/drizzle-meilisearch';

export const toHit: Transform<typeof articles, typeof articleIndex> = (
	article,
) => (article.draft ? null : { id: article.id, title: article.title });
```

It may be `async` — the type allows a promise — which is how a document that
needs another read is built:

```ts
createSearchSync({
	repository: articleRepository,
	index,
	toIndexId: (article) => article.id,
	transform: async (article) => {
		if (article.draft) return null;
		const tags = await tagRepository.findMany({
			where: { articleId: article.id },
		});
		return {
			id: article.id,
			title: `${article.title} ${tags.map((tag) => tag.name).join(' ')}`,
		};
	},
});
```

A write to that other table does not reach the index by itself; only a call on
this sync does.

The document must carry the row's **index id** under the index's primary key.
One under another id could never be taken out again, so it is refused with
`ID_MISMATCH`. Anything that is neither a document nor `null` — a string, a
number, an array — is refused with `NOT_A_DOCUMENT`, and the message reports
its shape rather than its value.

## `toIndexId` is required

```ts
toIndexId: (article) => article.id,
```

The MongoDB bridge defaults this to `String`, because every document there has
an `_id`. Here nothing could be defaulted to: Drizzle 1.0's column types do
not carry `.primaryKey()`, so neither the repository nor the table can say
which column holds the id — `@nxgt/drizzle`'s own `PrimaryKeyOf` falls back to
the key `id` for exactly that reason. One line per sync says it outright, and
says it where the index's own id type can check it:

```ts
import { bindIndex, defineIndex } from '@nxgt/meilisearch';
import { createRepository } from '@nxgt/drizzle/pg';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

const counters = pgTable('counters', {
	id: integer('id').primaryKey(),
	label: text('label').notNull(),
});

const counterIndex = bindIndex(
	meili,
	defineIndex<{ n: number; label: string }>()({
		uid: 'counters',
		primaryKey: 'n',
		settings: {},
	}),
);

createSearchSync({
	repository: createRepository(db, counters),
	index: counterIndex,
	toIndexId: (counter) => counter.id, // a number, as the index's ids are
	transform: (counter) => ({ n: counter.id, label: counter.label }),
});
```

The index's id type checks it. Leaving `toIndexId` out, or giving another
type than the index's ids, does not compile:

```ts
// @ts-expect-error toIndexId is required: no column is known to be the id
createSearchSync({ repository, index, transform: () => null });

createSearchSync({
	repository: createRepository(db, counters),
	index: counterIndex,
	// @ts-expect-error the index's id is a number
	toIndexId: (counter) => String(counter.id),
	transform: (counter) => ({ n: counter.id, label: counter.label }),
});
```

The README lists [what does not compile](../../README.md#what-does-not-compile);
every line of it is a `@ts-expect-error` case in `test/types/search-sync.ts`.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `repository` | `SyncRepository<TTable>` | — | Where the rows are: from `createRepository` |
| `index` | `TypedIndex<I>` | — | Where they go: from `bindIndex` |
| `transform` | `Transform<TTable, I>` | — | The row as the index holds it, or `null` to keep it out |
| `toIndexId` | `ToIndexId<TTable, I>` | — | The index id of a row. Required |
| `name` | `string` | `` `${tableName}:${index.uid}` `` | What this sync is called in its errors |
| `batchSize` | `number` | `500` | Documents, or ids, sent to Meilisearch at once |
| `pageSize` | `number` | `100` | Rows `reindexAll` reads per page; above the repository's `maxPageSize`, lowered to it |

### `repository`

Anything with the table and `paginateByCursor` fits — which a `Repository`
from `createRepository` is, and so is one narrowed by `with(tx)`. It is typed
as its own shape rather than `Repository<TTable, …>`, whose other parameters
describe the primary key and the soft delete, neither of which this package
reads.

```ts
interface SyncRepository<TTable extends PgTable> {
	readonly table: TTable;
	paginateByCursor(options?: {
		after?: string | null | undefined;
		limit?: number;
	}): Promise<CursorPage<Row<TTable>>>;
}
```

The sync reads the repository only in `reindexAll`; the write calls take the
rows you hand them.

### `name`

`'<table>:<index uid>'` unless you say otherwise — `'articles:articles'` for
the table above. It is what the errors carry, as `error.sync`, and what makes
two syncs over one table distinguishable in a log:

```ts
createSearchSync({ …, name: 'articles:public' }).name; // 'articles:public'
```

### `batchSize` and `pageSize`

`batchSize` splits what goes to Meilisearch in one task — documents added, or
ids deleted. `pageSize` is how many rows `reindexAll` reads at a time, and can
be overridden per call. Both must be whole numbers above zero, or
`createSearchSync` throws a `TypeError` before anything runs:

```ts
createSearchSync({ …, batchSize: 0 });
// TypeError: createSearchSync: batchSize must be a whole number above 0, not 0
```

The same goes for an empty `name`, a `transform` that is not a function, and a
missing `toIndexId`:

```ts
createSearchSync({ …, toIndexId: undefined });
// TypeError: createSearchSync: toIndexId must be a function
```

## In an application

The sync sits beside the repository it mirrors, and each route that writes
calls it once:

```ts
import { Hono } from 'hono';
import { articleRepository, articleSearch } from './search/articles';

export const app = new Hono()
	.post('/articles', async (c) => {
		const body = await c.req.json<{ title: string }>();
		const article = await articleRepository.create({ title: body.title });
		await articleSearch.indexRow(article); // enqueued, not awaited by Meilisearch
		return c.json(article, 201);
	})
	.delete('/articles/:id', async (c) => {
		const deleted = await articleRepository.delete(c.req.param('id'));
		await articleSearch.removeRow(deleted);
		return c.body(null, 204);
	});
```

And a script fills the index, once, at deployment:

```ts
await index.sync();
const report = await articleSearch.reindexAll();
console.log(`${articleSearch.name}:`, report);
```

## Signatures

```ts
function createSearchSync<TTable extends PgTable, I extends AnyIndexDefinition>(
	options: SearchSyncOptions<TTable, I>,
): SearchSync<TTable, I>;

type Transform<TTable, I> = (
	row: Row<TTable>,
) => DocumentOf<I> | null | Promise<DocumentOf<I> | null>;

type ToIndexId<TTable, I> = (row: Row<TTable>) => IdOf<I>;

interface SearchSync<TTable extends PgTable, I extends AnyIndexDefinition> {
	readonly name: string;
	reindexAll(options?: { pageSize?: number }): Promise<ReindexReport>;
	indexRow(row: Row<TTable>, options?: IndexWriteOptions): Promise<void>;
	indexRows(rows: readonly Row<TTable>[], options?: IndexWriteOptions): Promise<void>;
	removeRow(row: Row<TTable>, options?: IndexWriteOptions): Promise<void>;
	remove(id: IdOf<I>, options?: IndexWriteOptions): Promise<void>;
	removeMany(ids: readonly IdOf<I>[], options?: IndexWriteOptions): Promise<void>;
}
```

`Row` is `@nxgt/drizzle`'s, `DocumentOf` and `IdOf` are
`@nxgt/meilisearch`'s. The package exports one function, `createSearchSync`;
one class, `SearchSyncError`; and nine types — `SearchSync`,
`SearchSyncOptions`, `SyncRepository`, `Transform`, `ToIndexId`,
`IndexWriteOptions`, `ReindexReport`, `SearchSyncErrorCode` and
`SearchSyncErrorOptions`. The [API section](../../README.md#api) of the
README has each of them in one table.

## Next

- [Indexing after a write](indexing-writes.md) — the five write calls and
  `wait`.
- [Reindexing](reindex.md) — the full fill, and what it removes.
- [Troubleshooting](../troubleshooting.md) — the errors, by their message.
