# @nxgt/mongo-kit

> **Deprecated.** This package moved into
> [`@nxgt/mongo`](https://www.npmjs.com/package/@nxgt/mongo), which now holds
> the whole API under shorter names. `@nxgt/mongo-kit` only re-exports it, with
> the old names marked `@deprecated`, and will not grow.

## What was renamed

| `@nxgt/mongo-kit` | `@nxgt/mongo` |
| --- | --- |
| `createKit` | `openMongo` |
| `defineConfig` | `defineMongo` |
| `KitError` | `WiringError` |
| `KitErrorCode` / `KitErrorOptions` | `WiringErrorCode` / `WiringErrorOptions` |
| `MongoKit<C>` | `Mongo<C>` |
| `KitOf` | `MongoOf` |
| `KitConfig` / `KitConfigInput` | `MongoConfig` / `MongoConfigInput` |
| `KitActor` | `MongoActor` |
| `KitTransactionOptions` | `MongoTransactionOptions` |
| `KitBucketOptions` / `KitCollectionOptions` | `WiredBucketOptions` / `WiredCollectionOptions` |
| `ReservedName` | `DbMemberName` |

Everything else keeps its name: `discoverCollections`, `DiscoverOptions`,
`DbScope`, `SoleScope`, `DbName`, `DatabaseConfig`, `CollectionsIn`,
`CollectionsOf`, `BucketsIn`, `BucketsOf`, `BucketSyncReport`, `NoCollision`,
`NoBucketCollision`, `NoOwnedBucketOption`, `NoBucketsToOption` and `Unwired`.

**What else changed in the move:** the error's `name` is `'WiringError'`
instead of `'KitError'`, and the messages begin `defineMongo:` and
`openMongo:` instead of `defineConfig:` and `createKit:`. The ones that named
the object changed too:

| was | is |
| --- | --- |
| `kit.db: this kit has several databases. …` | `db: this Mongo has several databases. …` |
| `This kit has no database "…": …` | `No database "…" in this Mongo: …` |
| `close: this kit came from … Close the kit createKit returned …` | `close: this Mongo came from … Close the one openMongo returned …` |
| `transaction: this kit …` | `transaction: this Mongo …` |
| `… which the kit decides` | `… which the wiring decides` |

A test that matches one of those messages, or the `name`, has to change with
them, whichever package it imports from. `error instanceof KitError` still
works: the alias is the same class.

## Moving over

```ts
// before
import { createKit, defineConfig } from '@nxgt/mongo-kit';

export const kit = await createKit(
	defineConfig({ uri: process.env.MONGO_URI!, collections }),
);
await kit.db.users.create({ email: 'ada@example.com' });
```

```ts
// after
import { defineMongo, openMongo } from '@nxgt/mongo';

export const mongo = await openMongo(
	defineMongo({ uri: process.env.MONGO_URI!, collections }),
);
await mongo.db.users.create({ email: 'ada@example.com' });
```

The configuration, the scopes, `as`, `withSession`, `transaction`, `sync`,
`syncBuckets`, `ping` and `close()` are unchanged; only the names above
differ. The guides are in
[`@nxgt/mongo`](https://github.com/softistx/nxgt-data/tree/develop/packages/mongo/docs/guide/wiring).

## Install

```sh
bun add @nxgt/mongo-kit @nxgt/mongo mongodb zod
```

`@nxgt/mongo` is a required peer, and so are `mongodb`, `zod` and
`typescript` through it.

## License

MIT
