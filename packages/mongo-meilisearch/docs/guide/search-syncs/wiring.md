# Wiring it over a Mongo

`createSearchSyncs(mongo, config)` takes what
[`@nxgt/mongo`](https://www.npmjs.com/package/@nxgt/mongo)'s `openMongo`
returned and one entry per collection to follow — an index and a transform — and gives back
one object holding every sync.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { createSearchSyncs } from '@nxgt/mongo-meilisearch';
import { mongo } from './db';                            // the app's openMongo
import { meili } from './meili';                       // a Meilisearch client
import { articleIndex, authorIndex } from './search';  // its defineIndexes

const search = createSearchSyncs(mongo, {
	articles: {
		index: bindIndex(meili, articleIndex),
		transform: (article) =>
			article.draft ? null : { id: String(article._id), title: article.title },
	},
	authors: {
		index: bindIndex(meili, authorIndex),
		transform: (author) => ({ id: String(author._id), name: author.name }),
	},
});
```

`createSearchSyncs` sends nothing: it builds the syncs.
[`reindexAll` and `start`](lifecycle.md) are what write.

## The keys are the Mongo's own

A key is the name a collection is **exported** under — the same one
`mongo.db.articles` answers to, not the collection's name on the server. That
is what lets the transform be written inline: its argument is typed by the
collection the key names, and its result by the index that entry carries.

```ts
createSearchSyncs(mongo, {
	nowhere: { index: bindIndex(meili, articleIndex), transform: () => null },
});
// Type error: index: 'createSearchSyncs: this Mongo wires no collection called "nowhere"'
// TypeError at run time: createSearchSyncs: this Mongo wires no collection called "nowhere"
```

A key that is a member of the driver's `Db` — `command`, `watch` — is refused
the same way: the Mongo never wires a collection under one.

Only the collections you name are followed. A Mongo wiring twenty collections
and a config naming two builds two syncs.

## One database

`createSearchSyncs` follows the collections of **one** database, as `mongo.db` itself
does:

```ts
const mongo = await openMongo(
	defineMongo({
		databases: {
			main: { uri, collections },
			analytics: { uri, database: 'analytics', collections: events },
		},
	}),
);

createSearchSyncs(mongo, { articles: { index, transform } });
// TypeError: createSearchSyncs: this Mongo holds 2 databases (main, analytics),
// and createSearchSyncs follows the collections of one. Build one
// `createSearchSyncs` per database, from a Mongo that wires that database alone
```

A Mongo of several has no sole collections, so its keys are `never` and the
config does not compile either — every entry is refused, with the same
`wires no collection called "…"` message. Build one Mongo per database,
and one `createSearchSyncs` over each.

## What an entry takes

Everything [`createSearchSync`](../sync-lifecycle.md)
takes **except `collection`**, which the Mongo already holds:

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `index` | `TypedIndex<I>` | — | Where the documents go: from `bindIndex` |
| `transform` | `Transform<Col, I>` | — | The document as the index holds it; `null` keeps it out, and takes it out |
| `toIndexId` | `ToIndexId<Col, I>` | `String` | The index id of a `_id`. Optional while the index's ids are strings, required otherwise |
| `name` | `string` | `'<collection>:<index uid>'` | What this sync's resume point is recorded under |
| `stateCollection` | `string` | `'nxgt_search_sync'` | Where resume points are kept, in the Mongo's database |
| `batchSize` | `number` | `500` | Changes, or documents, sent at once |
| `flushIntervalMs` | `number` | `1000` | How long a change waits for others |
| `positionIntervalMs` | `number` | `60000` | How often a quiet sync records where its stream is |
| `leaseMs` | `number` | `30000` | How long the lease on this sync's name lasts unrenewed; a running sync renews it every third of that |
| `pageSize` | `number` | `100` | Documents a reindex reads per page |
| `onHistoryLost` | `'reindex' \| 'fail'` | `'reindex'` | What `start` does when a resume point is older than the server's history |

Each entry sets its own: a large collection can take a bigger `pageSize`
while a small one keeps the default.

```ts
const search = createSearchSyncs(mongo, {
	articles: {
		index: bindIndex(meili, articleIndex),
		transform: toArticleHit,
		pageSize: 500,
		onHistoryLost: 'fail',
	},
	authors: {
		index: bindIndex(meili, authorIndex),
		transform: toAuthorHit,
		name: 'authors:public',
	},
});
```

**Two `createSearchSyncs` built from one config share their resume points**, since
the default `name` is `'<collection>:<index uid>'`. Give `name` when two are
meant to be different.

## The whole wiring

The clients, the Mongo, the index settings, the syncs:

```ts
// src/search/index.ts
import { bindIndex } from '@nxgt/meilisearch';
import { openMongo } from '@nxgt/mongo';
import { createSearchSyncs } from '@nxgt/mongo-meilisearch';
import { Meilisearch } from 'meilisearch';
import { config } from '../db';
import { articleIndex, authorIndex, toArticleHit, toAuthorHit } from './indexes';

export const meili = new Meilisearch({
	host: process.env.MEILI_HOST!,
	apiKey: process.env.MEILI_KEY!,
});

export async function buildSearch() {
	const mongo = await openMongo(config);

	const search = createSearchSyncs(mongo, {
		articles: { index: bindIndex(meili, articleIndex), transform: toArticleHit },
		authors: { index: bindIndex(meili, authorIndex), transform: toAuthorHit },
	});

	// Every index created and its settings applied, before anything writes
	// documents: a deployment step, beside `mongo.sync()`.
	await search.syncIndexes();

	return { mongo, search };
}
```

`createSearchSyncs` **does not own the Mongo**: closing its syncs stops them
and nothing else, and `mongo.close()` stays the caller's to make.

## Signatures

```ts
function createSearchSyncs<C, const I extends IndexMap<I>>(
	mongo: Mongo<C>,
	config: SearchSyncsConfig<C, I>,
): SearchSyncs<I>;

type SearchSyncEntry<Col, I> = Omit<SearchSyncOptions<Col, I>, 'collection'>;

type SearchSyncsConfig<C, I extends IndexMap<I>> = {
	[K in keyof I]: K extends keyof SoleCollections<C>
		? SoleCollections<C>[K] extends infer Col extends AnyCollectionDefinition
			? SearchSyncEntry<Col, I[K]>
			: never
		: {
				index: `createSearchSyncs: this Mongo wires no collection called "${K & string}"`;
			};
};

type SoleCollections<C>; // what a Mongo's sole database holds, by export name
type IndexMap<I> = { [K in keyof I]: AnyIndexDefinition };
type ByKey<S, T> = { readonly [K in keyof S]: T };
```

`I` is inferred from each entry's `index` alone, which is what lets a
`transform` be written inline.

## Next

- [The search syncs' lifecycle](lifecycle.md) — `reindexAll`, `start`, `failed`,
  `flush` and `close`.
