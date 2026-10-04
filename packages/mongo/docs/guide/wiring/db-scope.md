# The `db` scope

`openMongo` opens what the [configuration](configuration.md) describes and
gives back a `Mongo`, whose `db` is the driver's `Db` with every collection
typed on it.

```ts
import { defineMongo, openMongo } from '@nxgt/mongo';
import * as collections from './models';

await using mongo = await openMongo(
	defineMongo({ uri: process.env.MONGO_URI!, collections }),
);

const user = await mongo.db.users.create({ email: 'ada@example.com' });
const posts = await mongo.db.posts.findMany({ filter: { authorId: user._id } });
await mongo.db.command({ ping: 1 }); // the driver's Db, untouched
```

`mongo.db.users` is exactly what `getCollection(db, users)` gives — the
driver's `Collection` with `@nxgt/mongo`'s pagination, soft delete,
optimistic locking and stamps on it — so everything that package documents
about a collection holds here.

A database configured with `buckets` has them on the same scope, beside the
collections: `mongo.db.avatars` is the `TypedBucket` `@nxgt/mongo/gridfs`'s
`getFiles` gives, in the Mongo's session. [Files](files.md) covers them.

## What the Mongo holds

| Member | Type | Effect |
| --- | --- | --- |
| `db` | `SoleScope<C>` | The only database's scope. `never` when the Mongo has several, and reading it anyway throws |
| `databases` | `{ [name]: DbScope }` | Every scope, under the name the config gave it — `default` when it named none |
| `clients` | `{ [name]: MongoClient }` | The client of each database. Two databases on one URI share one |
| `actor` | `MongoActor<C> \| undefined` | What this Mongo stamps into the `*By` fields |
| `session` | `ClientSession \| undefined` | The session every collection and bucket of this Mongo runs in |
| `as(actor)` | `Mongo<C>` | [Another Mongo, stamping that actor](actor-and-transactions.md) |
| `withSession(session)` | `Mongo<C>` | [Another Mongo, in that session](actor-and-transactions.md) |
| `transaction(fn, options?)` | `Promise<T>` | [`fn` with a Mongo in a transaction](actor-and-transactions.md) |
| `sync(options?)` | `Promise<Record<DbName<C>, SyncReport[]>>` | [A deployment step](sync.md), for the collections |
| `syncBuckets()` | `Promise<BucketSyncReport<C>>` | [The buckets' indexes](files.md#indexes-syncbuckets), per database and bucket key |
| `close()` | `Promise<void>` | Gives back what the Mongo opened. Idempotent |

A Mongo is `AsyncDisposable`, so `await using mongo = await openMongo(config)`
closes it at the end of the block.

## The scope is a `Db` underneath

The collections — and the buckets, when the database wires any — are own
properties; everything else is read through to the driver's `Db`:

```ts
Object.keys(mongo.db);            // ['users', 'posts'] (and any buckets) — not the driver's members
'users' in mongo.db;              // true
'command' in mongo.db;            // true

const { command } = mongo.db;     // a driver method read off it is bound
await command({ ping: 1 });
mongo.db.databaseName;            // 'app'
```

A collection is built the **first time it is read**, and kept:

```ts
mongo.db.users === mongo.db.users;  // true
```

So a Mongo derived per request pays for the collections that request touches
and for no others.

## Several databases

```ts
await mongo.databases.main.users.create({ email: 'ada@example.com' });
await mongo.databases.analytics.events.create({ kind: 'signup' });
mongo.clients.main === mongo.clients.analytics; // true when one URI wires both
```

`mongo.db` is then `never`, and reading it anyway — from JavaScript, or across
an `any` — throws a [`WiringError`](../errors.md) with
`code: 'SEVERAL_DATABASES'`, naming the databases to read instead: with two
of them there is no "the" database.

## Closing

```ts
await mongo.close();
```

It gives back the clients it opened, and leaves alone a `client` the config
handed it: what it did not open is not its to close, `await using` included.
Only the Mongo `openMongo` returned may be closed — one from `as`,
`withSession` or a transaction shares those clients and throws.

## In a request

A Mongo is built once, at startup, and each request derives its own. Nothing
else has to be wired: no `getCollection` at the call site, no client passed
around.

```ts
// src/services/users.service.ts
import type { AppMongo } from '../db';

export class UserService {
	constructor(private readonly mongo: AppMongo) {}

	list(page?: number) {
		return this.mongo.db.users.paginate({ page });
	}

	create(input: { email: string }) {
		return this.mongo.db.users.create(input);
	}
}
```

```ts
// src/middlewares/services.ts
import { tryObjectId } from '@nxgt/mongo';
import { createMiddleware } from 'hono/factory';
import type { AppMongo } from '../db';
import { UserService } from '../services/users.service';

export const provideServices = (mongo: AppMongo) =>
	createMiddleware(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		// One Mongo per request, stamping that user; the Mongo it came from is
		// untouched, so a request's actor never leaks into the next.
		c.set('services', { users: new UserService(mongo.as(actor)) });
		await next();
	});
```

```ts
// src/index.ts
import { openMongo } from '@nxgt/mongo';
import { buildApp } from './app';
import { config } from './db';

const mongo = await openMongo(config);
Bun.serve({ fetch: buildApp(mongo).fetch });
```

A handler reads `c.get('services')` and never reaches the Mongo itself, so it
cannot write as somebody else and cannot close it.

## Signatures

```ts
function openMongo<C>(config: MongoConfig<C>): Promise<Mongo<C>>;

type DbScope<C> = {
	readonly [K in keyof CollectionsOf<C>]: TypedCollection<CollectionsOf<C>[K]>;
} & Db;

interface Mongo<C> extends AsyncDisposable {
	readonly db: SoleScope<C>;
	readonly databases: { readonly [N in DbName<C>]: DbScope<CollectionsIn<C, N>> };
	readonly clients: { readonly [N in DbName<C>]: MongoClient };
	readonly actor: MongoActor<C> | undefined;
	readonly session: ClientSession | undefined;
	as(actor: MongoActor<C>): Mongo<C>;
	withSession(session: ClientSession | undefined): Mongo<C>;
	transaction<T>(
		fn: (mongo: Mongo<C>) => Promise<T>,
		options?: MongoTransactionOptions<C>,
	): Promise<T>;
	sync(options?: SyncOptions): Promise<Record<DbName<C>, SyncReport[]>>;
	close(): Promise<void>;
}
```

## Next

- [The actor, sessions and transactions](actor-and-transactions.md).
- [Syncing](sync.md).
