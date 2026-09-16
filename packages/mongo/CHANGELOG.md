# @nxgt/mongo

## 0.8.0

### Minor Changes

- [#23](https://github.com/softistx/nxgt-data/pull/23) [`c5dfe8a`](https://github.com/softistx/nxgt-data/commit/c5dfe8a007fa410cde33a8fe0c8fddaadf6e0d99) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Typed aggregation helpers: `distinct`, `groupBy` and `populate`
  
  - `collection.distinct(field, filter?, { withDeleted })`: the distinct values
    of a field, typed — an array field gives its elements. It now leaves
    soft-deleted documents out, like every read; the driver's is
    `raw.distinct`.
  - `collection.groupBy(field, { filter, measures, sort, limit, withDeleted })`:
    each group's `key` and `count`, and typed measures — `sum` and `avg` on
    numeric fields, `min` and `max` on any. Largest groups first by default.
  - `collection.populate(documents, relations)`: related documents under each
    relation's name, one query per relation. `{ from, by }` follows a field of
    these documents (a list field gives a list, in its order); `{ from, on }`
    gathers the documents that point back. The related collection reads with
    its own session and soft delete.
  
  The types refuse a non-numeric sum, a measure named `key` or `count`, a
  field that holds no reference, and a relation named after an existing field.

## 0.7.0

### Minor Changes

- [#22](https://github.com/softistx/nxgt-data/pull/22) [`174eb4c`](https://github.com/softistx/nxgt-data/commit/174eb4c39d2e4979af9fcef73cdb17f39732dbcf) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `connectMongo(uri, options)`: one `MongoClient` shared per URI
  
  Every call with the same URI shares a client, connected once even when the
  calls race, and gets its own `MongoConnection` (`client`, `db`, `ping`,
  `close`, `await using`). The client closes with its last connection, so one
  module closing its own does not cut the others off. A second call with other
  options throws without repeating the URI. A failed connect is forgotten, so
  the next call retries. `ping({ timeoutMS })` answers `{ ok, latencyMs }` or
  `{ ok: false, error }` and never throws. `closeMongo()` closes every client at
  shutdown; nothing listens to signals for you.

### Patch Changes

- [#20](https://github.com/softistx/nxgt-data/pull/20) [`ec2c664`](https://github.com/softistx/nxgt-data/commit/ec2c6640275dbddc28fcdaf1c669ab79fea9a5d1) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Internal: `src/collection/` is split into subject folders (`operations/`,
  `hooks/`, `changes/`). Nothing public moved: the exports, their types and
  their behaviour are unchanged, and the test counts are the same on both
  sides.

## 0.6.0

### Minor Changes

- [#18](https://github.com/softistx/nxgt-data/pull/18) [`af56ef9`](https://github.com/softistx/nxgt-data/commit/af56ef9884bdeb8962a0cfc2a098c693d8025ba5) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `collection.onChange`: a typed subscription to a collection's changes
  
  `users.onChange(handler, { events, filter, withDeleted, startAfter, onError,
  retries })` listens until `close()` — or `await using` — and hands over
  `create`, `update`, `delete` and `restore` changes typed by the schema. A soft
  delete arrives as a `delete` with `hard: false`, and a restore as a
  `restore`; updates to soft-deleted documents are left out unless
  `withDeleted`. `filter` is a filter on the documents, keyed on the schema's
  fields.
  
  Changes are handed over one at a time, in order. The driver resumes on its
  own after a dropped connection; when it gives up, the stream is reopened from
  the last token it held, so nothing is missed while the process is up. A
  change's `resumeToken` — typed `ResumeToken`, so an id is not taken for one —
  passed back as `startAfter`, picks up after a restart.
  The document is the exact post-image when the collection keeps them
  (`options.changeStreamPreAndPostImages`), and `before` is the pre-image.
  
  Errors go to `onError`; without it, the first one closes the subscription and
  rejects `closed`. `ready` rejects when the subscription fails before it ever
  opened. A handler may `close()` its own subscription.

## 0.5.0

### Minor Changes

- [#16](https://github.com/softistx/nxgt-data/pull/16) [`1616f15`](https://github.com/softistx/nxgt-data/commit/1616f1548f679d62fc1b6f09a1f4efe6c26c0e75) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Hooks around the writes, typed by the schema
  
  `getCollection(db, users, { hooks: { beforeCreate, afterDelete, … } })` runs
  hooks around `create`, `createMany` (once per document), `update`,
  `updateMany`, `delete`/`hardDelete`, `deleteMany`/`hardDeleteMany` and
  `restore`. A `before` hook gets what is about to be written — `{ values }`,
  `{ id, patch }`, `{ filter }` — and may return a replacement of the same shape
  or throw to stop the write; an `after` hook gets the document or the count.
  Every hook gets the operation, the collection the write runs on (session and
  actor included), the session and the actor; the delete hooks also say whether
  the delete is hard. `hooks` takes an array of sets, run in order, and
  `withSession` and `as` keep them. `restore`'s hooks are only typed on a collection
  whose definition soft deletes. An empty filter is refused before any hook
  runs, so a hook that narrows the filter cannot turn `deleteMany({})` into a
  delete of everything it can reach.
  
  `getCollection` now infers its types from the definition alone. It used to
  read them from the options too, which let a hook set typed for another
  collection widen them until it fit.

## 0.4.0

### Minor Changes

- [#14](https://github.com/softistx/nxgt-data/pull/14) [`170615a`](https://github.com/softistx/nxgt-data/commit/170615aae3e3c456151c0a659fb55042a640dda6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Stamps are options of `defineCollection`, and collections carry MongoDB's own options
  
  **Breaking.** The four spread helpers are gone. A field added by hand was only
  a field — spreading `...softDelete()` never made `delete` soft — so the stamps
  became options that add their fields to the schema *and* turn the behaviour on.
  
  ```ts
  // before
  schema: z.object({ _id: id(), email: z.email(), ...timestamps(), ...softDelete() }),
  
  // now
  schema: z.object({ _id: id(), email: z.email() }),
  timestamps: true,
  softDelete: true,
  ```
  
  | removed | replaced by |
  | --- | --- |
  | `...timestamps()` | `timestamps: true` |
  | `...softDelete()` | `softDelete: true` |
  | `...optimisticLock()` | `optimisticLock: true` |
  | `...actors(type?)` | `actors: true` or `actors: { type }` |
  | `stampsOf(schema)` | `definition.stamps` |
  
  Each option is `true`, `false`, or an object naming its fields one by one —
  `softDelete: { deletedAt: 'removedAt' }`, `actors: { createdBy: 'openedBy',
  deletedBy: false }`. Inside that object an absent key means on under its
  default name; only `false` turns a field off. The name then follows
  everywhere: the document type, the `$jsonSchema` validator, the field `delete`
  writes, and the fields an index may be keyed on — indexing `deletedAt` on a
  collection that renamed it no longer compiles. The single-field builders
  (`timestampField`, `deletedAtField`, `versionField`, `actorFieldOf`) stay, for
  a field with no behaviour attached.
  
  `ActorOf` now reads the actor's type under the name the option gave it. It was
  looking for a literal `createdBy`, so a renamed actor field resolved to `never`
  and made `as()` uncallable — silently, since that compiles.
  
  **MongoDB's own collection options** are part of the definition:
  `options: { capped: { size, max }, timeseries: { timeField, metaField },
  collation, clusteredIndex, expireAfterSeconds, changeStreamPreAndPostImages }`,
  keyed on the schema's fields where they name one. `capped` is one object rather
  than three sibling keys, because the server refuses `capped` without a `size`.
  `sync` creates the collection with them, changes the few `collMod` accepts, and
  throws on the rest naming the option, the live value and the wanted one;
  `dryRun` lists every difference instead. Only what the definition asks for is
  compared, because MongoDB fills its own defaults into `collation` and
  `timeseries` and an equality check would report a difference on every run.
  A time-series collection gets no validator — MongoDB refuses one — so
  `validation.level` defaults to `'off'` there and asking for another throws
  where the definition is written.
  
  **`syncAll(db)`** syncs every collection `defineCollection` has built, with no
  list to keep: importing the module that defines one registers it.
  **`getCollection(db, def, { autoSync: true })`** syncs once per database before
  the first operation, for tests and development — `resetAutoSync(db)` forgets
  it, which a suite that drops its database between cases needs.

## 0.3.1

### Patch Changes

- [#12](https://github.com/softistx/nxgt-data/pull/12) [`8ecab7a`](https://github.com/softistx/nxgt-data/commit/8ecab7a858201e1c63bf7e86a2fd394d169c0131) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Internal: a collection is now assembled from modules instead of one factory.
  
  Nothing public moved — every export, every signature and every behaviour is
  what 0.3.0 shipped, and the same 144 tests pass on both sides of the change.
  
  `getCollection` was one 583-line file whose `build()` function held 487 of
  them: a closure over a dozen variables with twenty functions inside it. It is
  now a `CollectionContext` of plain resolved data, passed as the first argument
  to functions that live in `filters.ts`, `documents.ts`, `reads.ts`,
  `writes.ts` and `paginate.ts`. The factory that is left resolves the database,
  assembles the surface and proxies the driver's own collection, and nothing
  else; the largest function in the folder is now 66 lines.
  
  `withSession` and `as` still rebuild the collection with one option changed,
  exactly as before.
  
  The one thing this tidies in passing: `delete` and `deleteMany` built the
  soft-delete update separately, and now share it.

## 0.3.0

### Minor Changes

- [#10](https://github.com/softistx/nxgt-data/pull/10) [`0c30a0a`](https://github.com/softistx/nxgt-data/commit/0c30a0ac4fca03b79da1a20d7c0617bd7afc2018) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Collections rather than repositories, with the driver's own methods on the same
  object — and a good deal more of the schema actually checked by the compiler.
  
  **Breaking.** `createRepository` and the `Repository` type are gone, replaced by
  `getCollection` and `TypedCollection`. To migrate: `createRepository(db, def)`
  becomes `getCollection(db, def)`, `.with(session)` becomes
  `.withSession(session)`, and `.collection` — the driver's collection — becomes
  `.raw`. `RepositoryOptions` is `CollectionOptions`.
  
  What you get back is no longer a wrapper standing in front of the driver: it is
  this package's methods **and** the driver's `Collection`, on one object.
  `aggregate`, `watch`, `bulkWrite`, `distinct`, `collectionName` are all there
  directly. Three names are defined by both and this package's win, because a
  filter that came out empty must not rewrite a collection: `count`, `updateMany`
  and `deleteMany` return a number and require a filter. The driver's own stay
  reachable on `raw`, which is also the way out for an update operator this
  package does not name.
  
  `getCollection` takes a `Db` or a `MongoClient` — with a client, the database
  is the URI's, or the one named in `{ db }`. It does not take a session, because
  a session does not expose its client: the driver marks that field internal and
  keeps it out of its public types, so reading it would be a bet on a private
  field. `withSession` is how a collection joins a transaction.
  
  **The typing is considerably stricter**, which is the other half of this
  release. Measured on twelve mistakes that a user of 0.2.0 could make, seven got
  past the compiler; all seven are now compile errors: `sort` and `projection` on
  a field that does not exist, a projection that is neither 0, 1 nor an operator,
  `$set` on an unknown field or with the wrong type, and an actor of any type at
  all — `as()` now takes what the schema declares for `createdBy`, and a
  collection that stamps no actor has no `as()` to call. The update operators are
  declared by this package rather than taken from the driver, whose `UpdateFilter`
  is intersected with `Document` and therefore accepts every key; `$inc` and
  `$mul` want a numeric field, `$push` and `$addToSet` an array field and its
  element type. What stays unchecked, on purpose: the tail of a dotted path, and
  `filter`, which remains the driver's `Filter`.

## 0.2.0

### Minor Changes

- [#8](https://github.com/softistx/nxgt-data/pull/8) [`3aeeb5e`](https://github.com/softistx/nxgt-data/commit/3aeeb5edcb3f4b821ac355c33050ffa4c7f6b987) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Index keys are typed by the schema, documents carry `id`, and ids arrive from
  strings safely.
  
  `defineCollection`'s indexes were typed as the driver types them, which is
  `{ [key: string]: IndexDirection }` — every key accepted, nothing completed and
  a misspelt field only discovered when the index silently indexed nothing. They
  are now keyed on the schema's own fields, so an editor completes them and
  `{ key: { emial: 1 } }` does not compile. A path into a field,
  `{ key: { 'address.city': 1 } }`, is still allowed: that is how MongoDB indexes
  a nested key, and there is no honest way to check the tail of a path.
  
  Every document a repository gives back now has `id`, its `_id` as a string.
  It is computed rather than stored — the collection still holds `_id` alone —
  and it is enumerable, so `JSON.stringify` and a spread carry it and a handler
  can return the document unchanged. It is no field of the document, so a filter
  or a patch keyed on it does not compile, and writing a document that was read
  back drops it again rather than letting the validator refuse it. A schema that
  declares an `id` of its own keeps that one.
  
  New helpers turn a string into an `ObjectId`: `toObjectId`, which throws the
  new `InvalidIdError`, `tryObjectId`, which answers `undefined`, `toObjectIds`
  for a `$in` filter, `isValidObjectId` and `isObjectIdString`, and
  `objectIdParam()`, a Zod schema for a route's parameters. They exist because
  `new ObjectId(undefined)` does not throw — it invents a fresh id, and a
  parameter that never arrived then matches nothing instead of failing.

## 0.1.0

### Minor Changes

- [#6](https://github.com/softistx/nxgt-data/pull/6) [`835971d`](https://github.com/softistx/nxgt-data/commit/835971d11ea47d3bffaf368db799d9a42421a56b) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/mongo`: a typed MongoDB collection from one Zod schema.
  
  The schema is the single source. `z.output` types every read and `z.input`
  every write, and the same schema becomes the collection's `$jsonSchema`
  validator — which is not a mechanical conversion: MongoDB rejects `$ref`,
  `$schema`, `default`, `format` and `id`, has no `integer` type, and treats a
  keyword it does not know as an error rather than ignoring it.
  `toMongoJsonSchema` inlines every `$ref`, keeps only the keywords MongoDB
  knows, and maps `integer` onto the BSON types a whole number actually arrives
  as.
  
  `syncCollection` creates the collection, writes the validator when it changed
  and brings the indexes in line, idempotently and with a `dryRun`.
  `createRepository` gives typed reads and writes by `_id` or by filter, offset
  and cursor pagination, soft delete, optimistic locking through a `version`
  field, and audit stamps from `repository.as(actor)`. `withTransaction` runs a
  callback in a transaction and joins one that is already open, since MongoDB
  has no savepoints.
  
  MongoDB's errors arrive as `NotFoundError`, `ConflictError`, `ValidationError`,
  `OptimisticLockError` and `DataError`, so an application never reads a numeric
  code — and a duplicate key is the same `ConflictError` whether it came from a
  single write, which carries `keyPattern` and `keyValue`, or from a bulk one,
  which carries neither.
  
  The driver, `mongodb` (>=7), and `zod` (>=4.6.5) are peer dependencies.
