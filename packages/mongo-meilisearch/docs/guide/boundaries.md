# What it leaves out

The sync writes documents into one index from one collection. Everything
below is deliberately somebody else's job — either another package's, or the
caller's — so that the sync stays a function of the collection it was given.

```ts
import { bindIndex } from '@nxgt/meilisearch';
import { getCollection } from '@nxgt/mongo';
import { createSearchSync } from '@nxgt/mongo-meilisearch';
import { db, meili } from './clients';            // a driver Db, an SDK client
import { articles, articleIndex } from './search';

const articleSearch = createSearchSync({
	collection: getCollection(db, articles),
	index: bindIndex(meili, articleIndex),
	transform: (article) => ({ id: String(article._id), title: article.title }),
});

// One follower, in one process: everything below is what that costs.
const running = await articleSearch.start();
```

## Several processes sharing one sync — not yet

There is **no lock today**: run one follower per sync name. Two processes
under one name do the same writes twice, and both are wrong the moment one of
them reindexes: a `reindex()` in one while the other follows removes
documents the follower has already indexed and will never send again.

Inside **one** process the package does refuse it: a second `start()`, or a
`reindex()`, throws `SearchSyncError` with the code `RUNNING`.

Give two syncs different `name`s when they are meant to be independent — the
default, `'<collection>:<index uid>'`, is shared by any two syncs over the
same pair.

A lease on a sync name, renewed while a follower runs, is being worked on;
[the roadmap](../roadmap.md) says where it stands. Until it ships, one writer
per name is the rule.

## Partial updates

A change sends the **whole** document the transform gives, never a patch:

```ts
transform: (article) => ({
	id: String(article._id),
	title: article.title,
	body: article.body,
});
```

That is what makes a change safe to apply twice, which it may be — the resume
point moves after a batch is applied, so a restart re-sends what was in
flight.

## The index's settings

`searchableAttributes`, `filterableAttributes`, the ranking rules: they are
`@nxgt/meilisearch`'s, applied as a deployment step.

```ts
import { bindIndex, syncIndexes } from '@nxgt/meilisearch';

const index = bindIndex(meili, articleIndex);
await index.sync();                       // this one index
await syncIndexes(meili, [articleIndex]); // or every index of the app at once
```

This package writes documents, and creates nothing but them — the first write
to an index that does not exist is what creates it, with no settings of its
own.

## Joining other collections in

The transform may read another collection, but a change to **that**
collection does not reach the index: the sync follows the one it was given.

```ts
export const articleIndex = defineIndex<{
	id: string;
	title: string;
	author: string;
}>()({ uid: 'articles', primaryKey: 'id' });

import { authors } from './search'; // the authors collection's definition

createSearchSync({
	collection: getCollection(db, articles),
	index: bindIndex(meili, articleIndex),
	// The author's name is read here, so it is right when the article is
	// written — and stale from the moment the author is renamed: nothing is
	// following the authors.
	transform: async (article) => ({
		id: String(article._id),
		title: article.title,
		author:
			(await getCollection(db, authors).findById(article.authorId))?.name ?? '',
	}),
});
```

Run a sync per collection that has to move the index, or denormalise the
field into the collection the sync follows and let its own writes carry it.

## One index, one collection

A reindex removes every document the collection does not give it, whoever
wrote it. Two collections pointed at one index, or an index another process
also writes to, lose documents at the first reindex. The sync owns its index.

## What the caller still owns

- **Restarting a sync that stopped.** `closed` rejects with a
  `SearchSyncError`; the supervisor is what brings the process back. See
  [Following changes](following-changes.md).
- **Choosing when a full reindex runs**, with `onHistoryLost: 'fail'`.
- **The two clients.** This package creates neither the `MongoClient` nor the
  Meilisearch client, and closes neither.
- **The permissions.** The MongoDB user needs `find` and `changeStream` on
  the collection and `find`, `insert`, `update` and `delete` on
  `stateCollection`; the Meilisearch key needs `documents.add`,
  `documents.get`, `documents.delete` and `tasks.get`, plus `indexes.create`
  unless the index already exists.

## Next

- [The sync's lifecycle](sync-lifecycle.md) — the options behind each of
  these.
- [Roadmap](../roadmap.md) — what is being worked on, and what is not planned.
