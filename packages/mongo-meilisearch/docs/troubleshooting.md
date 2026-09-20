# Troubleshooting

Every heading is the text the error prints, so the page can be searched with
what you have in front of you. Stacks, ids and paths are cut, and a sync's
name is written as it comes out by default — `<collection>:<index uid>`, here
`articles:articles`.

Everything this package throws is a `SearchSyncError` carrying a `code`
(`HISTORY_LOST`, `ID_MISMATCH`, `RUNNING`, `FAILED`), the sync's `name`, and
the original error as `cause` — except the options, which are refused with a
`TypeError` before anything is opened.

| Area | Entries |
| --- | --- |
| [Install](#install) | [ERESOLVE](#npm-error-eresolve-unable-to-resolve-dependency-tree) · [incorrect peer dependency](#warn-incorrect-peer-dependency-nxgtmongo0140) · [TS2307](#error-ts2307-cannot-find-module-nxgtmongo-or-its-corresponding-type-declarations) |
| [Options](#options) | [transform](#createsearchsync-transform-must-be-a-function) · [batchSize](#createsearchsync-batchsize-must-be-a-whole-number-above-0-not-0) · [flushIntervalMs](#createsearchsync-flushintervalms-must-be-a-whole-number-of-milliseconds-not--1) · [name](#createsearchsync-name-must-not-be-empty) |
| [Starting](#starting) | [no replica set](#search-sync-articlesarticles-failed-starting-the-changestream-stage-is-only-supported-on-replica-sets) · [privileges](#search-sync-articlesarticles-failed-reindexing-not-authorized-on-app-to-execute-command--aggregate-articles-pipeline---changestream-----) · [history lost](#search-sync-articlesarticles-was-last-at-a-point-the-servers-change-history-no-longer-reaches-reindex-it-or-start-it-with-onhistorylost-reindex) · [already running](#search-sync-articlesarticles-is-already-following-changes-in-this-process-close-it-before-you-start-it-twice) |
| [The transform](#the-transform) | [an id that is not the index's](#search-sync-articlesarticles-transform-gave-id-other-for-the-document--whose-index-id-is-) · [not a document](#transform-must-return-a-document-or-null-not-nope) · [it threw](#search-sync-articlesarticles-failed-following-changes-boom) |
| [Sending](#sending) | [an id Meilisearch refuses](#search-sync-articlesarticles-failed-sending-changes-task-3-documentadditionorupdate-on-index-articles-failed-document-identifier--is-invalid) |
| [Stopping](#stopping) | [a dropped collection](#the-sync-stops-and-closed-resolves-with-invalidated) |

## Install

### `npm error ERESOLVE unable to resolve dependency tree`

```
npm error Found: @nxgt/mongo@0.14.0
npm error Could not resolve dependency:
npm error peer @nxgt/mongo@"^0.15.0" from @nxgt/mongo-meilisearch@0.1.6
```

**When:** `npm install`, before anything is downloaded.

**Why:** this package is a bridge: `@nxgt/mongo` and `@nxgt/meilisearch` are
**required peers**, and the ranges are carets on 0.x versions, so each accepts
one minor only. The collection and the index are built by those two packages
and handed here, so they have to be the copies this version was built against.
`mongodb`, `meilisearch` and `typescript` are peers on the same terms.

**Fix:**

```sh
npm install @nxgt/mongo@^0.15.0 @nxgt/meilisearch@^0.1.0 @nxgt/mongo-meilisearch mongodb meilisearch zod
```

Raise the siblings rather than install past the conflict: `--force` and
`--legacy-peer-deps` leave two copies of a sibling in the tree, and the
definitions one of them builds are not the ones this package reads.

### `warn: incorrect peer dependency "@nxgt/mongo@0.14.0"`

**When:** `bun install`, which prints it and carries on.

**Why:** bun does not fail on an unmet peer — it warns and installs what the
manifest asked for. The bridge then runs against a sibling it was not built
against, and what is missing shows up at the first call that needs it rather
than at install.

**Fix:**

```sh
bun add @nxgt/mongo@^0.15.0 @nxgt/meilisearch@^0.1.0
```

Treat that warning as an error. `bun pm ls` shows which versions were resolved.

### `error TS2307: Cannot find module '@nxgt/mongo' or its corresponding type declarations.`

At run time the same tree gives
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@nxgt/mongo'` under Node,
and `error: Cannot find module '@nxgt/mongo'` under Bun.

**When:** the first build or the first import of your own code, typically
under pnpm or npm with a strict `node_modules` layout.

**Why:** a peer installed *for* this package is not a dependency of **yours**.
It is resolved under the bridge alone, so `@nxgt/mongo-meilisearch` finds it
and your own `import { getCollection } from '@nxgt/mongo'` does not.

**Fix:**

```sh
bun add @nxgt/mongo @nxgt/meilisearch @nxgt/mongo-meilisearch mongodb meilisearch zod
```

You import both siblings yourself — `getCollection` and `bindIndex` are what
build the two arguments this package takes.

## Options

`createSearchSync` sends nothing and opens nothing: everything below throws
where the sync is described.

### `createSearchSync: transform must be a function`

**When:** calling `createSearchSync`.

**Why:** `transform` is the one required function of the options, and it is
missing or is not callable — usually an object destructured from a config, or
an `await import` whose default was not unwrapped.

**Fix:**

```ts
createSearchSync({
	collection,
	index,
	transform: (article) => ({ id: String(article._id), title: article.title }),
});
```

### `createSearchSync: batchSize must be a whole number above 0, not 0`

The same refusal covers `positionIntervalMs` and `pageSize`.

**When:** calling `createSearchSync`.

**Why:** those three count documents or milliseconds, and `0`, a fraction,
`NaN` and a negative number have no meaning for any of them. A value read from
the environment is a string until it is parsed, and `Number('')` is `0`.

**Fix:**

```ts
createSearchSync({ collection, index, transform, batchSize: 500 }); // the default
```

### `createSearchSync: flushIntervalMs must be a whole number of milliseconds, not -1`

**When:** calling `createSearchSync`.

**Why:** `flushIntervalMs` is the one option that accepts `0` — send every
change as it comes — so it is checked apart from the three above. A negative
number or a fraction is still refused.

**Fix:**

```ts
createSearchSync({ collection, index, transform, flushIntervalMs: 1000 }); // the default
```

### `createSearchSync: name must not be empty`

**When:** calling `createSearchSync` with `name: ''`.

**Why:** the name is the `_id` of the document the resume point is recorded
under, so it cannot be empty. Left out, it is `<collection>:<index uid>`.

**Fix:**

```ts
createSearchSync({ collection, index, transform, name: 'articles-search' });
```

Give a name when two syncs would otherwise share the default one — and keep it
stable, because changing it loses the recorded point and the next `start`
reindexes.

## Starting

### `Search sync "articles:articles" failed starting: The $changeStream stage is only supported on replica sets`

Code `FAILED`; the `cause` is the driver's `MongoServerError`, code 40573. The
same server message comes out of a first `reindex()` as
`… failed reindexing: …`, since a reindex takes the stream's position first.

**When:** `start()` or `reindex()`, against a standalone `mongod`.

**Why:** the sync follows the collection with a change stream, and MongoDB
serves change streams on a replica set or a sharded cluster only.

**Fix:** run a replica set — a single node is enough, and is what this
package's own specs use:

```sh
mongod --replSet rs0 --dbpath ./data   # then, once: rs.initiate()
```

### `Search sync "articles:articles" failed reindexing: not authorized on app to execute command { aggregate: "articles", pipeline: [ { $changeStream: {} } ], … }`

The same shape appears for the state collection:
`… not authorized on app to execute command { update: "nxgt_search_sync", … }`.

**When:** `reindex()` or `start()`, against a server with authentication.

**Why:** a sync needs more than `find`. The MongoDB user needs `find` **and**
`changeStream` on the collection, and `find`, `insert`, `update` and `delete`
on the state collection (`nxgt_search_sync` by default).

**Fix:** grant them, and name the state collection if it lives elsewhere:

```ts
createSearchSync({ collection, index, transform, stateCollection: 'search_state' });
```

The Meilisearch key needs `documents.add`, `documents.get`, `documents.delete`
and `tasks.get`, plus `indexes.create` unless the index already exists.

### `Search sync "articles:articles" was last at a point the server's change history no longer reaches. Reindex it, or start it with onHistoryLost: 'reindex'.`

Code `HISTORY_LOST`; the `cause` carries the server's code, 286 or 280.

**When:** `start()`, on a sync that was stopped for longer than the server's
oplog covers.

**Why:** the resume point is a token into the oplog. Once the oplog has rolled
past it, MongoDB cannot say what happened in between, so following from there
would silently miss changes.

**Fix:** let it reindex, which is the default:

```ts
createSearchSync({ collection, index, transform, onHistoryLost: 'reindex' });
```

Keep `'fail'` where a reindex is too expensive to run unattended — then
`reindex()` it yourself when the alert comes in.

### `Search sync "articles:articles" is already following changes in this process: close it before you start it twice.`

Code `RUNNING`. `reindex()` on a sync that is following ends
`… before you reindex.`

**When:** a second `start()`, or a `reindex()`, on a sync object that is
already following.

**Why:** a reindex removes what the index holds and the collection no longer
gives it — including the documents the running follower has just indexed, which
it will never send again. The refusal covers one process only: there is **no
lock**, so two processes following one name is yours to prevent.

**Fix:**

```ts
const running = await articleSearch.start();
// …
await running.close();              // then reindex, or start again
await articleSearch.reindex();
```

## The transform

### `Search sync "articles:articles": transform gave "id" "other" for the document …, whose index id is …`

The message ends: *A document under another id could never be taken out of the
index again.* Code `ID_MISMATCH`.

**When:** `reindex()`, or a change the follower handles.

**Why:** the index document's primary key has to be the id this sync derives
from the Mongo `_id` — `String(_id)` by default, or whatever `toIndexId`
returns. Under any other id, a later delete would look for a document that is
not there and leave the wrong one in the index for good.

**Fix:** build the key from the document's own `_id`:

```ts
transform: (article) => ({ id: String(article._id), title: article.title });
```

With a non-string primary key, give `toIndexId` and use the same value:

```ts
createSearchSync({
	collection,
	index,                                  // primaryKey: 'n', a number
	toIndexId: (id) => Number(String(id).slice(0, 8)),
	transform: (article) => ({ n: Number(String(article._id).slice(0, 8)), title: article.title }),
});
```

### `transform must return a document or null, not nope`

Reaches the caller wrapped: `Search sync "articles:articles" failed
reindexing: transform must return a document or null, not nope`.

**When:** `reindex()`, or a change the follower handles.

**Why:** the transform gave something that is not a plain object and is not
`null` — a string, a number, an array, or an implicit `undefined` from a branch
that returns nothing.

**Fix:** return `null` for a document that should stay out of the index, and
make every branch return:

```ts
transform: (article) => (article.draft ? null : { id: String(article._id), title: article.title });
```

`null` also **removes** a document that was in the index, which is how a soft
delete or an unpublish reaches search.

### `Search sync "articles:articles" failed following changes: boom`

Code `FAILED`; the `cause` is the error your transform threw, and `boom` is its
message.

**When:** while following, as soon as a change reaches a transform that throws.
`closed` rejects with it, `flush()` and `close()` reject with the same error,
and nothing past that change is recorded.

**Why:** the sync cannot skip a document it could not build: the next `start`
resumes from the last recorded point, so the same change arrives again and
stops it again.

**Fix:** keep the transform total — catch what you can, and return `null` for a
document you cannot index:

```ts
transform: (article) => {
	try {
		return { id: String(article._id), title: render(article.body) };
	} catch {
		return null;            // out of the index rather than stopping the sync
	}
};
```

And take the rejection, whatever you do with it: a rejected `closed` that
nobody handles ends the process.

```ts
running.closed.catch((error) => log.error(error));
```

## Sending

### `Search sync "articles:articles" failed sending changes: Task 3 (documentAdditionOrUpdate) on index "articles" failed: Document identifier … is invalid`

Meilisearch's own text follows: *A document identifier can be of type integer
or string, only composed of alphanumeric characters (a-z A-Z 0-9), hyphens (-)
and underscores (\_), and can not be more than 511 bytes.* Code `FAILED`; the
`cause` is `@nxgt/meilisearch`'s `SearchIndexError`, carrying the failed task.

**When:** a batch is sent — on `reindex()`, on a `flush()`, or from the
follower's own timer, in which case it surfaces on `closed`.

**Why:** Meilisearch has its own rules for ids, and the whole batch fails if
one document breaks them. An `ObjectId`'s 24-character hex string is fine; a
slug, an email or anything built with a space is not.

**Fix:** derive the index id from the `_id` and nothing else:

```ts
createSearchSync({
	collection,
	index,
	toIndexId: (id) => String(id),      // the default
	transform: (article) => ({ id: String(article._id), title: article.title }),
});
```

A failed batch is not skipped: fix the transform and reindex, or the same
change stops the sync again.

## Stopping

### The sync stops and `closed` resolves with `'invalidated'`

Not an error: `closed` **resolves**, and the index is left as it was.

**When:** the collection is dropped or renamed under a running sync.

**Why:** MongoDB invalidates the change stream, and the point it stopped at
belongs to a collection that no longer exists. The recorded point is forgotten,
so the next `start()` reindexes from scratch rather than resuming into nothing.

**Fix:** watch `closed` for the reason, not only for a rejection — a dropped
collection is silent if you only handle failures:

```ts
const running = await articleSearch.start();
running.closed.then(
	(reason) => { if (reason === 'invalidated') log.warn('collection dropped'); },
	(error) => log.error(error),
);
```

Whatever the collection holds after it is recreated is indexed by the reindex
the next `start()` runs.
