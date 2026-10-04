# Configuration

`defineMongo` describes an application's MongoDB — where each database is,
and which collections live on it — and checks that description before
anything connects.

```ts
import { defineMongo } from '@nxgt/mongo';
import * as collections from './models';

export const config = defineMongo({
	uri: process.env.MONGO_URI!,
	collections,
});
```

It opens no socket and reads no environment variable of its own: the
application reads `process.env`, and what is wrong with the configuration
throws here, where the application starts, rather than at the first query.
[`openMongo`](db-scope.md) is what connects.

## The collections

`collections` is a module object, the one `import * as` gives:

```ts
// src/models/index.ts
export * from './users.model';
export * from './posts.model';
```

```ts
// src/models/users.model.ts
import { defineCollection, id, objectId } from '@nxgt/mongo';
import { z } from 'zod';

export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.string(),
		name: z.string().optional(),
	}),
	timestamps: true,
	actors: { type: objectId() },
	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
});
```

Every export that is a `defineCollection` becomes a key on the scope, under
the name it is **exported** by; a function, a constant or a type in the same
module is left where it is. The key is what the application reads
(`mongo.db.users`) and the definition's own `name` is what the server holds, so
`export const users = defineCollection({ name: 'app_users', … })` is
`mongo.db.users` here and `app_users` there.

Two exports pointing at one server collection are refused, and so is a key
the driver's `Db` already answers to (`command`, `watch`, `collection`, …):
it would be unreachable on the scope. Both are compile errors, and both are
checked again against the object at `openMongo`.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `uri` | `string` | — | Where to connect. One of `uri` and `client`, never both |
| `client` | `MongoClient` | — | A client the application opened. The Mongo uses it and never closes it |
| `clientOptions` | `MongoClientOptions` | `{}` | Passed to the driver with `uri`. Refused beside `client`, which has its own |
| `database` | `string` | the URI's, else `test` | The database's name |
| `collections` | module object | — | `import * as collections from './models'` |
| `options` | `WiredCollectionOptions<AnyCollectionDefinition>` | `{}` | `@nxgt/mongo`'s collection options, for every collection of this database |
| `optionsFor` | `{ [key]?: WiredCollectionOptions<Def> }` | `{}` | The same, per key, merged **over** `options` |
| `autoSync` | `boolean` | `false` | Sync each collection before its first operation, and create each bucket's indexes before its first call — which, [inside a transaction](#autosync), makes the driver run the body twice |
| `buckets` | module object | — | `import * as buckets from './files'`: [GridFS buckets](files.md), on the scope beside the collections |
| `bucketOptions` | `WiredBucketOptions` | `{}` | `@nxgt/mongo/gridfs`'s `validate`, `coerce` and `hash`, for every bucket of this database |

`options` and `optionsFor` take `@nxgt/mongo`'s own collection options —
`maxPageSize`, `coerce`, `validate`, `softDelete`, `touchUpdatedAt`,
`optimisticLock`, `hooks` — minus the four the wiring decides itself:

```ts
defineMongo({
	uri: process.env.MONGO_URI!,
	collections,
	options: { maxPageSize: 50 },
	optionsFor: { posts: { softDelete: false } },
});
```

`db`, `session`, `actor` and `autoSync` are **not** collection options here.
The database is named by its key, [`as` and `withSession`](actor-and-transactions.md)
carry the actor and the session, and `autoSync` is the database's. One of
them under `options` does not compile; under `optionsFor` the types cannot
see that deep, and `defineMongo` throws instead.

`optionsFor` under a key no collection is wired under does not compile
either, and the message names the key.

### `autoSync`

```ts
defineMongo({ uri: server.uri, collections, autoSync: true });
```

Each collection is synced before its first operation, once per database — for
tests and for local development. In production [`mongo.sync()`](sync.md) is a
deployment step: `collMod` needs the `dbAdmin` role, and an index build runs
outside any transaction.

