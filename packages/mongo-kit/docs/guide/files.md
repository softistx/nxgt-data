# Files

GridFS buckets, wired the way the collections are: declared once in the
configuration, reached off the kit under the key they are exported by, and
run in the kit's session — so a file written inside `kit.transaction` commits
or rolls back with the documents written beside it.

The buckets themselves are
[`@nxgt/mongo/gridfs`](https://www.npmjs.com/package/@nxgt/mongo)'s:
`defineBucket` describes one, and what the kit hands back is the
`TypedBucket` its `getFiles` builds. This page is about the wiring; the
bucket's own calls — `put`, `putOnce`, `get`, `serve`, `paginate`, `delete` —
are documented there.

```ts
// src/files/index.ts
import { objectId } from '@nxgt/mongo';
import { defineBucket } from '@nxgt/mongo/gridfs';
import { z } from 'zod';

export const avatars = defineBucket({
	name: 'avatars',
	metadata: z.object({ userId: objectId(), width: z.int().optional() }),
});
export const uploads = defineBucket({ name: 'uploads' });

// src/db.ts
import { createKit, defineConfig } from '@nxgt/mongo-kit';
import * as buckets from './files';
import * as collections from './models';

export const kit = await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections, buckets }),
);

const file = await kit.db.avatars.put(Bun.file('ada.png'), {
	metadata: { userId: '68ca1f0f2b1c4d5e6f7a8b90' },
});
file.metadata.userId;          // an ObjectId: the metadata is typed
```

## Declaring the buckets

`buckets` is a module object, as `import * as buckets` gives it — the same
shape as `collections`, and it may even be the same module. Each export that
is a `defineBucket` becomes a key on the scope, under the name it is
exported by; anything else in the module is left out. The export name is the
key the application reads (`db.avatars`), and the bucket's own `name` is the
one on the server, where GridFS keeps `<name>.files` and `<name>.chunks`.

A bucket is told from a collection by its shape, not by where it is passed,
so a definition in the wrong object is simply not found there: a
`buckets` object that holds none is refused.

What `defineConfig` refuses, each a [`KitError`](errors.md) with
`code: 'CONFIG'`:

- a bucket key a collection of the same database already holds — both would
  be `db.<key>`;
- two keys wired to the same bucket name;
- a `buckets` object with no bucket definition in it;
- `session` or `autoSync` in `bucketOptions`.

A bucket key the driver's `Db` answers to — `watch`, `command`,
`collection`… — is refused by the types where the config is written, and by
`createKit` against the live `Db`, with `code: 'COLLISION'`, exactly as a
collection key is. The types refuse the collision with a collection key too.

## Options

```ts
defineConfig({
	uri: process.env.MONGO_URI!,
	collections,
	buckets,
	bucketOptions: { hash: false },
});
```

`bucketOptions` applies to every bucket of that database. It takes
`@nxgt/mongo/gridfs`'s `BucketOptions` — `validate`, `coerce`, `hash` — minus
the two the kit decides:

| Option | Where it comes from |
| --- | --- |
| `session` | the kit's: `withSession` and `transaction` carry it |
| `autoSync` | the database's `autoSync`, beside `collections` |

One of them in `bucketOptions` does not compile, and `defineConfig` refuses
it at run time as well.

## The scope

A bucket is an own property of the database scope, beside the collections:

```ts
Object.keys(kit.db);           // ['users', 'posts', 'avatars', 'uploads']
kit.db.avatars;                // TypedBucket<typeof avatars>
kit.databases.main.avatars;    // the same, with several databases
```

It is built the first time it is read, and kept for the life of that kit —
`kit.db.avatars === kit.db.avatars`. A kit from `as`, `withSession` or a
transaction builds its own, since the session is part of the bucket.

A bucket has **no actor**: `@nxgt/mongo/gridfs` stamps no `*By` field, so
`kit.as(userId).db.avatars` is the same bucket as `kit.db.avatars`, only
built again. Record who uploaded a file in its metadata if you need it.

## In a transaction

```ts
await kit.transaction(async (tx) => {
	const user = await tx.db.users.create({ email: 'ada@example.com' });
	await tx.db.avatars.put(Bun.file('ada.png'), {
		metadata: { userId: user._id },
	});
	// Throw here, and neither the user nor the file — nor any of its
	// chunks — is left behind.
});
```

`tx.db.avatars` runs in the transaction's session, like every collection of
`tx`. That is possible because `@nxgt/mongo/gridfs` writes the chunk
documents itself rather than through the driver's `GridFSBucket`, which takes
no session. The limits are MongoDB's:

- a transaction has a **60-second lifetime** by default
  (`transactionLifetimeLimitSeconds`), and every chunk it writes is held
  until it commits, so a large upload does not belong in one;
- **index creation is refused inside a transaction.** Create the indexes
  beforehand with `syncBuckets()`, or let `autoSync` create them — it does so
  outside the session, whichever call comes first;
- the body may **run twice**: the driver retries it from the start on a
  transient error. The file the failed attempt wrote went with it, but a
  source that can be read only once — a request body's stream — is spent.
  Read it into bytes before the transaction, or pass a `Bun.file`, which is
  read afresh each time.

## Indexes: `syncBuckets()`

```ts
const reports = await kit.syncBuckets();
// { default: { avatars: [ { collection: 'avatars.files', created: [ … ], existing: [] },
//                         { collection: 'avatars.chunks', created: ['files_id_1_n_1'], … } ],
//              uploads: [ … ] } }
```

A bucket needs four indexes, and **nothing creates them until something is
asked to** — without them, every read of a file scans the whole chunks
collection. `kit.sync()` does **not** create them: it syncs collection
definitions, and a bucket is not one. Call `syncBuckets()` beside it, as a
deployment step:

```ts
await kit.sync();
await kit.syncBuckets();
```

It goes database by database, reporting each bucket under its key — a
database with no bucket reports `{}` — and the first database that throws
stops the rest. It runs outside the kit's session, since mongod refuses
`createIndexes` in a transaction. It takes no options: a bucket's index
creation has no `dryRun`. A second run creates nothing and reports all four
as `existing`.

For tests and development, the database's `autoSync: true` creates a
bucket's indexes before its first call instead, once per database for the
life of the process.

## Signatures

```ts
interface DatabaseConfig<C, B = object> {
	// … the collection keys, see Configuration
	buckets?: B;
	bucketOptions?: KitBucketOptions;
}

type KitBucketOptions = Omit<BucketOptions, 'session' | 'autoSync'>;

type BucketsOf<B> = {
	[K in keyof B as B[K] extends BucketDefinition ? K : never]: B[K];
};

type DbScope<C, B = Record<never, never>> = {
	readonly [K in keyof CollectionsOf<C>]: TypedCollection<CollectionsOf<C>[K]>;
} & {
	readonly [K in keyof BucketsOf<B>]: TypedBucket<BucketsOf<B>[K]>;
} & Db;

interface MongoKit<C> {
	// …
	syncBuckets(): Promise<BucketSyncReport<C>>;
}

type BucketSyncReport<C> = {
	[N in DbName<C>]: { [K in keyof BucketsOf<BucketsIn<C, N>>]: BucketIndexReport[] };
};
```

`BucketsOf`, `BucketsIn`, `KitBucketOptions`, `NoBucketCollision` and
`BucketSyncReport` are exported from `@nxgt/mongo-kit`; `BucketDefinition`,
`BucketOptions`, `TypedBucket` and `BucketIndexReport` are
`@nxgt/mongo/gridfs`'s.

## Next

- [The actor, sessions and transactions](actor-and-transactions.md) — what
  else a transaction's kit carries.
- [Syncing](sync.md) — the collections' deployment step, beside this one.
- [Troubleshooting](../troubleshooting.md) — every refusal above, by its
  message.
