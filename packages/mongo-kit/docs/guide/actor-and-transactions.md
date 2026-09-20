# The actor, sessions and transactions

Who a write is stamped as, and which writes commit together. Both are kits of
their own: `as`, `withSession` and `transaction` give back **another kit**
over the same clients, and leave the one they came from alone.

```ts
import { ObjectId } from 'mongodb';
import { kit } from './db'; // the kit `createKit` returned

const actor = new ObjectId();

const post = await kit.as(actor).db.posts.create({ title: 'a' });
post.createdBy; // the actor

const plain = await kit.db.posts.create({ title: 'b' });
plain.createdBy; // null — the kit it came from never changed
```

## `as(actor)`

One call stamps every collection of the kit: `createdBy` on a create,
`updatedBy` on an update, `deletedBy` on a soft delete — whichever stamps the
definition asked for.

```ts
const writer = kit.as(actor);
await writer.db.users.create({ email: 'ada@example.com' }); // createdBy
await writer.db.posts.create({ title: 'a' });               // createdBy
writer.actor;                    // the actor
writer.clients.default === kit.clients.default; // the same client
writer.db.users !== kit.db.users;               // its own collections
```

The actor's **type** is the one the collections agree on: a kit whose
collections all stamp an `ObjectId` takes an `ObjectId`. A kit whose
collections stamp no actor has no `as` to call — its type is `never` — and so
does one whose collections stamp actors of different types, since a single
call could not stamp both.

```ts
type KitActor<C>; // the intersection of every wired definition's ActorOf
```

## `withSession(session)`

The kit's collections all run in that session; `undefined` takes it away
again.

```ts
const session = kit.clients.default.startSession();
try {
	const inSession = kit.withSession(session);
	await inSession.db.users.create({ email: 'ada@example.com' });
	inSession.withSession(undefined).session; // undefined
} finally {
	await session.endSession();
}
```

`as` and `withSession` compose, in either order, and each keeps what the
other set.

## `transaction(fn, options?)`

The body is given a kit whose collections are **all** in the transaction:
nothing has to be threaded through.

```ts
const written = await kit.as(actor).transaction(async (tx) => {
	const team = await tx.db.teams.create({ name: 'Core' });
	await tx.db.users.update(userId, { teamId: team._id });
	return team;
});
```

If the body throws, everything it wrote is rolled back and the error comes
back out:

```ts
await kit.transaction(async (tx) => {
	await tx.db.users.create({ email: 'ada@example.com' });
	throw new Error('no');
});
// rejects with 'no'; the user is not there
await kit.db.users.count(); // 0
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `on` | `DbName<C>` | the only client | Which database's client carries the transaction. Required once the kit holds more than one **client** |
| `readConcern`, `writeConcern`, `readPreference`, `maxCommitTimeMS` | the driver's `TransactionOptions` | the client's | Passed to the driver as they are |

```ts
await kit.transaction(
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
await kit.transaction(async (outer) => {
	await outer.db.users.create({ email: 'ada@example.com' });
	await outer.transaction(async (inner) => {
		inner.session === outer.session; // true: it joined
		await inner.db.posts.create({ title: 'a' });
	});
});
```

`{ on }` is required at **run time**, not by the types, and cannot be: two
databases on one URI share a client and need none, so what decides is the
number of clients. A kit holding two without it throws a `TypeError` naming
what to write.

## In a request

The kit is built once; each request derives the kit that stamps its user, and
a handler is handed services built on it rather than the kit itself.

```ts
import { tryObjectId } from '@nxgt/mongo';
import { createMiddleware } from 'hono/factory';
import type { Kit } from '../db';
import { buildServices } from '../context';

export const provideServices = (kit: Kit) =>
	createMiddleware(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		c.set('services', buildServices(kit.as(actor)));
		await next();
	});
```

```ts
export class TeamService {
	constructor(private readonly kit: Kit) {}

	/** Two collections, one commit — and both writes stamped with the request's user. */
	createWithOwner(name: string, ownerId: ObjectId) {
		return this.kit.transaction(async (tx) => {
			const team = await tx.db.teams.create({ name });
			await tx.db.users.update(ownerId, { teamId: team._id });
			return team;
		});
	}
}
```

The service holds the request's kit, so `this.kit.transaction` already stamps
the right actor: the transaction inherits it.

## Closing a derived kit

`close()` on a kit from `as`, `withSession` or a transaction throws — the
clients belong to the kit `createKit` returned, and that is the one to close.

## Signatures

```ts
type KitActor<C> = [ActorOf<WiredDefinition<C>>] extends [never]
	? never
	: UnionToIntersection<ActorOf<WiredDefinition<C>>>;

type KitTransactionOptions<C> = TransactionOptions & { on?: DbName<C> };

interface MongoKit<C> {
	as(actor: KitActor<C>): MongoKit<C>;
	withSession(session: ClientSession | undefined): MongoKit<C>;
	transaction<T>(
		fn: (kit: MongoKit<C>) => Promise<T>,
		options?: KitTransactionOptions<C>,
	): Promise<T>;
}
```

## Next

- [The `db` scope](db-scope.md) — what a derived kit shares, and what it
  builds again.
- [Troubleshooting](../troubleshooting.md) — the messages these refusals use.
