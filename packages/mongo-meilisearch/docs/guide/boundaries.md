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

// One follower per name: everything below is what that costs.
const running = await articleSearch.start();
```

## One follower per sync name

Several processes may **start** one sync; only one **follows** it at a time.
`start()` takes a lease on the name, and the others are refused with
`RUNNING` until it lets go or its lease lapses. What the lease is, and how to
run a standby, is in
[Following changes](following-changes.md#one-process-per-name-the-lease).

What it does not give:

- **Shared work.** A second process does not take half the changes; it
  waits. To spread the load, run one sync per collection, each under its own
  `name`, in as many processes as you like.
- **Fencing.** A process stalled for longer than `leaseMs` does not know it
  lost the name until its next renewal, up to `leaseMs / 3` later, and may
  send a batch beside the process that took over. Both send whole documents,
  which are safe to apply twice, and each records only what it applied, so
  the index and the resume point stay right. Keep `leaseMs` well above the
  longest pause a process may take.

Give two syncs different `name`s when they are meant to be independent — the
default, `'<collection>:<index uid>'`, is shared by any two syncs over the
same pair, and so is its lease.

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
  `stateCollection`, where the resume point and the lease both live; the
  Meilisearch key needs `documents.add`, `documents.get`, `documents.delete`
  and `tasks.get`, plus `indexes.create` unless the index already exists.

## Next

- [The sync's lifecycle](sync-lifecycle.md) — the options behind each of
  these.
- [Roadmap](../roadmap.md) — what is being worked on, and what is not planned.