It creates each [bucket](files.md)'s indexes before its first call too, and
there it has a cost: when that first call is an upload inside a transaction,
the chunks collection appears after the transaction's snapshot, the commit
fails, and the driver runs the body twice — a stream source the first run
read is refused on the second with a `TypeError`, and the transaction commits
nothing. Call [`mongo.syncBuckets()`](files.md#indexes-syncbuckets)
at start-up, before any transactional upload, and it runs once. The
[details are in Files](files.md#autosync-and-the-first-upload-in-a-transaction).

## Several databases

They name themselves, and the names are the keys on `mongo.databases` and on
the sync report:

```ts
import { defineMongo } from '@nxgt/mongo';
import * as collections from './models';
import * as events from './events';

export const config = defineMongo({
	databases: {
		main: { uri: process.env.MONGO_URI!, collections },
		analytics: {
			uri: process.env.ANALYTICS_URI!,
			database: 'analytics',
			collections: events,
		},
	},
});
```

Each entry takes the same keys as a lone database. A config that names none
is held under `default`, so `mongo.databases.default` is the long way of
writing `mongo.db`.

Two databases on one URI **share one client** — that is what `connectMongo`
already does — and must then be configured with the same `clientOptions`: a
second hold on a client opened with other options is refused.

## The Mongo's type

`MongoOf<typeof config>` is the type of the Mongo this config produces, for a
service or a module that declares it rather than reading it off
`await openMongo(…)`:

```ts
import { defineMongo, type MongoOf } from '@nxgt/mongo';
import * as collections from './models';

export const config = defineMongo({
	uri: process.env.MONGO_URI!,
	collections,
	options: { maxPageSize: 50 },
});

/** This application's mongo, read from the configuration rather than written twice. */
export type AppMongo = MongoOf<typeof config>;
```

```ts
import type { AppMongo } from './db';

export class UserService {
	constructor(private readonly mongo: AppMongo) {}

	create(input: { email: string }) {
		return this.mongo.db.users.create(input);
	}
}
```

## What it throws

Every check is a [`WiringError`](../errors.md) with `code: 'CONFIG'`, thrown from
`defineMongo`, before anything connects. The message names the database it
is about, and so does `error.database`:

```ts
defineMongo({ collections });
// WiringError: defineMongo: database "default" has neither a uri nor a client
```

- a database with both a `uri` and a `client`, or neither;
- `clientOptions` beside a `client` the Mongo did not open;
- a `collections` object with no definition in it — the usual cause is a
  default export, or an object of schemas rather than of definitions;
- two keys wiring the same server collection;
- `optionsFor` under a key the database does not wire;
- `db`, `session`, `actor` or `autoSync` inside `options` or `optionsFor`;
- a `buckets` object with no bucket definition in it, a bucket key a
  collection of the same database already holds, two keys wiring the same
  bucket, `session` or `autoSync` inside `bucketOptions`, and
  `bucketOptions` with no `buckets` at all — see
  [Files](files.md#declaring-the-buckets).

[Troubleshooting](../../troubleshooting.md) has each message with its fix.

## Signatures

```ts
function defineMongo<const C extends MongoConfigInput>(
	config: C & Checked<C>,
): MongoConfig<C>;

type MongoConfigInput =
	| DatabaseConfig<object>
	| { databases: Record<string, DatabaseConfig<object>> };

interface DatabaseConfig<C, B = object> {
	uri?: string;
	client?: MongoClient;
	clientOptions?: MongoClientOptions;
	database?: string;
	collections: C;
	options?: WiredCollectionOptions<AnyCollectionDefinition>;
	optionsFor?: {
		[K in keyof CollectionsOf<C>]?: WiredCollectionOptions<CollectionsOf<C>[K]>;
	};
	autoSync?: boolean;
	buckets?: B;
	bucketOptions?: WiredBucketOptions;
}

type WiredBucketOptions = Omit<BucketOptions, 'session' | 'autoSync'>;

type WiredCollectionOptions<Def> = Omit<
	CollectionOptions<Def>,
	'db' | 'session' | 'actor' | 'autoSync'
>;

type MongoOf<Config> = Config extends MongoConfig<infer C> ? Mongo<C> : never;
```

`CollectionsOf`, `CollectionsIn`, `DbName`, `NoCollision`, `DbMemberName` and
`Unwired` are exported too: they are what the refusals above are written
with.

## Next

- [The `db` scope](db-scope.md) — what `openMongo` gives back.
- [Syncing](sync.md) — making the server match the definitions.
