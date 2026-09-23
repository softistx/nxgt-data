# Troubleshooting

Every heading is the text the error prints, so the page can be searched with
what you have in front of you. Stacks, ids and paths are cut, and a sync's
name is written as it comes out by default — `<collection>:<index uid>`, here
`articles:articles`.

Everything this package throws is a `SearchSyncError` carrying a `code`
(`HISTORY_LOST`, `ID_MISMATCH`, `NOT_A_DOCUMENT`, `RUNNING`, `LEASE_LOST`,
`FAILED`), the
sync's `name`, and the original error as `cause` — except the options, which
are refused with a `TypeError` before anything is opened.

| Area | Entries |
| --- | --- |
| [Install](#install) | [ERESOLVE](#npm-error-eresolve-unable-to-resolve-dependency-tree) · [incorrect peer dependency](#warn-incorrect-peer-dependency-nxgtmongo0140) · [TS2307](#error-ts2307-cannot-find-module-nxgtmongo-or-its-corresponding-type-declarations) |
| [Options](#options) | [transform](#createsearchsync-transform-must-be-a-function) · [batchSize](#createsearchsync-batchsize-must-be-a-whole-number-above-0-not-0) · [flushIntervalMs](#createsearchsync-flushintervalms-must-be-a-whole-number-of-milliseconds-not--1) · [name](#createsearchsync-name-must-not-be-empty) |
| [Starting](#starting) | [no replica set](#search-sync-articlesarticles-failed-starting-the-changestream-stage-is-only-supported-on-replica-sets) · [privileges](#search-sync-articlesarticles-failed-reindexing-not-authorized-on-app-to-execute-command--aggregate-articles-pipeline---changestream-----) · [history lost](#search-sync-articlesarticles-was-last-at-a-point-the-servers-change-history-no-longer-reaches-reindex-it-or-start-it-with-onhistorylost-reindex) · [already running](#search-sync-articlesarticles-is-already-following-changes-in-this-process-close-it-before-you-start-it-twice) · [held by another process](#search-sync-articlesarticles-is-held-by--until--wait-for-it-to-close-or-for-its-lease-to-lapse-before-you-start-it) · [the lease cannot be taken](#search-sync-articlesarticles-failed-taking-its-lease-) · [the lease cannot be checked](#search-sync-articlesarticles-failed-checking-its-lease-) · [the lease lost while reindexing](#search-sync-articlesarticles-lost-its-lease-another-process-holds-the-name-now-or-the-lease-was-removed-it-lapses-when-not-renewed-within-30000-ms-it-stopped-rather-than-run-beside-it) |
| [The transform](#the-transform) | [an id that is not the index's](#search-sync-articlesarticles-transform-gave-id-other-for-the-document--whose-index-id-is-) · [not a document](#search-sync-articlesarticles-transform-gave-a-string-for-the-document-) · [it threw](#search-sync-articlesarticles-failed-following-changes-boom) |
| [Sending](#sending) | [an id Meilisearch refuses](#search-sync-articlesarticles-failed-sending-changes-task-3-add-on-index-articles-failed-invalid_document_id) |
| [Stopping](#stopping) | [lease lost](#search-sync-articlesarticles-lost-its-lease-another-process-holds-the-name-now-or-the-lease-was-removed-it-lapses-when-not-renewed-within-30000-ms-it-stopped-rather-than-run-beside-it) · [a dropped collection](#the-sync-stops-and-closed-resolves-with-invalidated) |

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

The same refusal covers `positionIntervalMs`, `pageSize` and `leaseMs`.

**When:** calling `createSearchSync`.

**Why:** those four count documents or milliseconds, and `0`, a fraction,
`NaN` and a negative number have no meaning for any of them. A value read from
the environment is a string until it is parsed, and `Number('')` is `0`.

**Fix:**

```ts
createSearchSync({ collection, index, transform, batchSize: 500 }); // the default
```

### `createSearchSync: flushIntervalMs must be a whole number of milliseconds, not -1`

**When:** calling `createSearchSync`.

**Why:** `flushIntervalMs` is the one option that accepts `0` — send every
change as it comes — so it is checked apart from the four above. A negative
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

For the state collection, the refusal comes first, from the lease:
[`… failed taking its lease: …`](#search-sync-articlesarticles-failed-taking-its-lease-).

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
it will never send again. This check is the sync object's own and comes first;
another process, or a second `createSearchSync` with the same name, is refused
by the lease on the name instead, with
[`… is held by …`](#search-sync-articlesarticles-is-held-by--until--wait-for-it-to-close-or-for-its-lease-to-lapse-before-you-start-it).

**Fix:**

```ts
const running = await articleSearch.start();
// …
await running.close();              // then reindex, or start again
await articleSearch.reindex();
```

### `Search sync "articles:articles" is held by … until …: wait for it to close, or for its lease to lapse, before you start it.`

Code `RUNNING`. The holder is written `<host>:<pid>:<24 hex digits>`, and the
date is ISO, in UTC. A `reindex()` ends `… before you reindex.`

**When:** `start()` or `reindex()`, while another process — or another sync
object in this one — follows or reindexes the same name. Also after a process
that held it died without closing: its lease still runs until `leaseMs`
(default `30000`) after its last renewal.

**Why:** a running sync, and a reindex, hold a lease on the sync's name — one
document in the state collection, renewed every third of `leaseMs`. Two
followers on one name would each send and record beside the other, and a
reindex would remove what the follower had just sent. Expiry is decided on the
MongoDB server's clock, so hosts whose clocks disagree still agree on it.

**Fix:** run one follower per name. A second replica can stand by, retrying
`start()` until the name is free — on `RUNNING`, and on `LEASE_LOST`, which a
`start()` whose first reindex lost the name to another process rejects with:

```ts
import { type RunningSearchSync, SearchSyncError } from '@nxgt/mongo-meilisearch';

// The name is held elsewhere, or was taken over while this start reindexed.
const heldElsewhere = (error: unknown) =>
	error instanceof SearchSyncError &&
	(error.code === 'RUNNING' || error.code === 'LEASE_LOST');

async function follow(): Promise<RunningSearchSync> {
	for (;;) {
		try {
			return await articleSearch.start();
		} catch (error) {
			if (!heldElsewhere(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
	}
}
```

Close the sync on shutdown (`await running.close()` on `SIGTERM`): that lets go
of the name at once, where a killed process leaves it held until its lease
lapses. To see who holds it, read `{ _id: { lease: 'articles:articles' } }` in
the state collection (`nxgt_search_sync` by default). Do not delete a live
holder's lease by hand: its next renewal finds it gone and it stops with
[`LEASE_LOST`](#search-sync-articlesarticles-lost-its-lease-another-process-holds-the-name-now-or-the-lease-was-removed-it-lapses-when-not-renewed-within-30000-ms-it-stopped-rather-than-run-beside-it).

### `Search sync "articles:articles" failed taking its lease: …`

Code `FAILED`; the `cause` is the driver's error, and its message follows the
colon — for example
`not authorized on app to execute command { findAndModify: "nxgt_search_sync", … }`.

**When:** `start()` or `reindex()`, before anything else is read or sent.

**Why:** the lease lives in the state collection, beside the resume point, and
taking it is one atomic upsert. The MongoDB user needs `find`, `insert` and
`update` on that collection to take it, and `delete` to let go of it — or the
server is not reachable at all.

**Fix:** grant those four on the state collection, and name it if it lives
elsewhere:

```ts
createSearchSync({ collection, index, transform, stateCollection: 'search_state' });
```

### `Search sync "articles:articles" failed checking its lease: …`

Code `FAILED`; the `cause` is the driver's error.

**When:** a reindex — `reindex()`, or the one `start()` runs first — just
before it removes what the index should no longer hold, just before it records
its resume point, or `start()` just before it opens the follower.

**Why:** those steps would undo what another holder did, so each asks the
server first that the lease is still this sync's. A check that does not reach
MongoDB is not tried again later, as a timed renewal is: the reindex stops
there. The pages it already sent stay in the index; nothing was removed or
recorded after the failed check.

**Fix:** it is the server or the network, not the lease. Run the reindex again
once MongoDB answers; the next one starts over.

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

### `Search sync "articles:articles": transform gave a string for the document …`

The document's `_id` closes the first sentence, and the message goes on: *It
must give a document to index, or null to keep it out.* Code
`NOT_A_DOCUMENT`, with the sync's `name` on it. An array is reported as
`an array`, and a branch that returns nothing as `undefined`.

**When:** `reindex()`, or a change the follower handles.

**Why:** the transform gave something that is not a plain object and is not
`null` — a string, a number, an array, or an implicit `undefined` from a branch
that returns nothing. It reports the **shape** of what came back and never its
value: a transform is handed whole documents, and what it gives back can hold
anything they held. The code is its own since 0.2.0: it used to be a bare
`TypeError` that came back wrapped as `FAILED` — the code that means "anything
else" — so it could not be told from a Meilisearch outage without reading the
sentence.

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

### `Search sync "articles:articles" failed sending changes: Task 3 (add) on index "articles" failed: invalid_document_id`

Code `FAILED`; the `cause` is `@nxgt/meilisearch`'s `SearchIndexError`,
carrying the failed task, and Meilisearch's own sentence is one level
further, on `error.cause.cause.message`: *Document identifier `"…"` is
invalid. A document identifier can be of type integer or string, only
composed of alphanumeric characters (a-z A-Z 0-9), hyphens (-) and
underscores (\_), and can not be more than 511 bytes.* It quotes the id, so
the message leaves it out; before `@nxgt/meilisearch` 0.4.1 the line ended
with `Task 3 (documentAdditionOrUpdate) … failed: ` and that sentence.
Match on `code` and on `error.cause.task.error.code`, never on the text.

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

### `Search sync "articles:articles" lost its lease: another process holds the name now, or the lease was removed (it lapses when not renewed within 30000 ms). It stopped rather than run beside it.`

Code `LEASE_LOST`; the number is the sync's `leaseMs`. `closed` rejects with
it, and so do `reindex()` and `start()`.

**When:** the lease on the name is no longer this process's — the process
could not renew it for a whole `leaseMs` (an event loop blocked by synchronous
work, a long GC pause, MongoDB unreachable for longer than that) and another
process took the name in between, or the lease document was deleted by hand.
It is found:

- **while following** — at a renewal. `closed` rejects, and nothing more is
  sent or recorded; a flush already in flight still finishes.
- **while reindexing** — a standalone `reindex()`, or `start()` during its
  first reindex or the one after a lost history. A renewal that found it lost
  stops the reindex after the page it just sent; the server is also asked
  before documents are removed, again before the resume point is recorded,
  and, for `start()`, before the follower opens. The call rejects **having
  recorded nothing**, and having removed nothing unless the lease went while
  the removal itself ran. The pages already sent stay in the index.

**Why:** another follower may be running on the same name. Carrying on would
send, remove and record beside it, so the sync stops, and leaves the new
holder's lease alone.

**Fix:** give `leaseMs` room above the longest pause you expect, and start
again when it happens — `start()` waits its turn with `RUNNING` while the new
holder runs. A reindex that stopped this way is run again once the name is
free:

```ts
import { createSearchSync, SearchSyncError } from '@nxgt/mongo-meilisearch';

declare function follow(): Promise<void>; // the standby loop, below

const search = createSearchSync({ collection, index, transform, leaseMs: 120_000 });
const running = await search.start();

running.closed.catch((error) => {
	if (error instanceof SearchSyncError && error.code === 'LEASE_LOST') return follow();
	log.error(error);
});
```

`follow()` is the standby loop from
[`… is held by …`](#search-sync-articlesarticles-is-held-by--until--wait-for-it-to-close-or-for-its-lease-to-lapse-before-you-start-it).
A larger `leaseMs` also means a process that dies holds the name that much
longer.

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
