# Change subscriptions

`onChange` listens to a collection's changes, typed by its schema and in this
package's words: a soft delete is a `delete`, not an update that set a date.

```ts
import { getCollection } from '@nxgt/mongo';
import { users } from './collections';

const collection = getCollection(db, users);

const subscription = collection.onChange(async (change) => {
	switch (change.type) {
		case 'create':  await welcome(change.document.email); break;
		case 'update':  await reindex(change.document);       break;
		case 'delete':  await forget(change.id, change.hard); break;
		case 'restore': await reindex(change.document);       break;
	}
});

await subscription.ready;    // a change made from here on is heard
// …
await subscription.close();  // or `await using subscription = …`
```

Change streams need a replica set: a standalone `mongod` refuses them. A
single-node one is enough.

## What a change carries

| Change | Carries |
| --- | --- |
| `create` | `document` |
| `update` | `document` (`undefined` if deleted since), `before`, `fields: { set, removed }` — `undefined` for a replacement |
| `delete` | `hard`, `document` after a soft delete, `before` |
| `restore` | `document`, `before` — only on a collection that soft deletes |

Every change also has `id`, `at` and `resumeToken`. The document is a read
document, so it carries `id` like any other.

```ts
collection.onChange((change) => {
	if (change.type === 'update' && change.fields?.set.email) {
		// exactly the fields this update wrote
	}
});
```

## The options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `events` | `ChangeType[]` | all of them | which changes to hear about; the server is asked for the matching operations only |
| `filter` | `FilterOf<Def>` | — | only changes to documents that match, checked against the document after the change |
| `withDeleted` | `boolean` | `false` | hear updates to soft-deleted documents too |
| `startAfter` | `ResumeToken` | now | start just after a token, rather than now |
| `onError` | `(error, change?) => unknown` | — | what to do with an error, instead of closing |
| `retries` | `number` | `5` | reopens in a row after an error the driver did not recover from, with a delay doubling from 100 ms to 10 s |

```ts
const subscription = collection.onChange(handler, {
	events: ['create', 'delete'],
	filter: { teamId },
	retries: 10,
	onError: (error, change) => log.error({ error, id: change?.id }),
});
```

`filter` takes field conditions, `$and`, `$or` and `$nor`; any other
top-level operator is refused, since it would read the event rather than the
document.

## How it behaves

- **One change at a time.** The next is handed over once the handler's
  promise settles, so the order is the server's.
- **The document is the one after the change** when the collection keeps
  post-images, and the document **as it is now** otherwise — a later write
  may already be in it. `before` is there only with pre-images.

  ```ts
  defineCollection({
  	name: 'users',
  	schema,
  	options: { changeStreamPreAndPostImages: { enabled: true } },
  });
  ```

- **Updates to soft-deleted documents are left out**, like every read, unless
  `withDeleted: true`. The soft delete and the restore always come through.
- **It keeps going.** The driver resumes on its own after a dropped
  connection; when it gives up, the stream is reopened from the last token it
  held, up to `retries` times in a row. A history the server no longer has,
  or a user who may not read, is not retried.
- **Errors.** A handler that throws, or a stream that fails for good, goes to
  `onError`, and the stream goes on after a handler's error. Without
  `onError`, the first error closes the subscription and rejects `closed` —
  which, like an `error` event nobody listens to, ends the process when
  nothing awaits it.
- A dropped or renamed collection ends the subscription: `closed` resolves
  with `'invalidated'`.

## Picking up where it was

A restarted process starts from now. Keep a token somewhere durable and pass
it back as `startAfter`:

```ts
import type { ResumeToken } from '@nxgt/mongo';

const positions = db.collection<{ _id: string; token: ResumeToken }>('positions');
const saved = await positions.findOne({ _id: 'users' });

const subscription = collection.onChange(
	async (change) => {
		await handle(change);
		await positions.updateOne(
			{ _id: 'users' },
			{ $set: { token: change.resumeToken } },
			{ upsert: true },
		);
	},
	{ startAfter: saved?.token },
);
```

`ResumeToken` is branded, so an id is not taken for one; a token read back
from storage is `saved as ResumeToken`. A token the server refuses fails at
once rather than being retried.

**`position` moves while the collection is quiet, and `resumeToken` does
not.** `resumeToken` is the last change handled; `position` is that, or,
after a read that brought nothing, the point the server gave — every change
up to it has been handled either way. A worker that records `position` every
so often is not sent back to the start of a long silence by a history the
server has since dropped.

```ts
setInterval(() => {
	if (subscription.position) save(subscription.position);
}, 10_000);
```

## A worker, from start to shutdown

```ts
import { closeMongo, connectMongo, getCollection } from '@nxgt/mongo';
import { users } from './collections';

const mongo = await connectMongo(process.env.MONGO_URL);
const collection = getCollection(mongo.db, users);

const subscription = collection.onChange(
	(change) => index(change.type, change.document),
	{ onError: (error) => log.error(error) },
);
await subscription.ready;

process.on('SIGTERM', async () => {
	await subscription.close();   // a change being handled is finished first
	await closeMongo();
});

const reason = await subscription.closed;   // 'closed' | 'invalidated' | 'failed'
```

## Without pre- and post-images

Three behaviours follow from a collection that keeps none, and each of them
surprises someone:

- **An update's `document` is today's.** It is looked up when the change is
  read, so two quick updates can both arrive with the second one's document,
  and an update read after its document was hard deleted arrives with
  `document: undefined` — a subscription only a little behind is enough.
- **A hard delete is not filtered.** It carries no document to match, so a
  subscription with a `filter` still hears every hard delete. Ignore the ids
  you never saw, or enable pre-images.
- **A soft delete is read from the event alone.** An update that sets the
  stamp is a `delete`, even on a document that was already deleted; one that
  clears it is a `restore`, even on one that was not. Writes through this
  package never meet these cases; the driver's own methods can.

## The signatures

```ts
onChange(handler: ChangeHandler<Def>, options?: ChangeOptions<Def>): ChangeSubscription;

type ChangeHandler<Def> = (change: ChangeOf<Def>) => unknown;

interface ChangeSubscription extends AsyncDisposable {
	/** Resolves once the stream is open: a change made after it is heard. */
	readonly ready: Promise<void>;
	/** Settles when it stops, with why — or rejects when there is no `onError`. */
	readonly closed: Promise<CloseReason>;
	readonly resumeToken: ResumeToken | undefined;
	readonly position: ResumeToken | undefined;
	close(): Promise<void>;
}

type CloseReason = 'closed' | 'invalidated' | 'failed';
```

`collection.watch()` is the driver's own change stream, untouched, for what
this does not cover.

## Next

- [Collections](collections.md) — turning pre- and post-images on.
- [Documents](documents.md) — the writes a subscription hears about.
