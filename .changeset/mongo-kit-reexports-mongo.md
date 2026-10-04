---
"@nxgt/mongo-kit": minor
---

`@nxgt/mongo-kit` is deprecated: its API moved into `@nxgt/mongo`, and this package now only re-exports it. `@nxgt/mongo` is its one peer besides `typescript` (`mongodb` and `zod` come with it), and the docs are gone from the package — they live in `@nxgt/mongo`.

Every renamed name keeps its old spelling as a `@deprecated` alias: `createKit` is `openMongo`, `defineConfig` is `defineMongo`, `KitError` is `WiringError` (a value and a type: `instanceof` and `new` still work), and `MongoKit`, `KitOf`, `KitConfig`, `KitConfigInput`, `KitActor`, `KitTransactionOptions`, `KitBucketOptions`, `KitCollectionOptions`, `KitErrorCode`, `KitErrorOptions` and `ReservedName` are `Mongo`, `MongoOf`, `MongoConfig`, `MongoConfigInput`, `MongoActor`, `MongoTransactionOptions`, `WiredBucketOptions`, `WiredCollectionOptions`, `WiringErrorCode`, `WiringErrorOptions` and `DbMemberName`; the names that did not change are re-exported as they were.

**What changes for a caller:** the error's `name` is `'WiringError'`, not `'KitError'`, and the messages follow `@nxgt/mongo`. A refusal begins `defineMongo:` or `openMongo:` instead of `defineConfig:` or `createKit:`; `kit.db: this kit has several databases. …` is now `db: this Mongo has several databases. …`, `This kit has no database "…": …` is `No database "…" in this Mongo: …`, `this kit …` is `this Mongo …`, and `which the kit decides` is `which the wiring decides`. A test that matches one of those, or the `name`, has to change. Move to `@nxgt/mongo` when you can: `bun add @nxgt/mongo`, then rename as above.
