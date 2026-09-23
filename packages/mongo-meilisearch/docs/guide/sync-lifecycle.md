# The sync's lifecycle

A sync is the pairing of one MongoDB collection with one Meilisearch index:
`createSearchSync` describes it, and then `reindex` fills the index and
`start` keeps it in step.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { getCollection } from '@nxgt/mongo';
import { createSearchSync } from '@nxgt/mongo-meilisearch';
import { db, meili } from './clients';            // a driver Db, an SDK client
import { articles, articleIndex } from './search';

const articleSearch = createSearchSync({
	collection: getCollection(db, articles),
	index: bindIndex(meili, articleIndex),
	transform: (article) =>
		article.draft
			? null
			: { id: String(article._id), title: article.title, body: article.body },
});

const running = await articleSearch.start(); // reindexes the first time
// …
await running.close();
```

`createSearchSync` **sends nothing**: it validates its options, resolves the
defaults, and gives back an object. Every write comes from
[`reindex`](reindex.md) or [`start`](following-changes.md).

## The two definitions

The collection is `@nxgt/mongo`'s and the index is `@nxgt/meilisearch`'s;
this package creates neither, and neither knows about it.

```ts
import { defineIndex } from '@nxgt/meilisearch';
import { defineCollection, id } from '@nxgt/mongo';
import { z } from 'zod';

export const articles = defineCollection({
	name: 'articles',
	schema: z.object({
		_id: id(),
		title: z.string(),
		body: z.string(),
		draft: z.boolean().default(false),
	}),
	timestamps: true,
	softDelete: true,
});

export interface ArticleHit {
	id: string;
	title: string;
	body: string;
}

export const articleIndex = defineIndex<ArticleHit>()({
	uid: 'articles',
	primaryKey: 'id',
	settings: { searchableAttributes: ['title', 'body'] },
});
```

The index's **settings** are `@nxgt/meilisearch`'s to apply, as a deployment
step beside the collection's own sync:

```ts
const index = bindIndex(meili, articleIndex);
await index.sync(); // creates the index and applies its settings
```

## The transform

It takes the collection's document, typed by its schema, and gives the
index's document, typed by its definition. `null` keeps a document **out** of
the index — and takes it out if it was in.

```ts
const transform = (article: ReadDocumentOf<typeof articles>) =>
	article.draft
		? null
		: { id: String(article._id), title: article.title, body: article.body };
```

It runs for every document of a reindex and for every change that is
followed, so a document that stops qualifying is removed the moment it does.
It may be `async` — the type allows a promise — and it should be a function
of its document alone: a change may be applied twice, and a transform that
throws stops the sync.

The document it returns must carry its **index id** under the index's primary
key. One under another id could never be taken out again, so it is refused
with `ID_MISMATCH`. It must return a document or `null`; anything else —
a string, a number, an array — is refused with `NOT_A_DOCUMENT`, and the
message reports its shape rather than its value.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `collection` | `TypedCollection<C>` | — | Where the documents are: from `getCollection` |
| `index` | `TypedIndex<I>` | — | Where they go: from `bindIndex` |
| `transform` | `Transform<C, I>` | — | The document as the index holds it, or `null` to keep it out |
| `toIndexId` | `ToIndexId<C, I>` | `String` | The index id of a `_id`. Optional while the index's ids are strings, required otherwise |
| `name` | `string` | `'<collection>:<index uid>'` | What the resume point and the lease are recorded under. Two syncs under one name share both |
| `stateCollection` | `string` | `'nxgt_search_sync'` | Where the resume point and the lease are kept, in the collection's database |
| `batchSize` | `number` | `500` | Changes, or documents, sent to Meilisearch at once |
| `flushIntervalMs` | `number` | `1000` | How long a change waits for others; `0` sends at the next tick |
| `positionIntervalMs` | `number` | `60000` | How often a sync with nothing to send records where the stream is |
| `leaseMs` | `number` | `30000` | How long the lease on the name lasts unrenewed; a running sync renews it every third of that. See [the lease](following-changes.md#one-process-per-name-the-lease) |
| `pageSize` | `number` | `100` | Documents a reindex reads per page; above the collection's `maxPageSize`, lowered to it |
| `onHistoryLost` | `'reindex' \| 'fail'` | `'reindex'` | What `start` does when the resume point is older than the server's change history |

### `toIndexId`

`String(_id)` by default, which suits an `ObjectId`. When the index's primary
key is not a string, the option stops being optional:

```ts
createSearchSync({
	collection: getCollection(db, counters), // _id: z.int()
	index: bindIndex(meili, counterIndex),   // primaryKey: 'n', a number
	toIndexId: (id) => id,
	transform: (counter) => ({ n: counter._id, label: counter.label }),
});
```

### `name` and `stateCollection`

The resume point is a document in the collection's own database, so a restart
picks up where the last run stopped:

```ts
const sync = createSearchSync({
	collection,
	index,
	transform,
	name: 'articles:public',
});

