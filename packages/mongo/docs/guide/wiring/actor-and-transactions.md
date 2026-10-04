# The actor, sessions and transactions

Who a write is stamped as, and which writes commit together. `as`, `withSession` and `transaction` each give back **another Mongo** over the
same clients, and leave the one they came from alone.

```ts
import { ObjectId } from 'mongodb';
import { mongo } from './db'; // the Mongo `openMongo` returned

const actor = new ObjectId();

const post = await mongo.as(actor).db.posts.create({ title: 'a' });
post.createdBy; // the actor

const plain = await mongo.db.posts.create({ title: 'b' });
plain.createdBy; // null — the Mongo it came from never changed
```

## `as(actor)`

One call stamps every collection of the Mongo: `createdBy` on a create,
`updatedBy` on an update, `deletedBy` on a soft delete — whichever stamps the
definition asked for.

```ts
const writer = mongo.as(actor);
await writer.db.users.create({ email: 'ada@example.com' }); // createdBy
await writer.db.posts.create({ title: 'a' });               // createdBy
writer.actor;                    // the actor
writer.clients.default === mongo.clients.default; // the same client
writer.db.users !== mongo.db.users;               // its own collections
```

The actor's **type** is the one the collections agree on: a Mongo whose
collections all stamp an `ObjectId` takes an `ObjectId`. A Mongo whose
collections stamp no actor has no `as` to call — its type is `never` — and so
does one whose collections stamp actors of different types, since a single
call could not stamp both.

```ts
type MongoActor<C>; // the intersection of every wired definition's ActorOf
```

## `withSession(session)`

The Mongo's collections all run in that session; `undefined` takes it away
again.

```ts
const session = mongo.clients.default.startSession();
try {
	const inSession = mongo.withSession(session);
	await inSession.db.users.create({ email: 'ada@example.com' });
	inSession.withSession(undefined).session; // undefined
} finally {
	await session.endSession();
}
```

`as` and `withSession` compose, in either order, and each keeps what the
other set.

## `transaction(fn, options?)`

The body is given a Mongo whose collections — and [buckets](files.md#in-a-transaction),
when the config wires some — are **all** in the transaction: nothing has to
be threaded through, and a file written there commits or rolls back with the
documents beside it.

```ts
const written = await mongo.as(actor).transaction(async (tx) => {
	const team = await tx.db.teams.create({ name: 'Core' });
	await tx.db.users.update(userId, { teamId: team._id });
	return team;
});
```

If the body throws, everything it wrote is rolled back and the error comes
back out:

```ts
await mongo.transaction(async (tx) => {
	await tx.db.users.create({ email: 'ada@example.com' });
	throw new Error('no');
});
// rejects with 'no'; the user is not there
await mongo.db.users.count(); // 0
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `on` | `DbName<C>` | the only client | Which database's client carries the transaction. Required once the Mongo holds more than one **client** |
| `readConcern`, `writeConcern`, `readPreference`, `maxCommitTimeMS` | the driver's `TransactionOptions` | the client's | Passed to the driver as they are |

```ts
await mongo.transaction(
	(tx) => tx.db.users.create({ email: 'ada@example.com' }),
	{ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
);
```

### What the body must accept

- **It may run twice.** The driver retries it from the start on a transient
  error, so it must hold nothing MongoDB would not roll back — no email sent,
  no counter raised in Redis, no file written.
- **A transaction inside a transaction joins the outer one**, and takes no
  `on`: the session has already decided. MongoDB has no savepoints, so an
  inner failure takes the whole transaction with it.
- **It reaches one client's databases.** With `{ on: 'main' }`, an operation
  on a database of another client carries a session that client does not own,
  and the driver refuses it.
- **A replica set is required**, which is MongoDB's own rule for
  transactions, not this package's.

```ts
await mongo.transaction(async (outer) => {
	await outer.db.users.create({ email: 'ada@example.com' });
	await outer.transaction(async (inner) => {
		inner.session === outer.session; // true: it joined
		await inner.db.posts.create({ title: 'a' });
	});
});
```

`{ on }` is required at **run time**, not by the types, and cannot be: two
databases on one URI share a client and need none, so what decides is the
number of clients. A Mongo holding two without it throws a
[`WiringError`](../errors.md) with `code: 'TRANSACTION'`, naming what to write.

## In a request

The Mongo is built once; each request derives the Mongo that stamps its user, and
a handler is handed services built on it rather than the Mongo itself.

```ts
import { tryObjectId } from '@nxgt/mongo';
import { createMiddleware } from 'hono/factory';
import type { AppMongo } from '../db';
import { buildServices } from '../context';

export const provideServices = (mongo: AppMongo) =>
	createMiddleware(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		c.set('services', buildServices(mongo.as(actor)));
		await next();
	});
```

```ts
export class TeamService {
	constructor(private readonly mongo: AppMongo) {}

	/** Two collections, one commit — and both writes stamped with the request's user. */
	createWithOwner(name: string, ownerId: ObjectId) {
		return this.mongo.transaction(async (tx) => {
			const team = await tx.db.teams.create({ name });
			await tx.db.users.update(ownerId, { teamId: team._id });
			return team;
		});
	}
}
```

The service holds the request's mongo, so `this.mongo.transaction` already stamps
the right actor: the transaction inherits it.

## Closing a derived Mongo

`close()` on a Mongo from `as`, `withSession` or a transaction throws — the
clients belong to the Mongo `openMongo` returned, and that is the one to close.

## Signatures

```ts
type MongoActor<C> = [ActorOf<WiredDefinition<C>>] extends [never]
	? never
	: UnionToIntersection<ActorOf<WiredDefinition<C>>>;

type MongoTransactionOptions<C> = TransactionOptions & { on?: DbName<C> };

interface Mongo<C> {
	as(actor: MongoActor<C>): Mongo<C>;
	withSession(session: ClientSession | undefined): Mongo<C>;
	transaction<T>(
		fn: (mongo: Mongo<C>) => Promise<T>,
		options?: MongoTransactionOptions<C>,
	): Promise<T>;
}
```

## Next

- [The `db` scope](db-scope.md) — what a derived Mongo shares, and what it
  builds again.
- [Troubleshooting](../../troubleshooting.md) — the messages these refusals use.
