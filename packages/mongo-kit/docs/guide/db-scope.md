# The `db` scope

`createKit` opens what the [configuration](configuration.md) describes and
gives back a `MongoKit`, whose `db` is the driver's `Db` with every collection
typed on it.

```ts
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import * as collections from './models';

await using kit = await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections }),
);

const user = await kit.db.users.create({ email: 'ada@example.com' });
const posts = await kit.db.posts.findMany({ filter: { authorId: user._id } });
await kit.db.command({ ping: 1 }); // the driver's Db, untouched
```

`kit.db.users` is exactly what `getCollection(db, users)` gives — the
driver's `Collection` with `@nxgt/mongo`'s pagination, soft delete,
optimistic locking and stamps on it — so everything that package documents
about a collection holds here.

## What the kit holds

| Member | Type | Effect |
| --- | --- | --- |
| `db` | `SoleScope<C>` | The only database's scope. `never` when the kit has several, and reading it anyway throws |
| `databases` | `{ [name]: DbScope }` | Every scope, under the name the config gave it — `default` when it named none |
| `clients` | `{ [name]: MongoClient }` | The client of each database. Two databases on one URI share one |
| `actor` | `KitActor<C> \| undefined` | What this kit stamps into the `*By` fields |
| `session` | `ClientSession \| undefined` | The session every collection of this kit runs in |
| `as(actor)` | `MongoKit<C>` | [Another kit, stamping that actor](actor-and-transactions.md) |
| `withSession(session)` | `MongoKit<C>` | [Another kit, in that session](actor-and-transactions.md) |
| `transaction(fn, options?)` | `Promise<T>` | [`fn` with a kit in a transaction](actor-and-transactions.md) |
| `sync(options?)` | `Promise<Record<DbName<C>, SyncReport[]>>` | [A deployment step](sync.md) |
| `close()` | `Promise<void>` | Gives back what the kit opened. Idempotent |

A kit is `AsyncDisposable`, so `await using kit = await createKit(config)`
closes it at the end of the block.

## The scope is a `Db` underneath

The collections are own properties; everything else is read through to the
driver's `Db`:

```ts
Object.keys(kit.db);            // ['users', 'posts'] — not the driver's members
'users' in kit.db;              // true
'command' in kit.db;            // true

const { command } = kit.db;     // a driver method read off it is bound
await command({ ping: 1 });
kit.db.databaseName;            // 'app'
```

A collection is built the **first time it is read**, and kept:

```ts
kit.db.users === kit.db.users;  // true
```

So a kit derived per request pays for the collections that request touches
and for no others.

## Several databases

```ts
await kit.databases.main.users.create({ email: 'ada@example.com' });
await kit.databases.analytics.events.create({ kind: 'signup' });
kit.clients.main === kit.clients.analytics; // true when one URI wires both
```

`kit.db` is then `never`, and reading it anyway — from JavaScript, or across
an `any` — throws a `TypeError` naming the databases to read instead: with
two of them there is no "the" database.

## Closing

```ts
await kit.close();
```

It gives back the clients it opened, and leaves alone a `client` the config
handed it: what it did not open is not its to close, `await using` included.
Only the kit `createKit` returned may be closed — one from `as`,
`withSession` or a transaction shares those clients and throws.

## In a request

A kit is built once, at startup, and each request derives its own. Nothing
else has to be wired: no `getCollection` at the call site, no client passed
around.

```ts
// src/services/users.service.ts
import type { Kit } from '../db';

export class UserService {
	constructor(private readonly kit: Kit) {}

	list(page?: number) {
		return this.kit.db.users.paginate({ page });
	}

	create(input: { email: string }) {
		return this.kit.db.users.create(input);
	}
}
```

```ts
// src/middlewares/services.ts
import { tryObjectId } from '@nxgt/mongo';
import { createMiddleware } from 'hono/factory';
import type { Kit } from '../db';
import { UserService } from '../services/users.service';

export const provideServices = (kit: Kit) =>
	createMiddleware(async (c, next) => {
		const actor = tryObjectId(c.req.header('x-user-id'));
		if (!actor) return c.json({ message: 'errors.unauthenticated' }, 401);
		// One kit per request, stamping that user; the kit it came from is
		// untouched, so a request's actor never leaks into the next.
		c.set('services', { users: new UserService(kit.as(actor)) });
		await next();
	});
```

```ts
// src/index.ts
import { createKit } from '@nxgt/mongo-kit';
import { buildApp } from './app';
import { config } from './db';

const kit = await createKit(config);
Bun.serve({ fetch: buildApp(kit).fetch });
```

A handler reads `c.get('services')` and never reaches the kit itself, so it
cannot write as somebody else and cannot close it.

## Signatures

```ts
function createKit<C>(config: KitConfig<C>): Promise<MongoKit<C>>;

type DbScope<C> = {
	readonly [K in keyof CollectionsOf<C>]: TypedCollection<CollectionsOf<C>[K]>;
} & Db;

interface MongoKit<C> extends AsyncDisposable {
	readonly db: SoleScope<C>;
	readonly databases: { readonly [N in DbName<C>]: DbScope<CollectionsIn<C, N>> };
	readonly clients: { readonly [N in DbName<C>]: MongoClient };
	readonly actor: KitActor<C> | undefined;
	readonly session: ClientSession | undefined;
	as(actor: KitActor<C>): MongoKit<C>;
	withSession(session: ClientSession | undefined): MongoKit<C>;
	transaction<T>(
		fn: (kit: MongoKit<C>) => Promise<T>,
		options?: KitTransactionOptions<C>,
	): Promise<T>;
	sync(options?: SyncOptions): Promise<Record<DbName<C>, SyncReport[]>>;
	close(): Promise<void>;
}
```

## Next

- [The actor, sessions and transactions](actor-and-transactions.md).
- [Syncing](sync.md).