await sync.state();
// { _id: 'articles:public', resumeToken: …, updatedAt: …, reindexedAt: … }
```

`state()` is `undefined` until the first reindex records something. The same
collection holds the name's lease, under `_id: { lease: 'articles:public' }`,
while a process follows or reindexes it.

### `batchSize`, `flushIntervalMs`, `pageSize`

`batchSize`, `positionIntervalMs`, `leaseMs` and `pageSize` must be whole
numbers above zero and `flushIntervalMs` a whole number of milliseconds, or
`createSearchSync` throws a `TypeError` before anything runs — as it does for
an empty `name` or a `transform` that is not a function.

```ts
createSearchSync({ collection, index, transform, batchSize: 0 });
// TypeError: createSearchSync: batchSize must be a whole number above 0, not 0
```

## A worker process

Wiring, settings, first fill and shutdown, in the order they happen:

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { connectMongo, getCollection } from '@nxgt/mongo';
import { createSearchSync, SearchSyncError } from '@nxgt/mongo-meilisearch';
import { Meilisearch } from 'meilisearch';
import { articles, articleIndex } from './search';

const mongo = await connectMongo(process.env.MONGO_URI!);
const meili = new Meilisearch({
	host: process.env.MEILI_HOST!,
	apiKey: process.env.MEILI_KEY!,
});

const index = bindIndex(meili, articleIndex);
await index.sync();

const articleSearch = createSearchSync({
	collection: getCollection(mongo.db, articles),
	index,
	transform: (article) =>
		article.draft
			? null
			: { id: String(article._id), title: article.title, body: article.body },
});

const running = await articleSearch.start();
process.on('SIGTERM', () => {
	void running.close().then(() => mongo.close());
});

// Rejects with a SearchSyncError if the sync stops on an error.
await running.closed.catch((error: SearchSyncError) => {
	console.error({ sync: error.sync, code: error.code, cause: error.cause });
	process.exit(1); // let the supervisor restart it
});
```

## Signatures

```ts
function createSearchSync<
	C extends AnyCollectionDefinition,
	I extends AnyIndexDefinition,
>(options: SearchSyncOptions<C, I>): SearchSync;

type Transform<C, I> = (
	document: ReadDocumentOf<C>,
) => DocumentOf<I> | null | Promise<DocumentOf<I> | null>;

type ToIndexId<C, I> = (id: IdOf<C>) => IdOf<I>;

interface SearchSync {
	readonly name: string;
	reindex(): Promise<ReindexReport>;
	start(): Promise<RunningSearchSync>;
	state(): Promise<SearchSyncState | undefined>;
}

interface SearchSyncState {
	_id: string;
	resumeToken: ResumeToken;
	updatedAt: Date;
	reindexedAt: Date | undefined;
}
```

## Next

- [Reindexing](reindex.md) — the full fill, and what it removes.
- [Following changes](following-changes.md) — the change stream, its batches
  and its errors.
- [What it leaves out](boundaries.md).
