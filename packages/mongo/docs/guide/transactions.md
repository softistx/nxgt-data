# Transactions and locking

Two ways of making concurrent writes come out right: a transaction, when
several writes must stand or fall together, and optimistic locking, when two
writers race on one document.

```ts
import { getCollection, withTransaction } from '@nxgt/mongo';
import { teams, users } from './collections';

const teamsCollection = getCollection(db, teams);
const usersCollection = getCollection(db, users);

await withTransaction(client, async (session) => {
	const team = await teamsCollection.withSession(session).create({ name: 'Core' });
	await usersCollection.withSession(session).update(userId, { teamId: team._id });
});
```

`withTransaction` commits when the callback resolves, aborts when it throws,
and turns a MongoDB error into one of [this package's](errors.md) on the way
out. It needs a replica set, as every MongoDB transaction does.

## Every operation has to be given the session

MongoDB has no ambient session: a write that was not given one runs outside
the transaction and is **not** rolled back with it.
`collection.withSession(session)` is how a collection takes it, and it
returns a new collection rather than changing the one you hold.

```ts
await withTransaction(client, async (session) => {
	const scoped = usersCollection.withSession(session);
	await scoped.update(userId, { name: 'Ada' });        // in the transaction
	await usersCollection.update(otherId, { name: 'B' }); // NOT in it
});
```

A driver method on the same object — `aggregate`, `bulkWrite`,
`countDocuments` — takes its session the driver's way, in its options. The
collection's own is `collection.session`, for passing along:

```ts
await scoped.aggregate(pipeline, { session: scoped.session }).toArray();
```

A [hook](hooks.md) gets the session in its context, which is how an `after`
hook becomes part of the write:

```ts
const audited = getCollection(db, users, {
	hooks: {
		afterDelete: (user, { session, collection }) =>
			collection.db.collection('audit').insertOne({ user: user._id }, { session }),
	},
});
await withTransaction(client, (session) => audited.withSession(session).delete(userId));
```

## Joining one that is already open

Given a session already in a transaction, `withTransaction` joins it: the
callback runs with that session and nothing commits until the outer one does.
MongoDB has no savepoints, so an inner failure takes the whole transaction
down.

```ts
async function chargeAndLog(host: MongoClient | ClientSession) {
	return withTransaction(host, async (session) => {
		// …runs alone when given a client, and joins when given a session
	});
}
```

Passing transaction options to a call that joins is a `TypeError`: the read
concern, the write concern, the read preference and `retryTransient` are the
outer transaction's.

## Two things the driver does

**It retries the callback** from the start on a transient error, and the
commit alone on an unknown commit result, for up to 120 seconds — also when
the transient error came out of a collection method as a `DataError`. So the
callback must be safe to run twice, and must not swallow errors — the driver
cannot otherwise tell whether the transaction was aborted.

A failure labelled transient that **will happen again every time** — a
deterministic collision the server aborts the transaction for, such as
`putOnce` against a stray committed chunk — is retried for the whole window.
What comes back at the end is a `DataError` with the driver's error, the
abort or the write conflict, on its `cause` (the driver's timeout error when
the client was given a `timeoutMS`). Only `TransientTransactionError` is
handed back to the driver; an error without that label, a duplicate key for
one, fails at once and the callback runs once.

**`session.abortTransaction()` inside the callback resolves.**
`withTransaction` returns the callback's value; it does not throw.

## Failing fast: `retryTransient: false`

`retryTransient` (default `true`) is a per-transaction option on
`withTransaction(host, fn, options)` and on `mongo.transaction(fn, options)`.
`false` runs the callback **exactly once**, and neither a transient error from
a write nor one from the commit is retried — a raw driver error thrown through
`.raw` is not either. The first transient error comes back as a `DataError`
whose `hasErrorLabel('TransientTransactionError')` is true, for your own
bounded retry. The option never reaches the driver. It is refused, with the
other options, by a call that joins an open transaction.

### A default for the whole client

A client with many transaction sites sets the default once, in `defineMongo`,
instead of on every call:

```ts
export const config = defineMongo({
	uri: process.env.MONGO_URI!,
	collections,
	transactions: { retryTransient: false },
});
```

Every `mongo.transaction(fn)` this Mongo starts then runs once, and a Mongo
derived from it (`as`, `withSession`, the one a transaction hands to `fn`)
keeps the default. The order is **per call, then the client's default, then
`true`**: `mongo.transaction(fn, { retryTransient: true })` retries even under
a default of `false`.

A call that **joins** an open transaction takes the default of neither: it
runs in the outer transaction, whose behaviour it inherits, so the default
never makes it throw. Only a `retryTransient` written on the joined call
itself is refused, as before. Under a default of `false`, a transient failure
inside a joined body fails the outer transaction once, with no rerun.

The standalone `withTransaction(host, fn, options)` has no configuration and
keeps its own default, `true`.

```ts
async function claim(id: ObjectId) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await withTransaction(
				client,
				(session) => locks.withSession(session).update(id, { owner: me }),
				{ retryTransient: false },
			);
		} catch (error) {
			const transient =
				error instanceof DataError &&
				error.hasErrorLabel('TransientTransactionError');
			if (!transient || attempt === 5) throw error;
			await Bun.sleep(20 * attempt); // the loser backs off, rather than 120 s of reruns
		}
	}
}
```

## What may not run in one

Neither `collMod` nor an index build may run inside a transaction, so
[`sync`](sync.md), `autoSync` and a bucket's `syncIndexes` belong at
start-up, not inside `withTransaction`. A [migration](migrations.md) that
builds an index declares `transaction: false` for the same reason.

## Optimistic locking

With `optimisticLock`, every update raises the version field — an `upsert`
too, which starts an inserted document at 0 and raises a matched one by one.
Give the version you read, under the version field's own name, and the update
only applies while the document is still at it:

```ts
import { OptimisticLockError } from '@nxgt/mongo';

const user = await usersCollection.getById(id);
try {
	await usersCollection.update(id, { name: 'Ada', version: user.version });
} catch (error) {
	if (error instanceof OptimisticLockError) {
		error.expectedVersion;   // what the patch said
		error.actualVersion;     // what the document is at: someone else wrote first
	}
	throw error;
}
```

The version in a patch is **not written**: it is a condition. `{ version: 3 }`
never sets the version to 3 — it makes the update fail unless the document is
at 3, and the update then leaves it at 4.

- It must be a whole number, and it needs the lock: a collection opened with
  `optimisticLock: false` refuses one rather than ignore it — at run time
  only, since the types see the definition and not the options.
- `updateMany` takes none: one version cannot stand for many documents.
- A renamed stamp is checked under its own name — `{ revision: 3 }` on a
  collection that called it that; `version` there does not compile.

### Which one to reach for

A transaction makes several writes atomic. A version makes one write
conditional on nothing having changed underneath it — a form that was read,
edited by a person, and submitted a minute later. They compose: a write
inside a transaction can carry its expected version too.

```ts
app.patch('/users/:id', async (c) => {
	const body = await c.req.json();
	try {
		const user = await getCollection(c.env.db, users).update(c.req.param('id'), {
			name: body.name,
			version: body.version,   // what the client read
		});
		return c.json(user);
	} catch (error) {
		if (error instanceof OptimisticLockError) {
			return c.json({ error: 'changed since you read it' }, 409);
		}
		throw error;
	}
});
```

## The signature

```ts
type TransactionHost = MongoClient | ClientSession;

function withTransaction<T>(
	host: TransactionHost,
	fn: (session: ClientSession) => Promise<T>,
	options?: TransactionOptions,
): Promise<T>;
```

A [bucket](gridfs.md#it-runs-in-a-transaction) takes a session the same way:
`files.withSession(session)`, `put` included.

## Next

- [Errors](errors.md) — `OptimisticLockError`, `ConflictError` and the rest.
- [Connecting](connecting.md) — the client a transaction is started from, and
  the replica set it needs.
