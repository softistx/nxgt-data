# Troubleshooting

Every method turns a driver error into one of this package's own, so the
heading is usually a `DataError` subclass's message: `ConflictError`,
`ValidationError`, `NotFoundError`, `OptimisticLockError`, `InvalidIdError`,
`InvalidCursorError`, `CorruptFileError`, `MigrationError`,
`MigrationLockedError`, `ConnectionError`. Each carries a `code` you can
switch on, and the driver's error as `cause`. A mistake in a call — a field
that is not in the schema, an option a collection does not have — is a
`TypeError` instead: that is a bug in the code, not data. The wiring's own
refusals are a `WiringError` — a `TypeError` with a `code` — and have a
[part of their own](#wiring) at the end.

The classes are exported from `@nxgt/mongo`, and the same classes again from
`@nxgt/mongo/gridfs`, so `instanceof` holds across both.

- **Install and types**
  - [`Cannot find module 'mongodb' or its corresponding type declarations.`](#cannot-find-module-mongodb-or-its-corresponding-type-declarations)
  - [Two copies of `mongodb` in the tree](#two-copies-of-mongodb-in-the-tree)
- **Definition**
  - [`defineCollection: "users"'s schema has no _id.`](#definecollection-userss-schema-has-no-_id)
  - [`defineCollection: "users" declares "createdAt" in its schema and asks for it again as an option.`](#definecollection-users-declares-createdat-in-its-schema-and-asks-for-it-again-as-an-option)
  - [`defineCollection: "" is not a field name. Pass true for "deletedAt", a name, or false.`](#definecollection--is-not-a-field-name-pass-true-for-deletedat-a-name-or-false)
  - [`toMongoJsonSchema: "Node" refers to itself.`](#tomongojsonschema-node-refers-to-itself)
  - [`toMongoJsonSchema: cannot resolve #, which zod emitted`](#tomongojsonschema-cannot-resolve--which-zod-emitted)
  - [`defineCollection: "events" is a time-series collection, and MongoDB refuses to give one a validator`](#definecollection-events-is-a-time-series-collection-and-mongodb-refuses-to-give-one-a-validator)
  - [`getCollection: softDelete needs a soft-delete field, and "users" has none.`](#getcollection-softdelete-needs-a-soft-delete-field-and-users-has-none)
  - [`getCollection: optimisticLock needs a version field, and "users" has none.`](#getcollection-optimisticlock-needs-a-version-field-and-users-has-none)
  - [`getCollection: touchUpdatedAt needs an updated stamp, and "users" has none.`](#getcollection-touchupdatedat-needs-an-updated-stamp-and-users-has-none)
  - [`getCollection: given a Db for "app", and a db option of "reporting".`](#getcollection-given-a-db-for-app-and-a-db-option-of-reporting)
- **Sync**
  - [`sync: not allowed to run collMod on "users".`](#sync-not-allowed-to-run-collmod-on-users)
  - [`sync: "users" already exists with options MongoDB cannot change:`](#sync-users-already-exists-with-options-mongodb-cannot-change)
- **Writes**
  - [`Duplicate key on email in "users"`](#duplicate-key-on-email-in-users)
  - [`Document failed validation in "users": email bsonType`](#document-failed-validation-in-users-email-bsontype)
  - [`Document 6721… of "users" is at version 4, not 3: it changed since it was read`](#document-6721-of-users-is-at-version-4-not-3-it-changed-since-it-was-read)
  - [`create: "version" is kept by "users" itself and cannot be written.`](#create-version-is-kept-by-users-itself-and-cannot-be-written)
  - [`update on "users": "_id" is immutable, and an update never writes it. Leave it out; a document that needs another _id is a new document`](#update-on-users-_id-is-immutable-and-an-update-never-writes-it-leave-it-out-a-document-that-needs-another-_id-is-a-new-document)
  - [`upsert on "users": "_id" is immutable, and an upsert never writes it. Name it in the filter, which is what an inserted document is seeded from`](#upsert-on-users-_id-is-immutable-and-an-upsert-never-writes-it-name-it-in-the-filter-which-is-what-an-inserted-document-is-seeded-from)
  - [`update: "users" has no field "emial" in its schema`](#update-users-has-no-field-emial-in-its-schema)
  - [`deleteMany needs a filter. Pass { _id: { $exists: true } } to target every document of "users".`](#deletemany-needs-a-filter-pass--_id--exists-true---to-target-every-document-of-users)
  - [`upsert: "users" cannot upsert on "rank": it is matched rather than given a value`](#upsert-users-cannot-upsert-on-rank-it-is-matched-rather-than-given-a-value)
  - [`restore: "users" has no soft delete`](#restore-users-has-no-soft-delete)
  - [`update: the expected "version" must be a whole number, not 3.5`](#update-the-expected-version-must-be-a-whole-number-not-35)
  - [`upsert on "users" was answered with no document`](#upsert-on-users-was-answered-with-no-document)
- **Reads, ids and pagination**
  - [`No document in "users" with _id 6721…`](#no-document-in-users-with-_id-6721)
  - [`_id: expected an ObjectId or its 24-character hex string, got the string "nope"`](#_id-expected-an-objectid-or-its-24-character-hex-string-got-the-string-nope)
  - [`Invalid cursor in paginateByCursor on "users": it cannot be decoded`](#invalid-cursor-in-paginatebycursor-on-users-it-cannot-be-decoded)
  - [`Invalid cursor in paginateByCursor on "users": it was written for the ordering createdAt:asc, not _id:asc`](#invalid-cursor-in-paginatebycursor-on-users-it-was-written-for-the-ordering-createdatasc-not-_idasc)
  - [`paginateByCursor: "createdAt" is null in a document of "users". Page along a field every document has.`](#paginatebycursor-createdat-is-null-in-a-document-of-users-page-along-a-field-every-document-has)
  - [`paginate on "users": page must be an integer of at least 1, not 0`](#paginate-on-users-page-must-be-an-integer-of-at-least-1-not-0)
  - [`Invalid cursor in paginateByCursor on "users": unexpected shape`](#invalid-cursor-in-paginatebycursor-on-users-unexpected-shape)
  - [`Invalid cursor in paginateByCursor on "users": it holds 2 value(s) where the ordering _id:asc needs 1 (_id)`](#invalid-cursor-in-paginatebycursor-on-users-it-holds-2-values-where-the-ordering-_idasc-needs-1-_id)
- **Aggregation**
  - [`groupBy: "count" cannot name a measure.`](#groupby-count-cannot-name-a-measure)
  - [`groupBy: measure "total" must be one of { sum | avg | min | max: field }.`](#groupby-measure-total-must-be-one-of--sum--avg--min--max-field-)
  - [`groupBy: sort is 'count' or 'key', not size`](#groupby-sort-is-count-or-key-not-size)
  - [`groupBy: limit must be a whole number of at least 1, not 0`](#groupby-limit-must-be-a-whole-number-of-at-least-1-not-0)
  - [``populate: "team" needs a collection in `from`, and one of `by` or `on`.``](#populate-team-needs-a-collection-in-from-and-one-of-by-or-on)
- **Transactions and change streams**
  - [`This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.`](#this-mongodb-deployment-does-not-support-retryable-writes-please-add-retrywritesfalse-to-your-connection-string)
  - [`The $changeStream stage is only supported on replica sets`](#the-changestream-stage-is-only-supported-on-replica-sets)
  - [`withTransaction: this session is already in a transaction, which this call joins.`](#withtransaction-this-session-is-already-in-a-transaction-which-this-call-joins)
  - [`onChange: a filter cannot use $expr.`](#onchange-a-filter-cannot-use-expr)
  - [An unhandled rejection from `closed` ends the process](#an-unhandled-rejection-from-closed-ends-the-process)
- **GridFS**
  - [`putOnce: another write holds _id 6721… in "avatars" and has not finished.`](#putonce-another-write-holds-_id-6721-in-avatars-and-has-not-finished)
  - [`putOnce: _id 6721… in "avatars" was claimed and let go again while this write was taking it over. Retry.`](#putonce-_id-6721-in-avatars-was-claimed-and-let-go-again-while-this-write-was-taking-it-over-retry)
  - [`putOnce: "avatars" holds chunks under _id 6721… that no file claims — chunk 0 was free and a later one was not.`](#putonce-avatars-holds-chunks-under-_id-6721-that-no-file-claims--chunk-0-was-free-and-a-later-one-was-not)
  - [``putOnce: "avatars" already has a different file under _id 6721…, whose digest begins the same way. Store these bytes with `put`.``](#putonce-avatars-already-has-a-different-file-under-_id-6721-whose-digest-begins-the-same-way-store-these-bytes-with-put)
  - [`putOnce: the bytes decide the id, so this call cannot be given one.`](#putonce-the-bytes-decide-the-id-so-this-call-cannot-be-given-one)
  - [``putOnce: "avatars" is bound with `hash: false`, and without a digest there is nothing to compare.``](#putonce-avatars-is-bound-with-hash-false-and-without-a-digest-there-is-nothing-to-compare)
  - [`put: "avatars" already has a file with _id 6721….`](#put-avatars-already-has-a-file-with-_id-6721)
  - [`put on "avatars": this stream was already read, or is held by another reader, so it has nothing left to store.`](#put-on-avatars-this-stream-was-already-read-or-is-held-by-another-reader-so-it-has-nothing-left-to-store)
  - [`Chunk 3 of file 6721… in "avatars" is missing`](#chunk-3-of-file-6721-in-avatars-is-missing)
  - [`File 6721… in "avatars" reads 900 bytes where its chunks should hold 1024: a chunk of it was truncated`](#file-6721-in-avatars-reads-900-bytes-where-its-chunks-should-hold-1024-a-chunk-of-it-was-truncated)
  - [``put: "contentType" and "sha256" are kept by "avatars" itself.``](#put-contenttype-and-sha256-are-kept-by-avatars-itself)
  - [`put on "avatars": expected a file, a blob, a response, a stream or bytes, not null`](#put-on-avatars-expected-a-file-a-blob-a-response-a-stream-or-bytes-not-null)
  - [`put on "avatars": this Response has no body, so it has nothing to store.`](#put-on-avatars-this-response-has-no-body-so-it-has-nothing-to-store)
  - [`Chunk 3 of file 6721… in "avatars" holds a string where its bytes should be`](#chunk-3-of-file-6721-in-avatars-holds-a-string-where-its-bytes-should-be)
  - [`defineBucket: "avatars.small" is not a bucket name.`](#definebucket-avatarssmall-is-not-a-bucket-name)
  - [`(node:1) [NxgtGridFSMissingIndex] Warning: Bucket "avatars" has no files_id_1_n_1 on "avatars.chunks": every read scans the whole collection, …`](#node1-nxgtgridfsmissingindex-warning-bucket-avatars-has-no-files_id_1_n_1-on-avatarschunks-every-read-scans-the-whole-collection-)
- **Migrations**
  - [`Migrations are locked by host:1234:6721… until 2026-01-01T00:00:00.000Z`](#migrations-are-locked-by-host12346721-until-2026-01-01t000000000z)
  - [`This run lost its migration lock: it was not renewed in time, and another run may have taken it.`](#this-run-lost-its-migration-lock-it-was-not-renewed-in-time-and-another-run-may-have-taken-it)
  - [`Migration "0002-add-index" is recorded as applied and is no longer in the list.`](#migration-0002-add-index-is-recorded-as-applied-and-is-no-longer-in-the-list)
  - [`Migration "0005-backfill" is pending and listed before one that is already applied.`](#migration-0005-backfill-is-pending-and-listed-before-one-that-is-already-applied)
  - [`Migration "0003-move-fields" failed up, and nothing it did was kept:`](#migration-0003-move-fields-failed-up-and-nothing-it-did-was-kept)
  - [`defineMigration: "0004-add-slug" has no up`](#definemigration-0004-add-slug-has-no-up)
  - [`Migration "0002-add-index" is listed twice`](#migration-0002-add-index-is-listed-twice)
  - [`migrations: lockTtlMs must be a whole number of milliseconds, at least 1000, not 500`](#migrations-lockttlms-must-be-a-whole-number-of-milliseconds-at-least-1000-not-500)
- **Connections**
  - [`connectMongo: this URI is already connected with other options.`](#connectmongo-this-uri-is-already-connected-with-other-options)
  - [`connectMongo: every client was closed while this one was connecting.`](#connectmongo-every-client-was-closed-while-this-one-was-connecting)
- **Wiring**
  - [`"command" is a member of the driver's Db: wire this collection under another key`](#command-is-a-member-of-the-drivers-db-wire-this-collection-under-another-key)
  - [`"posts" is not wired by this database: there are no options for it`](#posts-is-not-wired-by-this-database-there-are-no-options-for-it)
  - [`"watch" is a member of the driver's Db: wire this bucket under another key`](#watch-is-a-member-of-the-drivers-db-wire-this-bucket-under-another-key)
  - [`"users" is also a collection of this database: wire this bucket under another key`](#users-is-also-a-collection-of-this-database-wire-this-bucket-under-another-key)
  - [`this database wires no buckets: there are no bucket options to give`](#this-database-wires-no-buckets-there-are-no-bucket-options-to-give)
  - [`"autoSync" is the wiring's to decide: withSession and transactions carry the session, and autoSync is the database's`](#autosync-is-the-wirings-to-decide-withsession-and-transactions-carry-the-session-and-autosync-is-the-databases)
  - [`defineMongo: a configuration object is required`](#definemongo-a-configuration-object-is-required)
  - [``defineMongo: databases must be an object of databases by name, as `{ databases: { main: … } }`. One database is the configuration itself, and names itself with `database`.``](#definemongo-databases-must-be-an-object-of-databases-by-name-as--databases--main----one-database-is-the-configuration-itself-and-names-itself-with-database)
  - [`defineMongo: database "main" has neither a uri nor a client`](#definemongo-database-main-has-neither-a-uri-nor-a-client)
  - [`defineMongo: database "main" has both a uri and a client: pass the one it should use`](#definemongo-database-main-has-both-a-uri-and-a-client-pass-the-one-it-should-use)
  - [`defineMongo: database "main" has client options beside a client it did not open: pass them where the client is made`](#definemongo-database-main-has-client-options-beside-a-client-it-did-not-open-pass-them-where-the-client-is-made)
  - [`defineMongo: database "main" is not a configuration object`](#definemongo-database-main-is-not-a-configuration-object)
  - [`defineMongo: database "main" has a uri that is not a string`](#definemongo-database-main-has-a-uri-that-is-not-a-string)
  - [`defineMongo: database "main" has a client that is not a MongoClient`](#definemongo-database-main-has-a-client-that-is-not-a-mongoclient)
  - [`defineMongo: database "main" has an empty database name`](#definemongo-database-main-has-an-empty-database-name)
  - [`defineMongo: database "main" has no collections object`](#definemongo-database-main-has-no-collections-object)
  - [`` defineMongo: database "main" has a collections object with no definition in it: pass the module, as in `import * as collections` ``](#-definemongo-database-main-has-a-collections-object-with-no-definition-in-it-pass-the-module-as-in-import--as-collections-)
  - [`defineMongo: database "main" wires "users" and "people" to the same collection, "users"`](#definemongo-database-main-wires-users-and-people-to-the-same-collection-users)
  - [`defineMongo: database "main" has "session" in options, which the wiring decides: …`](#definemongo-database-main-has-session-in-options-which-the-wiring-decides-)
  - [`defineMongo: database "main" has options for "posts", which it does not wire`](#definemongo-database-main-has-options-for-posts-which-it-does-not-wire)
  - [``defineMongo: databases names none. Give it at least one, as `{ databases: { main: … } }`.``](#definemongo-databases-names-none-give-it-at-least-one-as--databases--main---)
  - [`` defineMongo: database "main" has a buckets object with no bucket definition in it: pass the module, as in `import * as buckets` ``](#-definemongo-database-main-has-a-buckets-object-with-no-bucket-definition-in-it-pass-the-module-as-in-import--as-buckets-)
  - [`defineMongo: database "main" wires "users" as both a collection and a bucket: export one of them under another name`](#definemongo-database-main-wires-users-as-both-a-collection-and-a-bucket-export-one-of-them-under-another-name)
  - [`defineMongo: database "main" wires "avatars" and "pictures" to the same bucket, "avatars"`](#definemongo-database-main-wires-avatars-and-pictures-to-the-same-bucket-avatars)
  - [`defineMongo: database "main" has "session" in bucketOptions, which the wiring decides: …`](#definemongo-database-main-has-session-in-bucketoptions-which-the-wiring-decides-)
  - [`defineMongo: database "main" has bucketOptions but no buckets: pass the buckets they are for, or leave them out`](#definemongo-database-main-has-bucketoptions-but-no-buckets-pass-the-buckets-they-are-for-or-leave-them-out)
  - [`openMongo: database "main" wires a collection under "command", which is a member of the driver's Db: it would be unreachable. Export that definition under another name.`](#openmongo-database-main-wires-a-collection-under-command-which-is-a-member-of-the-drivers-db-it-would-be-unreachable-export-that-definition-under-another-name)
  - [`openMongo: database "main" wires a bucket under "watch", which is a member of the driver's Db: it would be unreachable. Export that definition under another name.`](#openmongo-database-main-wires-a-bucket-under-watch-which-is-a-member-of-the-drivers-db-it-would-be-unreachable-export-that-definition-under-another-name)
  - [`Bucket "avatars" has no files_id_1_n_1 on "avatars.chunks": every read scans the whole collection, and the cost grows with the bucket rather than with the file. Call syncIndexes() at start-up, or bind with autoSync.`](#bucket-avatars-has-no-files_id_1_n_1-on-avatarschunks-every-read-scans-the-whole-collection-and-the-cost-grows-with-the-bucket-rather-than-with-the-file-call-syncindexes-at-start-up-or-bind-with-autosync)
  - [`MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017`](#mongoserverselectionerror-connect-econnrefused-12700127017)
  - [`ping: no answer in 2000ms`](#ping-no-answer-in-2000ms)
  - [`MongoTopologyClosedError: Topology is closed`](#mongotopologyclosederror-topology-is-closed)
  - [`connectMongo: this URI is already connected with other options. Pass the same options everywhere, or close the first connection.`](#connectmongo-this-uri-is-already-connected-with-other-options-pass-the-same-options-everywhere-or-close-the-first-connection)
  - [``db: this Mongo has several databases. Read the one you mean, as `mongo.databases.main`.``](#db-this-mongo-has-several-databases-read-the-one-you-mean-as-mongodatabasesmain)
  - [`No database "reporting" in this Mongo: it has "main", "analytics".`](#no-database-reporting-in-this-mongo-it-has-main-analytics)
  - [``close: this Mongo came from `as`, `withSession` or a transaction. Close the one `openMongo` returned — the clients are shared.``](#close-this-mongo-came-from-as-withsession-or-a-transaction-close-the-one-openmongo-returned--the-clients-are-shared)
  - [`not authorized on app to execute command { collMod: "users", … }`](#not-authorized-on-app-to-execute-command--collmod-users--)
  - [``transaction: this Mongo holds more than one client, and a transaction lives on one. Name the database it runs on, as `{ on: 'main' }`.``](#transaction-this-mongo-holds-more-than-one-client-and-a-transaction-lives-on-one-name-the-database-it-runs-on-as--on-main-)
  - [``transaction: this Mongo is already in a session, which this call joins, so `on` has no client left to choose.``](#transaction-this-mongo-is-already-in-a-session-which-this-call-joins-so-on-has-no-client-left-to-choose)
  - [`ClientSession must be from the same MongoClient`](#clientsession-must-be-from-the-same-mongoclient)
  - [`ReferenceError: Bun is not defined`](#referenceerror-bun-is-not-defined)
  - [`discoverCollections: a glob is required`](#discovercollections-a-glob-is-required)
  - [`discoverCollections: src/models/one.model.ts and src/models/two.model.ts both define the collection "twice"`](#discovercollections-srcmodelsonemodelts-and-srcmodelstwomodelts-both-define-the-collection-twice)
  - [`discoverCollections: src/models/notes.ts exports no definition named "definition"`](#discovercollections-srcmodelsnotests-exports-no-definition-named-definition)

## Install and types

### `Cannot find module 'mongodb' or its corresponding type declarations.`

**When:** typechecking, on the first file that imports `@nxgt/mongo`.
**Why:** `mongodb` and `zod` are both **required peers**. Zod is not an
implementation detail here: the schema your application writes is this
package's input, so it has to be the copy the package parses with.
**Fix:**

```sh
bun add @nxgt/mongo mongodb zod
```

The supported ranges are `mongodb` `>=7.0.0 <8` and `zod` `>=4.6.5 <5`.

### Two copies of `mongodb` in the tree

**When:** no single message. `instanceof ObjectId` is false for an id that
plainly is one, a `Filter<T>` from one copy does not fit a method from the
other, and ids arrive as objects rather than as `ObjectId`s.
**Why:** a second `mongodb` — pulled in by another dependency pinned outside
the peer range — brings a second `ObjectId` class, and no `instanceof`
survives that.
**Fix:**

```sh
bun pm ls mongodb   # one line, or there is a second copy to reconcile
```

Keep one `mongodb` in the tree and let every package take it as a peer. This
package reads error **fields** rather than classes for the same reason, so
`ConflictError` and the rest still work when a tree does hold two.

## Definition

### `defineCollection: "users"'s schema has no _id.`

**When:** at `defineCollection`.
**Why:** the schema is the whole description of a document, and `_id` is part
of it: nothing can be typed, coerced or validated without it.
**Fix:**

```ts
import { defineCollection, id } from '@nxgt/mongo';

defineCollection({ name: 'users', schema: z.object({ _id: id(), email: z.email() }) });
```

`id()` fills a fresh `ObjectId` on create. A collection keyed by something
else declares that field instead — a string `_id`, for one.

### `defineCollection: "users" declares "createdAt" in its schema and asks for it again as an option.`

**When:** at `defineCollection`, when a stamp is both written in the schema
and turned on by an option — often by spreading a helper *and* setting
`timestamps: true`.
**Why:** the option adds the field to the schema itself; doing both would add
it twice.
**Fix:**

```ts
defineCollection({
	name: 'users',
	schema: z.object({ _id: id(), email: z.email() }), // no createdAt here
	timestamps: true, // the option adds createdAt and updatedAt, typed
});
```

A stamp option is what turns the **behaviour** on. Declaring `deletedAt` by
hand leaves `delete` a real delete.

### `defineCollection: "" is not a field name. Pass true for "deletedAt", a name, or false.`

**When:** at `defineCollection`, from a stamp option given an empty string.
**Why:** a stamp option is `true` (the default name), a name of your own, or
`false`.
**Fix:**

```ts
defineCollection({ name: 'users', schema, softDelete: 'removedAt' });
```

Every filter, patch and index is then typed against `removedAt`: indexing
`deletedAt` on that collection is a compile error, not a useless index.

### `toMongoJsonSchema: "Node" refers to itself.`

**When:** at `sync`, or at `defineCollection` with a validator, for a Zod
schema with a recursive type.
**Why:** MongoDB's `$jsonSchema` has no `$ref`, so every reference is inlined
— and a schema that refers to itself cannot be inlined. It throws rather than
write a validator the server would refuse.
**Fix:**

```ts
// keep the recursive part out of the validator
const node = z.object({ label: z.string(), children: z.array(z.unknown()) });
defineCollection({ name: 'trees', schema, validation: { level: 'off' } });
```

The Zod schema still checks writes in the application; only the server-side
validator is dropped.

### `toMongoJsonSchema: cannot resolve #, which zod emitted`

**When:** at `sync`, or at `defineCollection` with a validator, for a schema
whose recursion comes back to the **whole document** rather than to a named
definition.
**Why:** Zod writes that reference as `$ref: '#'`, which points at the root of
the JSON Schema and not at anything under `$defs`. The validator is built by
inlining every `$ref`, and there is nothing under `#` to inline. A `$ref` put
into a schema's `.meta()` by hand resolves to nothing for the same reason,
and names itself in the message.
**Fix:**

```ts
defineCollection({ name: 'trees', schema, validation: { level: 'off' } });
```

As with a self-referring definition, the Zod schema still checks every write
the package makes; only the server-side validator is given up.

### `defineCollection: "events" is a time-series collection, and MongoDB refuses to give one a validator`

**When:** at `defineCollection`, with `timeseries` and a
`validation.level` other than `'off'`.
**Why:** MongoDB refuses a validator on a time-series collection at creation,
and refuses the later `collMod` too.
**Fix:**

```ts
defineCollection({ name: 'events', schema, timeseries: { timeField: 'at' } });
// validation.level defaults to 'off' there; asking for anything else throws
```

### `getCollection: softDelete needs a soft-delete field, and "users" has none.`

**When:** at `getCollection`, with `softDelete: true`,
`touchUpdatedAt: true` or `optimisticLock: true` — each has its own message
in the same shape.
**Why:** the option asserts a behaviour whose field the definition never
declared. The option is only needed to assert it: each one is on by itself
whenever the definition has the field.
**Fix:**

```ts
// turn it on where the collection is defined, not where it is used
defineCollection({ name: 'users', schema, softDelete: true, optimisticLock: true });
```

### `getCollection: optimisticLock needs a version field, and "users" has none.`

**When:** at `getCollection`, with `optimisticLock: true` on a collection the
definition gave no version field.
**Why:** the option only **asserts** the behaviour; the field is what
provides it. Asserting a lock a collection cannot keep would leave an
expected version in a patch meaning nothing.
**Fix:**

```ts
defineCollection({ name: 'users', schema, optimisticLock: true }); // or a name of your own
```

The lock is then on by itself wherever the collection is used, and
`optimisticLock: true` at `getCollection` is only worth passing to say so.

### `getCollection: touchUpdatedAt needs an updated stamp, and "users" has none.`

**When:** at `getCollection`, with `touchUpdatedAt: true` on a collection
defined without `timestamps`.
**Why:** the same shape: there is no updated stamp to touch.
**Fix:**

```ts
defineCollection({ name: 'users', schema, timestamps: true }); // adds createdAt and updatedAt
```

A collection that has the stamp takes `touchUpdatedAt: false` too, which is
how one write leaves it alone; a collection without takes `false` only.

### `getCollection: given a Db for "app", and a db option of "reporting".`

**When:** at `getCollection`, when both a `Db` and a `db` name are passed.
**Why:** a `Db` already names its database, and the two disagree.
**Fix:**

```ts
getCollection(client, users, { db: 'reporting' }); // the client, plus a name
getCollection(db, users); // or the database you mean, with no name
```

## Sync

### `sync: not allowed to run collMod on "users".`

**When:** `sync()` or `syncAll()` against a collection that already exists,
with the application's own credential.
**Why:** changing a validator or a collection option needs the `collMod`
action, which `readWrite` does not grant and `dbAdmin` does. It arrives as a
`DataError` with `serverCode: 13`.
**Fix:**

```ts
// sync as a deployment step, with a role that has dbAdmin
await syncAll(deploymentDb); // every collection defined in the process
```

### `sync: "users" already exists with options MongoDB cannot change:`

**When:** `sync()`, when the definition asks for a collection option MongoDB
fixes at creation — `capped`, `timeseries`, the collation, and their like.
The lines that follow name each option, what the collection has, and what the
definition asks for.
**Why:** none of those can be changed in place, and none of the ways out —
recreate, migrate, or put the definition back — can be guessed for you.
**Fix:**

```ts
const report = await users.sync({ dryRun: true }); // lists every difference, throws nothing
```

Then decide: recreate the collection with the options it needs, or put the
definition back to what the collection is.

## Writes

### `Duplicate key on email in "users"`

**When:** `create`, `createMany`, `update` or `upsert` against a unique
index.
**Why:** MongoDB's `E11000`, as a `ConflictError` with `index`, `keys` and —
for a single write — `values`.
**Fix:**

```ts
import { ConflictError } from '@nxgt/mongo';

try {
	await users.create({ email });
} catch (error) {
	if (error instanceof ConflictError) return conflict(error.keys);
	throw error;
}
```

Two things surprise people here: a duplicate from `createMany` carries **no**
`values`, because MongoDB puts `keyPattern` and `keyValue` on a single
write's error only; and an `upsert` cannot see a soft-deleted document, so it
inserts a new one and the unique index refuses it.

### `Document failed validation in "users": email bsonType`

**When:** any write, when the collection's `$jsonSchema` validator refuses
the document. The path and the rule of each issue follow the colon.
**Why:** a `ValidationError`, `serverCode: 121`, with `issues` holding the
paths, the rules, and what the server considered.
**Fix:**

```ts
import { ValidationError } from '@nxgt/mongo';

if (error instanceof ValidationError) return badRequest(error.issues);
```

The usual cause is a field written but not declared: `z.object()` becomes
`additionalProperties: false`. `z.looseObject()` is the way out. Writes
through `raw` and through migrations are checked by the server too, and it is
the only check they get.

### `Document 6721… of "users" is at version 4, not 3: it changed since it was read`

**When:** `update(id, { version })` on a collection with the optimistic lock,
when the document moved since it was read.
**Why:** a version in a patch is a **condition**, not a value: the update
runs only if the document is still at that version, and it leaves it one
higher. An `OptimisticLockError` carries `expectedVersion` and
`actualVersion`.
**Fix:**

```ts
import { OptimisticLockError } from '@nxgt/mongo';

try {
	await users.update(id, { name, version: read.version });
} catch (error) {
	if (error instanceof OptimisticLockError) return retryWithFreshRead();
	throw error;
}
```

### `create: "version" is kept by "users" itself and cannot be written.`

**When:** passing a stamp — `version`, `deletedAt`, `createdBy`, `updatedBy`,
`deletedBy`, `createdAt` — to `create`, `update` or `upsert`. A document that
was **read** and handed straight back to `create` hits this first, since it
carries all of them.
**Why:** the collection keeps those fields; letting a caller set them would
make them mean nothing.
**Fix:**

```ts
const { _id, version, createdAt, updatedAt, ...values } = read;
await users.create(values);
// or, when it really must be written by hand:
await users.raw.insertOne(document);
```

### `update on "users": "_id" is immutable, and an update never writes it. Leave it out; a document that needs another _id is a new document`

**When:** `update` or `updateMany` with a patch that names `_id` — as a
field, through any operator (`$set`, `$setOnInsert`, `$unset`, `$rename`
onto it or away from it, `$currentDate`, `$min`…), under a path such as
`_id.x`, or as `undefined`. `updateMany` throws the same message with only
the call's name changed:

```
updateMany on "users": "_id" is immutable, and an update never writes it. Leave it out; a document that needs another _id is a new document
```

An `_id` in `upsert`'s values has
[its own message](#upsert-on-users-_id-is-immutable-and-an-upsert-never-writes-it-name-it-in-the-filter-which-is-what-an-inserted-document-is-seeded-from).
It is checked on the caller's patch before any hook runs, and again on what
a `before` hook returns. Nothing is sent. The types refuse the same patches
except a top-level `_id: undefined` — `{ ...body, _id: undefined }` — which
compiles unless `exactOptionalPropertyTypes` is on; this is the run-time
half, for that, for a body that came from JSON, and for a cast.
**Why:** MongoDB never changes an `_id`. Before 0.18.0 the patch reached the
server: a new `_id` came back as a plain `DataError` with `serverCode: 66`
(`ImmutableField`) — on an upsert, in a message that quoted the value — and
the same `_id` went through as no change, sent for nothing. A bare
`TypeError`, like every refused argument here; the message names the call
and the collection, never the value.
**Fix:** leave it out. A body that carries the document's own id should not
be handed to a write as it is:

```ts
const { _id, id, ...patch } = body;
await users.update(userId, patch);

// another id: a new document, in one transaction
await withTransaction(client, async (session) => {
	const tx = users.withSession(session);
	const { _id: _, id: __, ...rest } = await tx.getById(oldId, { withDeleted: true });
	await tx.raw.insertOne({ ...rest, _id: newId }, { session });
	await tx.hardDelete(oldId);
});
```

`raw.insertOne` because `create` refuses the stamps a read document carries;
the copy keeps them. The driver's own `updateOne` and `raw` are not checked
here: a changed `_id` sent through them is refused by the server, as before.

### `upsert on "users": "_id" is immutable, and an upsert never writes it. Name it in the filter, which is what an inserted document is seeded from`

**When:** `upsert` with `_id` in its **values** — any value, the document's
own, or `undefined`. Before 0.18.0 it chose the id of an insert, and failed
with `ImmutableField` (66) on a match whose stored `_id` differed. Nothing is
sent, and no `beforeUpsert` hook runs. A top-level `_id: undefined` compiles
unless `exactOptionalPropertyTypes` is on; any other `_id` in the values is a
compile error too.
**Why:** an upsert's values are written on both halves, and the update half
can never change an `_id`.
**Fix:** take `_id` out of the values. If the insert must get a chosen id,
the filter can name it — but the filter is also the **match**, so
`upsert({ email, _id: chosen }, …)` no longer finds a document by its email
alone: it inserts a second one, or hits `ConflictError` on a unique index.
There is no exact equivalent of the 0.17 call. Derive `_id` from the key, or
read first:

```ts
// the key decides the id, so the filter names one thing
await users.upsert({ _id: idFor(email) }, { email, name });

// or read, then write
const found = await users.findFirst({ email });
if (found) await users.update(found._id, { name });
else await users.create({ _id: chosen, email, name });
```

A filter that names `_id` also fills a matched document's missing fields
differently: see [Upsert](guide/upsert.md#two-traps-worth-knowing-before-you-use-it).

### `update: "users" has no field "emial" in its schema`

**When:** a patch or a `values` object with a key the schema does not
declare.
**Why:** patches, sorts and projections are typed here, so a misspelling is
normally a compile error; this is the run-time half of the same check —
reached when the object came from JSON, or through an `any`.
**Fix:**

```ts
const patch = UserPatch.parse(body); // validate a body before it reaches a write
await users.update(id, patch);
```

A **filter** is the exception: `findMany({ filter: { nope: 1 } })` compiles
and matches nothing, because the driver's `Filter<T>` carries an index
signature. `upsert` checks its filter at run time, since it would otherwise
store the misspelling.

### `deleteMany needs a filter. Pass { _id: { $exists: true } } to target every document of "users".`

**When:** `updateMany` or `deleteMany` with no filter, or with `{}`.
**Why:** a filter built from a variable that came out empty would otherwise
rewrite the collection. The check runs **before** the hooks, so a hook that
would have narrowed it does not get the chance.
**Fix:**

```ts
await users.deleteMany({ _id: { $exists: true } }); // every document, said out loud
```

### `upsert: "users" cannot upsert on "rank": it is matched rather than given a value`

**When:** `upsert` whose filter is not a plain set of equalities: a condition
(`{ rank: { $gt: 5 } }`), an `$or`, a dot path, a field the schema does not
have, or a stamp the collection keeps. Each has its own message, all
beginning `upsert: "<collection>"`.
**Why:** MongoDB seeds an inserted document from the filter's equality
conditions — from inside `$and` and `$or` as well — so a filter that offers a
choice cannot say what it would insert. This package refuses instead of
storing a document nobody described.
**Fix:**

```ts
await users.upsert({ email }, { name, teamId }); // equalities only
```

Two more things about `upsert`: it needs every required field that has no
default, matching or not, because the check that an insert *could* happen
runs before the server is asked; and it cannot see a soft-deleted document.

### `restore: "users" has no soft delete`

**When:** `restore(id)` on a collection whose definition declares no
soft-delete stamp. The types leave `restore` off such a collection, so this is
the run-time half of the same check — reached from JavaScript, or through a
helper that takes any collection.
**Why:** `restore` clears the stamp. With no stamp, `delete` was a real
delete and there is nothing left to bring back.
**Fix:**

```ts
defineCollection({ name: 'users', schema, softDelete: true }); // then restore exists
```

### `update: the expected "version" must be a whole number, not 3.5`

**When:** `update(id, { version })` with a version that is not a whole number
at or above zero — a string off a JSON body, a float, or `undefined` from a
document that was read with a projection that left the field out.
**Why:** an expected version is a **condition** the update is run under, and
it is compared to the stored number as it is given. A string would never
match, and would arrive as an `OptimisticLockError` blaming a concurrent
write that never happened, so it is refused as the `TypeError` it is.
**Fix:**

```ts
const read = await users.getById(id);
await users.update(id, { name, version: read.version }); // the number the read gave back
```

From a request body, turn it into a number before the write:
`Number.isInteger(n)` and `n >= 0`, or a `z.coerce.number().int()` on the
body's field.

### `upsert on "users" was answered with no document`

The message goes on: *although MongoDB answers an upsert with the document it
matched or inserted. Nothing was stored. This is a bug in @nxgt/mongo or
something rewriting replies between the process and the server: report it at
https://github.com/softistx/nxgt-data/issues*

**When:** `upsert`, when the server answered an upsert with no document.
**Why:** MongoDB does not do that — `findOneAndUpdate` with `upsert: true`
and `returnDocument: 'after'` either matches, inserts, or errors. Reaching
this means a bug in this package, or something between the process and the
server rewriting replies. Nothing was stored. It is a `DataError` with
`code: 'DATABASE'` and the `collection` on it since 0.17.0 — **not** a
`TypeError`, which is what the other refusals of the same call are and what
this one used to be: those are a mistake in the call, and this one cannot be.
**Fix:** there is nothing to change in the call. Report it at
`https://github.com/softistx/nxgt-data/issues` with the collection definition,
the filter and the values, and the MongoDB version:

```ts
try {
	await users.upsert(filter, values);
} catch (error) {
	log.error({ collection: 'users', filter, values }, error); // then open an issue
	throw error;
}
```

## Reads, ids and pagination

### `No document in "users" with _id 6721…`

**When:** `getById`, `update(id)`, `delete(id)` or `restore(id)` on an id
nothing matches — a soft-deleted document included, since writes are scoped
to the live ones.
**Why:** a `NotFoundError`, with `collection` and `id`.
**Fix:**

```ts
const user = await users.findById(id); // undefined instead of throwing
await users.findById(id, { withDeleted: true }); // or look past the stamp
```

`update` never inserts: `$setOnInsert` in a patch does nothing and a missing
document is this error. `upsert` is the call built for that.

### `_id: expected an ObjectId or its 24-character hex string, got the string "nope"`

**When:** `toObjectId(value)` — directly, or through `objectIdParam`.
**Why:** an `InvalidIdError`, `code: 'INVALID_ID'`. It is a `DataError`
rather than a `TypeError` because a bad id is usually data off a URL, and a
handler wants to answer 400 or 404 rather than crash.
**Fix:**

```ts
import { InvalidIdError, toObjectId } from '@nxgt/mongo';

try {
	return await users.getById(toObjectId(request.params.id));
} catch (error) {
	if (error instanceof InvalidIdError) return badRequest('id');
	throw error;
}
```

Coercion itself never throws: `getById('nope')` hands the string on, matches
nothing, and raises `NotFoundError`. And `new ObjectId(undefined)` is a
**fresh** id, not an error — `toObjectId` throws, `tryObjectId` answers
`undefined`.

### `Invalid cursor in paginateByCursor on "users": it cannot be decoded`

**When:** `paginateByCursor({ after })` with a cursor this package did not
write — truncated in a URL, or made up. The call and the collection are named
in the sentence, because every paginated call takes the same `after`.
**Why:** an `InvalidCursorError`, `code: 'INVALID_CURSOR'`: a client's input,
so a 400.
**Fix:**

```ts
import { InvalidCursorError } from '@nxgt/mongo';

if (error instanceof InvalidCursorError) return badRequest('cursor');
```

### `Invalid cursor in paginateByCursor on "users": it was written for the ordering createdAt:asc, not _id:asc`

**When:** paging on with a cursor cut under a different `orderBy` or
`direction`.
**Why:** the ordering is part of the cursor, because a keyset is only valid
for the order it was cut in.
**Fix:**

```ts
await users.paginateByCursor({ orderBy: 'createdAt', direction: 'asc', after });
```

Carry `orderBy` and `direction` with the cursor on every page. The file
listing orders on `uploadDate` **and** `_id`, and refuses a cursor from the
other order for the same reason — its sentences open with
`Invalid cursor in paginate on "avatars"` instead.

### `paginateByCursor: "createdAt" is null in a document of "users". Page along a field every document has.`

**When:** paging along a field some documents do not have, or have as `null`.
**Why:** a keyset cannot step past a value that is not there.
**Fix:**

```ts
await users.paginateByCursor({ orderBy: '_id' });
```

### `paginate on "users": page must be an integer of at least 1, not 0`

**When:** `paginate({ page })` with `0`, a negative, or a fraction. The same
message names `pageSize` for that option, and `limit` for a cursor page's —
`paginateByCursor on "users": limit must be …`, and
`paginate on "avatars": limit must be …` for a bucket's listing — which
is `files.paginate({ limit })` on your side, under the name the bucket's
listing has inside the package. The call and the collection or bucket open
the sentence, since every paginated call takes the same option names.
**Why:** a `RangeError`, not a `DataError`: pages are one-based, and a value
off a query string that came out `0` or `NaN` would otherwise ask the server
to skip a negative number of documents. A `pageSize` **above** `maxPageSize`
is lowered to it rather than refused; only a value that is not a positive
integer throws.
**Fix:**

```ts
const asked = Number(query.page);
const page = Number.isInteger(asked) && asked > 0 ? asked : 1;
await users.paginate({ page, pageSize: 20 });
```

### `Invalid cursor in paginateByCursor on "users": unexpected shape`

**When:** `paginateByCursor({ after })` with a cursor that decodes as JSON but
not as a cursor — one built by hand, or a value from somewhere else that
happens to be valid base64url.
**Why:** an `InvalidCursorError`, `code: 'INVALID_CURSOR'`: a cursor is the
ordering it was cut in and the keyset values, and nothing else can be read as
a position. Client input, so a 400.
**Fix:**

```ts
const page = await users.paginateByCursor({ limit: 20 });
const next = await users.paginateByCursor({ after: page.nextCursor }); // pass it back unchanged
```

A cursor is opaque: never trim, decorate or re-encode one on the way through
a client.

### `Invalid cursor in paginateByCursor on "users": it holds 2 value(s) where the ordering _id:asc needs 1 (_id)`

**When:** paging on with a cursor whose ordering matches the call but whose
number of keyset values does not — a cursor edited by hand, or one from a
build whose `orderBy` meant a different pair of fields.
**Why:** paging on `_id` keeps one value; paging on any other field keeps that
field **and** `_id`, which breaks its ties, so two. A cursor carrying the
wrong count cannot be turned into a keyset condition. The sentence names the
ordering the call is on and the fields it needs, so the two can be compared
without decoding the cursor.
**Fix:**

```ts
const page = await users.paginateByCursor({ orderBy: 'createdAt', direction: 'asc' });
await users.paginateByCursor({ orderBy: 'createdAt', direction: 'asc', after: page.nextCursor });
```

It is an `InvalidCursorError` with `code: 'INVALID_CURSOR'`, like the two
cursor errors above, so one `catch` and one 400 cover all of them. Before
0.17.0 this one alone arrived as a plain `DataError` with `code: 'DATABASE'`,
and a handler mapping codes answered 500 to it.

## Aggregation

### `groupBy: "count" cannot name a measure.`

**When:** `groupBy(field, { measures })` with a measure called `key`, `count`
or `_id`, or one whose name starts with `$` or holds a `.`.
**Why:** every group comes back as `{ key, count, …measures }`, so those three
names are taken; a `$` or a `.` would be read by MongoDB as an operator or a
path rather than as a name.
**Fix:**

```ts
await orders.groupBy('status', { measures: { total: { sum: 'amount' } } });
// [{ key: 'paid', count: 12, total: 4310 }, …]
```

### `groupBy: measure "total" must be one of { sum | avg | min | max: field }.`

**When:** a measure that is not exactly one of those four operators over one
field name: two operators in the same measure, an operator this package does
not have, or a number where the field name goes.
**Why:** a measure becomes a single `$group` accumulator, and that is the
whole of what one can be.
**Fix:**

```ts
await orders.groupBy('status', {
	measures: { total: { sum: 'amount' }, last: { max: 'createdAt' } },
});
```

`sum` and `avg` take a numeric field, `min` and `max` any field — and the
types already refuse the rest, so this is what is left when the measures were
built from a request rather than written out.

### `groupBy: sort is 'count' or 'key', not size`

**When:** `groupBy(field, { sort })` with any other value.
**Why:** groups come back largest first (`'count'`, the default) or by the
value grouped on (`'key'`). There is no third order; `_id` breaks ties in
both, so the order is the same from call to call.
**Fix:**

```ts
await orders.groupBy('status', { sort: 'key' });
```

### `groupBy: limit must be a whole number of at least 1, not 0`

**When:** `groupBy(field, { limit })` with `0`, a negative, a fraction or
`NaN` — most often a `Number(query.limit)` on a parameter that was not sent.
**Why:** the limit becomes a `$limit` stage, which MongoDB refuses at zero or
below.
**Fix:**

```ts
const asked = Number(query.limit);
await orders.groupBy('status', { limit: Number.isInteger(asked) && asked > 0 ? asked : 10 });
```

### ``populate: "team" needs a collection in `from`, and one of `by` or `on`.``

**When:** `populate(documents, relations)` where a relation has no `from`, or
has neither `by` nor `on`, or has both.
**Why:** `from` is the collection to read; `by` names the field on **these**
documents that holds the ids, and `on` names the field on the other
collection that points back here. A relation is followed one way or the
other, so exactly one of the two.
**Fix:**

```ts
const found = await members.findMany();
const withRelations = await members.populate(found, {
	team: { from: teams, by: 'teamId' },         // this document points there
	mentees: { from: members, on: 'mentorIds' }, // those documents point here
});
```

The types refuse a field that is not a reference and a name that is already a
field on the document; this is the run-time check behind them.

## Transactions and change streams

### `This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.`

**When:** the first write inside `withTransaction`, against a **standalone**
`mongod`. Measured on mongod 8.2.
**Why:** transactions need a replica set, and a standalone is not one. The
driver's retryable writes go first, so this is the message you actually see.
**Fix:**

```sh
# a single-node replica set is enough, which is what this package's specs run on
mongod --replSet rs0 --dbpath ./data   # then: rs.initiate()
```

### `The $changeStream stage is only supported on replica sets`

**When:** `onChange`, against a standalone `mongod`. Measured
on mongod 8.2: server code `40573`, wrapped as a `DataError`.
**Why:** change streams read the oplog, which a standalone does not keep.
**Fix:** the same single-node replica set as above.

### `withTransaction: this session is already in a transaction, which this call joins.`

**When:** `withTransaction(session, fn, options)` inside another
transaction.
**Why:** MongoDB has no savepoints, so the read concern, the write concern
and the read preference are the outer transaction's; passing options here
would suggest otherwise.
**Fix:**

```ts
await withTransaction(session, async (s) => { /* … */ }); // no options
```

Two more things about transactions: there is **no ambient session**, so every
operation inside takes `collection.withSession(session)` — and the driver's
own methods (`collection.aggregate(…)`) want `{ session }` in their options
as usual. And the callback may be **retried** for up to 120 seconds, so it
must be safe to run twice and must not swallow errors.

### `onChange: a filter cannot use $expr.`

**When:** at `onChange(handler, { filter })`, before the subscription starts,
for a filter with a top-level operator other than `$and`, `$or` or `$nor` —
`$expr`, `$text` or `$where`.
**Why:** the filter is sent as a filter on the **change event**, with each
field looked up under the document the event carries. An operator that takes
an expression would be evaluated against the event instead, and would match
the wrong thing quietly. The message ends by naming what a filter there can
use: conditions on fields, combined with `$and`, `$or` or `$nor`.
**Fix:**

```ts
const subscription = users.onChange(handler, {
	filter: { $or: [{ role: 'admin' }, { rank: { $gt: 5 } }] },
});
```

The filter is matched against the document as it is **after** the change, so
an update is judged on its new values. A hard delete is the exception: it is
matched on the pre-image when the collection keeps one, and let through when
it does not.

### An unhandled rejection from `closed` ends the process

**When:** a subscription's change stream fails and nothing is watching it.
**Why:** `closed` rejects like an `error` event nobody listens to.
**Fix:**

```ts
const subscription = users.onChange(handler, { onError: (error) => log.error(error) });
// or: await subscription.closed;
```

## GridFS

### `putOnce: another write holds _id 6721… in "avatars" and has not finished.`

**When:** `putOnce`, when another write claimed the id these bytes decide and
has not written its `files` document within ten seconds.
**Why:** the id is twelve bytes of the digest, so the copies collide on the
server — that is the election. The winner's chunks are there and its file is
not, which is what an interrupted upload leaves behind.
**Fix:**

```ts
// retry the whole call: the winner's document usually lands in that window
const { file } = await files.putOnce(bytes);
```

If it keeps happening for the same id, chunks from a killed upload are
sitting there: sweep chunks whose `files_id` matches no `files` document, as
a maintenance pass over a bucket nothing is writing — never inside a `catch`.
`putOnce` never deletes a stored file, and a caller takes back only the
chunks it wrote itself.

### `putOnce: _id 6721… in "avatars" was claimed and let go again while this write was taking it over. Retry.`

**When:** `putOnce`, under concurrency: the id was claimed, abandoned, and
claimed again while this call was taking it over.
**Why:** the call retries the take-over once. Twice in a row means callers
are giving up on that id faster than it can be claimed.
**Fix:**

```ts
const { file, stored } = await files.putOnce(source); // safe to call again
```

Nothing was stored and nothing was destroyed; the call is idempotent by
construction, so retrying it is the whole fix.

### `putOnce: "avatars" holds chunks under _id 6721… that no file claims — chunk 0 was free and a later one was not.`

**When:** `putOnce`, when chunk 0 of the id was free but a later chunk was
not.
**Why:** exactly what an interrupted write leaves: chunks under an id no
`files` document claims. Storing on top of them would store the file short,
and it would read as corrupt — which is what this call exists to prevent.
**Fix:**

```ts
// a maintenance pass, on a bucket nothing is writing:
// remove chunks whose files_id matches no document in <bucket>.files
```

Do not delete on the strength of this error alone inside a request: by the
time you act, a slow writer may have landed its document.

### ``putOnce: "avatars" already has a different file under _id 6721…, whose digest begins the same way. Store these bytes with `put`.``

**When:** `putOnce`, when the id is held by a stored file whose digest is not
the one being stored.
**Why:** the id is the first twelve bytes of the sha-256, and two different
files can share those twelve bytes. Nothing has ever produced this by
accident; it is what it would look like.
**Fix:**

```ts
const saved = await files.put(source); // a fresh id, no deduplication
```

Never delete the stored file on this error: it is a real file somebody can
still read.

### `putOnce: the bytes decide the id, so this call cannot be given one.`

**When:** `putOnce(source, { id })`.
**Why:** the whole point of `putOnce` is that the digest chooses the `_id`,
which is how two callers storing the same bytes elect a winner on the server.
**Fix:**

```ts
await files.put(source, { id: myId }); // choose the id
await files.putOnce(source);           // or store these bytes once
```

### ``putOnce: "avatars" is bound with `hash: false`, and without a digest there is nothing to compare.``

**When:** `putOnce` on a bucket bound with `hash: false`.
**Why:** deduplication is by digest; with hashing off there is none.
**Fix:**

```ts
const files = getFiles(db, avatars); // leave `hash` alone
```

### `put: "avatars" already has a file with _id 6721….`

**When:** `put(source, { id })` with an id the bucket already holds.
**Why:** a write onto a taken id cannot be allowed to start: it would fail on
the `files` document at the very end, after the stored file's bytes had been
written over. A `ConflictError`.
**Fix:**

```ts
await files.delete(id);       // replace it deliberately…
const saved = await files.put(source); // …or let the bucket give it an id
```

### `put on "avatars": this stream was already read, or is held by another reader, so it has nothing left to store.`

The message goes on: *A transaction the driver retries runs this call again
over the stream its first run read. Read it into bytes before the
transaction, or pass a Blob or a `Bun.file`.* From `putOnce`, it begins
`putOnce on "avatars"`.

**When:** `put` or `putOnce` with a source that can be read only once and
has been: a `ReadableStream` that was read — to the end or in part — or that
someone holds a reader on, a `Response` whose body was read (`bodyUsed`) or
is held that way, a node `Readable` that was read, ended or was destroyed, or
a generator these calls read before. A `Response` read before used to get
`put: this Response has no body…`; it gets this message now. Most often
it is the **second run of a transaction**: the driver runs the callback again
from the start on a transient error — a bucket's first upload with
`autoSync` is one, whose commit fails with 112 — and the stream the first run
read is spent by then.
**Why:** a spent stream reads as empty. Before this refusal, the second run
stored a file of **0 bytes, with no error**, and committed whatever the
callback wrote beside it. A `TypeError`, since it is a mistake in the call,
and it is thrown on the first read, before any chunk is written: in a
transaction, nothing commits.
**Fix:** give the call something it can read again, or create the indexes
first so the usual first-upload retry does not happen:

```ts
const body = await request.bytes(); // read once, outside the transaction
await withTransaction(client, async (session) => {
	const file = await files.withSession(session).put(body, { type });
	await users.withSession(session).update(userId, { avatarId: file._id });
});

await files.syncIndexes(); // at start-up: the first upload runs the body once
```

A `Blob` or a `Bun.file` is read afresh each time and needs neither. A
stream too large to hold in memory does not belong in a transaction anyway:
every chunk it writes is held until the commit.

### `Chunk 3 of file 6721… in "avatars" is missing`

**When:** reading the bytes — `stream()`, `bytes()`, `text()`, `json()`,
`blob()`, `response()` or the bucket's `serve()` — never at `get`, which only
reads the `files` document.
**Why:** nothing in MongoDB ties a `files` document to its chunks, so a chunk
removed by hand, an interrupted write from another client, or a restore of
one collection without the other leaves a file whose `length` promises bytes
that are not there. A `CorruptFileError`.
**Fix:**

```ts
import { CorruptFileError } from '@nxgt/mongo/gridfs';

if (error instanceof CorruptFileError) return gone(); // then re-upload the file
```

### `File 6721… in "avatars" reads 900 bytes where its chunks should hold 1024: a chunk of it was truncated`

**When:** reading the bytes, when every chunk is present but together they
are short — a truncation leaves no gap to notice.
**Why:** the same broken-pair situation as above; this is the half that has
no missing number to name.
**Fix:** re-upload the file. A read never comes back quietly short: it is
this error or the bytes.

### ``put: "contentType" and "sha256" are kept by "avatars" itself.``

**When:** `put(source, { metadata })` with either name in the metadata.
**Why:** GridFS keeps no field for a content type — the specification dropped
it and the driver drops the option with it — so this package stores the type
and the digest in `metadata.contentType` and `metadata.sha256`.
**Fix:**

```ts
await files.put(source, { type: 'image/png', metadata: { userId } });
```

The digest is the bucket's to compute. A bucket's metadata schema may not
declare either name, which `defineBucket` refuses with a message of its own.

### `put on "avatars": expected a file, a blob, a response, a stream or bytes, not null`

**When:** `put` or `putOnce` (`putOnce on "avatars"`) with a source that is
none of those — the `null` a `FormData` field gives when nothing was sent, a
number, a plain object (`not an object`) or an instance of some other class
(`not a Map`). The message names the kind or the class, never the value.
**Why:** the source is read as a `File` or `Blob`, a `Response`, a
`ReadableStream`, an async iterable of chunks, bytes or a string; nothing
else can be turned into chunks. A `TypeError`, since it is a mistake in the
call.
**Fix:**

```ts
const field = form.get('avatar');
if (!(field instanceof File)) return badRequest('avatar');
const saved = await files.put(field, { type: field.type });
```

A string is stored as its UTF-8 bytes.

### `put on "avatars": this Response has no body, so it has nothing to store.`

**When:** `put` or `putOnce` with a `Response` that never had a body — a
`204`, a `HEAD` answer, `new Response(null)`. One whose body was already read
is the
[spent-stream refusal](#put-on-avatars-this-stream-was-already-read-or-is-held-by-another-reader-so-it-has-nothing-left-to-store)
instead.
**Why:** there are no bytes to store. A `TypeError`.
**Fix:** check the answer before storing it:

```ts
const answer = await fetch(url);
if (!answer.ok || !answer.body) return failed(answer.status);
await files.put(answer);
```

### `Chunk 3 of file 6721… in "avatars" holds a string where its bytes should be`

The message ends: *the chunk was written by something that is not GridFS, or
its `data` was overwritten*. A chunk with no `data` field at all says
`holds no data field` in place of `holds a string`; a chunk holding a number,
an array or `null` names that instead.

**When:** reading a file — `stream()`, `bytes()`, `text()`, `json()`,
`blob()`, `response()` or the bucket's `serve()` — whose chunk documents hold
something other than binary in `data`.
**Why:** a `CorruptFileError`, `code: 'CORRUPT_FILE'`, carrying the chunks
collection as `collection` (`"avatars.chunks"`) and the file's `_id` as `id`.
A chunk written by a GridFS client holds a `Binary`; a chunk restored from a
dump that mapped the field to a string, or inserted by hand as a fixture,
holds something that cannot be read as bytes. The message reports the
**shape** of what was found, never its value: a chunk holds a file's bytes.
**Fix:**

```ts
import { CorruptFileError } from '@nxgt/mongo/gridfs';

if (error instanceof CorruptFileError) return gone(); // then store the file again
```

Write chunks through the bucket (`put`, `putOnce`) rather than into the
`.chunks` collection, and restore `.files` and `.chunks` together.

### `defineBucket: "avatars.small" is not a bucket name.`

**When:** at `defineBucket`.
**Why:** GridFS builds `<name>.files` and `<name>.chunks` from it, so the
name may not be empty and may not contain `.` or `$`.
**Fix:**

```ts
defineBucket({ name: 'avatarsSmall', metadata });
```

### `(node:1) [NxgtGridFSMissingIndex] Warning: Bucket "avatars" has no files_id_1_n_1 on "avatars.chunks": every read scans the whole collection, …`

The warning's own text ends: *and the cost grows with the bucket rather than
with the file. Call syncIndexes() at start-up, or bind with autoSync.* It is
a `process` warning, not an error: nothing is thrown, and the read it came
beside returns the bytes.

**When:** the first read of a bucket whose chunks collection has no
`files_id_1_n_1` — `stream()`, `bytes()`, `text()`, `json()`, `blob()`,
`response()` or the bucket's `serve()` — since 0.17.0. It is emitted **once
per database and bucket per process**, so a second read is silent.
**Why:** nothing else creates those indexes. The driver builds them on its
first upload, and this package does not upload through the driver:
`GridFSBucket` takes no session, so the chunk documents are written here —
which is what lets a file write run in a transaction — and the driver's
safety net went with it. `putOnce` is the one call that creates them anyway,
because it elects on the unique `{ files_id, n }` index. Until they exist, a
read examines every chunk document of the bucket, and a bucket that was never
synced looks exactly like one that was until it holds enough files to hurt.
**Fix:**

```ts
const files = getFiles(db, avatars, { autoSync: true }); // before the first call that needs them
// or, on a bucket bound without it, once where the app starts:
await getFiles(db, avatars).syncIndexes();
```

The probe runs beside the read and never delays or fails it. It arrives on
the `process` channel every application already has, so it can be routed or
silenced without this package taking a view on logging — measured on bun
1.4.2, a listener receives it and Bun prints it as well:

```ts
process.on('warning', (warning) => {
	if ((warning as { code?: string }).code === 'NxgtGridFSMissingIndex') {
		log.warn(warning.message);
	}
});
```

`syncIndexes` runs in the bucket's session, and mongod refuses
`createIndexes` inside a transaction. If an index is dropped from outside the
process — by hand, or with the database — call `resetBucketSync(db)` so the
memo is forgotten.

## Migrations

### `Migrations are locked by host:1234:6721… until 2026-01-01T00:00:00.000Z`

**When:** `migrate()` while another run holds the lock — two deploys at once,
or a previous run killed before it released it.
**Why:** a `MigrationLockedError`. The lock is timed by the **server**, so a
lapsed one is taken over on its own; until it lapses, this is the answer.
**Fix:**

```ts
import { MigrationLockedError } from '@nxgt/mongo/migrations';

if (error instanceof MigrationLockedError) process.exit(0); // let the other run finish
```

Run migrations from one place, and wait for the lock's TTL rather than
deleting the lock document under a run that may still be alive.

### `This run lost its migration lock: it was not renewed in time, and another run may have taken it.`

**When:** during a long migration, when no renewal reached the server for a
whole TTL.
**Why:** the lock is renewed every third of its TTL; a network partition long
enough loses it, and another run may have started. Nothing more is run.
**Fix:**

```ts
await migrate(db, migrations, { lockTtlMs: 120_000 }); // above the slowest step
```

### `Migration "0002-add-index" is recorded as applied and is no longer in the list.`

**When:** `migrate()` or `migrationStatus()` after a migration file was deleted or
renamed.
**Why:** the records and the list must agree, or the order the migrations
were written for cannot be reconstructed.
**Fix:**

```ts
export const migrations = [m0001, m0002, m0003]; // put it back…
// …or remove its record from the migrations collection, deliberately
```

### `Migration "0005-backfill" is pending and listed before one that is already applied.`

**When:** `migrate()` after inserting a new migration **before** an applied
one — usually a merge that ordered by filename.
**Why:** applying it now would run it out of the order it was written for.
**Fix:**

```ts
export const migrations = [/* applied ones, in order */, newest]; // at the end
```

### `Migration "0003-move-fields" failed up, and nothing it did was kept:`

**When:** `migrate()`, when a step threw. The reason follows the colon.
**Why:** a `MigrationError` with the step's own error as `cause`. With a
transaction, nothing it did was kept; with `transaction: false`, the message
says instead that what it did before failing **stays** — and the step is not
recorded, so the next `migrate` starts it over.
**Fix:**

```ts
// a migration that runs without a transaction is written to be run twice
defineMigration({ id: '0003-move-fields', transaction: false, up: async ({ db }) => { /* idempotent */ } });
```

### `defineMigration: "0004-add-slug" has no up`

**When:** at `defineMigration`, when `up` is missing or is not a function.
**Why:** a migration is an id and what it does; there is nothing to record as
applied without an `up`. Two neighbours throw in the same shape: an id that
is not made of letters, digits, `_`, `-`, `.` and `:`, and a `down` that is
not a function.
**Fix:**

```ts
import { defineMigration } from '@nxgt/mongo/migrations';

export const addSlug = defineMigration({
	id: '0004-add-slug',
	async up({ db, session }) {
		await db.collection('posts').updateMany({}, [{ $set: { slug: '$title' } }], { session });
	},
});
```

An object shaped like a migration that never went through `defineMigration`
is accepted by the types and skips this check, so build them all here.

### `Migration "0002-add-index" is listed twice`

**When:** `migrate()`, `rollback()` or `migrationStatus()` with the same id
twice in the list — a copy-pasted `defineMigration`, or two modules exporting
one migration under the same id.
**Why:** a `MigrationError`. Records are keyed by the id, so the first copy
would be recorded as applied and the second silently skipped.
**Fix:**

```ts
export const migrations = [m0001, m0002, m0003]; // one entry per id, in order
```

### `migrations: lockTtlMs must be a whole number of milliseconds, at least 1000, not 500`

**When:** `migrate()`, `rollback()` or `migrationStatus()` with a `lockTtlMs`
under a second, or one that is not a whole number — seconds passed where
milliseconds were meant, most often.
**Why:** the lock is renewed every third of its TTL, so a TTL under a second
would spend the run renewing it, and a slow round trip would lose it. A
`TypeError`: a mistake in the call, not data.
**Fix:**

```ts
await migrate(db, migrations, { lockTtlMs: 120_000 }); // above the slowest step
```

The default is enough for most runs; raise it for a migration that holds the
lock for minutes.

## Connections

### `connectMongo: this URI is already connected with other options.`

**When:** a second `connectMongo` for the same URI with different options.
**Why:** one client is shared per URI, and the options are compared by value.
The URI is deliberately left out of the message: it may carry a password.
**Fix:**

```ts
// pass the same options everywhere, or close the first connection
const mongo = await connectMongo(uri, options);
```

### `connectMongo: every client was closed while this one was connecting.`

**When:** at shutdown: `closeMongo()` ran while a request was still
connecting.
**Why:** the shared client it was waiting for is gone, so the connect rejects
rather than handing back a dead client. A `ConnectionError` since 0.16.0 —
`code: 'CONNECTION'`, an `instanceof DataError` like the rest — where it was
a bare `Error` before. It carries no URI: a connection string holds the
password. MongoDB's own refusal to connect — a host that does not answer, an
authentication failure — is the driver's error, and reaches you unchanged.
**Fix:**

```ts
await mongo.close(); // give back one holder; closeMongo() takes every client away
```

Nothing is wrong with the URI, so this is the one connect failure worth
retrying: calling `connectMongo` again opens a fresh client.

```ts
import { ConnectionError, connectMongo } from '@nxgt/mongo';

try {
	return await connectMongo(uri);
} catch (error) {
	if (error instanceof ConnectionError) return await connectMongo(uri);
	throw error;
}
```

`mongo.client.close()` skips the count: the closed client stays shared, and
every later `connectMongo` for that URI gets it, dead, until `closeMongo()`.

## Wiring

Everything the **wiring** refuses — `defineMongo`, `openMongo`, a derived
`Mongo`'s `transaction` and `close`, and `discoverCollections` — is a
`WiringError`, exported from `@nxgt/mongo`. It carries a `code` — `CONFIG`,
`COLLISION`, `NO_DATABASE`, `SEVERAL_DATABASES`, `TRANSACTION`, `DERIVED` or
`DISCOVERY` — beside the `database` and the `key` it is about, so a caller
switches on the code instead of matching the sentence. It extends
`TypeError`, so a `catch` written against `TypeError` still catches it. The
driver's own errors, and the `DataError`s above, reach you unchanged.

```ts
import { WiringError } from '@nxgt/mongo';

try {
	await mongo.transaction(work, { on: 'main' });
} catch (error) {
	if (error instanceof WiringError) {
		log.error({ code: error.code, database: error.database, key: error.key });
	}
	throw error;
}
```

### `"command" is a member of the driver's Db: wire this collection under another key`

The whole line is a `TS2322`:

```
error TS2322: Type 'CollectionDefinition<…>' is not assignable to type
'CollectionDefinition<…> & "\"command\" is a member of the driver's Db: wire this collection under another key"'.
```

**When:** compiling the file that calls `defineMongo`.

**Why:** `mongo.db` is the driver's `Db` with the collections on it, so a key the
`Db` already answers to — `command`, `watch`, `collection`, `admin`,
`databaseName`… — would be unreachable, and reading it would give the driver's
member instead of your collection. The reserved names are read from the
driver's own type (`DbMemberName = keyof Db`), so a member a later driver
release adds is refused the day the pin moves.

**Fix:** export the definition under another name.

```ts
// src/models/commands.model.ts
export const commandLog = defineCollection({ name: 'commands', schema });
//           ^ the key on `mongo.db`; `name` is the collection on the server
```

The key is the **export name**, not the collection's `name`: only the export
name has to change.

### `"posts" is not wired by this database: there are no options for it`

**When:** compiling a `defineMongo` whose `optionsFor` names a key its
`collections` does not hold.

**Why:** `optionsFor` is keyed by the same export names as `collections`, and
options written for a key that is not wired would silently do nothing —
usually a renamed or moved model.

**Fix:**

```ts
defineMongo({
	uri: process.env.MONGO_URI!,
	collections,                       // `import * as collections from './models'`
	optionsFor: { articles: { maxPageSize: 200 } },  // a key `collections` exports
});
```

### `"watch" is a member of the driver's Db: wire this bucket under another key`

**When:** compiling a `defineMongo` whose `buckets` exports a bucket under
a name the driver's `Db` answers to.

**Why:** a bucket sits on the scope beside the collections, so it has the
same problem as a
[collection under such a key](#command-is-a-member-of-the-drivers-db-wire-this-collection-under-another-key):
`mongo.db.watch` would be the driver's method, never your bucket.

**Fix:** export it under another name. The export name is the key; the
bucket's `name` is what the server sees, and need not change.

```ts
// src/files/index.ts
export const watchClips = defineBucket({ name: 'watch' });
```

### `"users" is also a collection of this database: wire this bucket under another key`

**When:** compiling a `defineMongo` whose `buckets` and `collections`
export something under the same name.

**Why:** both would be `mongo.db.users`. Usually one module of models and one
of files that grew the same export name.

**Fix:** rename one of the two exports.

```ts
export const userPhotos = defineBucket({ name: 'users' });
//           ^ the key on `mongo.db`: `mongo.db.users` stays the collection
```

### `this database wires no buckets: there are no bucket options to give`

The whole line is a `TS2322`, on `bucketOptions`:

```
error TS2322: Type '{ hash: false; }' is not assignable to type
'{ readonly hash: false; } & "this database wires no buckets: there are no bucket options to give"'.
```

**When:** compiling a `defineMongo` whose database has `bucketOptions` and
no `buckets`.

**Why:** the options would apply to nothing — usually `buckets` was left
out, or moved to another database of a multi-database config while its
options stayed behind.

**Fix:** pass the buckets beside their options, or drop the options.

```ts
import * as buckets from './files';
defineMongo({ uri, collections, buckets, bucketOptions: { hash: false } });
```

### `"autoSync" is the wiring's to decide: withSession and transactions carry the session, and autoSync is the database's`

The same message names `"session"` when that is the key at fault.

**When:** compiling a `defineMongo` whose `bucketOptions` holds `session`
or `autoSync`.

**Why:** a bucket takes its session from the Mongo — `withSession`, or the
transaction a `mongo.transaction` body runs in — and its `autoSync` from the
database. Pinned in the config, either would outrank the mongo, and a file
would be written outside the transaction around it.

**Fix:**

```ts
defineMongo({
	uri: process.env.MONGO_URI!,
	collections,
	buckets,
	autoSync: true,                    // the database's, for tests and development
	bucketOptions: { hash: false },    // only validate, coerce and hash
});
```


`defineMongo` connects to nothing: everything below is a `WiringError` with
`code: 'CONFIG'`, thrown where the configuration is written, before the
application starts. It names the database it is about as `error.database`,
and the collection key as `error.key` when one is at fault.

### `defineMongo: a configuration object is required`

**When:** calling `defineMongo` with nothing, `undefined` or `null` — usually
a config read from a module that exports it under another name, or a value
built at run time that came out empty.

**Why:** the configuration is read as an object before anything else is
checked, so there is nothing to name a database with. A `defineMongo(config)`
where `config` is `undefined` is most often an import that resolved to
`undefined`: a default export read as a named one, or two modules importing
each other, so one of them is still empty when the other runs.

**Fix:** write the config as a literal, where the compiler sees its shape:

```ts
import * as collections from './models';

export const config = defineMongo({ uri, collections });
```

### ``defineMongo: databases must be an object of databases by name, as `{ databases: { main: … } }`. One database is the configuration itself, and names itself with `database`.``

**When:** calling `defineMongo` with a `databases` that is a string, a number
or `null`.

**Why:** `databases` is the multi-database shape, and its **keys** are the
names — `databases: 'main'` looks like naming the one database, which is what
`database` does. A single database says `database`, several say `databases`.

**Fix:**

```ts
defineMongo({ uri, database: 'analytics', collections });      // one database
defineMongo({ databases: { main: { uri, collections } } });    // several
```

`database` is the database on the server; the key under `databases` is the
name your code reads it by, as `mongo.databases.main`.

### `defineMongo: database "main" has neither a uri nor a client`

**When:** calling `defineMongo`.

**Why:** a database says where it is exactly once. This is most often an
environment variable that was not read — `process.env.MONGO_URI` is
`undefined`, so the property is absent.

**Fix:**

```ts
const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is not set');
export const config = defineMongo({ uri, collections });
```

### `defineMongo: database "main" has both a uri and a client: pass the one it should use`

**When:** calling `defineMongo`.

**Why:** the two mean different things about closing: with a `uri` the Mongo
opens the client and `close()` gives it back, with a `client` it uses yours and
never closes it. It will not guess which you meant.

**Fix:**

```ts
defineMongo({ client, database: 'main', collections });  // yours to close
```

### `defineMongo: database "main" has client options beside a client it did not open: pass them where the client is made`

**When:** calling `defineMongo` with both `client` and `clientOptions`.

**Why:** `clientOptions` is what the Mongo passes to the driver when it opens a
client. A client that is already open cannot take them, so they would be
ignored.

**Fix:**

```ts
const client = new MongoClient(uri, { maxPoolSize: 50 }); // here
defineMongo({ client, collections });
```

### `defineMongo: database "main" is not a configuration object`

**When:** calling `defineMongo({ databases: { main: … } })` with a database whose
value is not an object: `null`, a string, or a URI written where the config
belongs (`main: process.env.MONGO_URI`).

**Why:** each database is a configuration — `uri` or `client`, and
`collections` — not the connection string itself.

**Fix:**

```ts
defineMongo({ databases: { main: { uri, collections } } });
```

### `defineMongo: database "main" has a uri that is not a string`

**When:** calling `defineMongo` with a `uri` that is a number, a `URL`, or an
empty string.

**Why:** the driver takes a connection string, so the `uri` is checked as one
before anything connects. An environment variable that is set but empty gives
`''`, which is refused the same way (a variable that is not set at all is
[neither a uri nor a client](#definemongo-database-main-has-neither-a-uri-nor-a-client)).

**Fix:**

```ts
const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is not set');
defineMongo({ uri, collections }); // a non-empty string, or a URL's .href
```

### `defineMongo: database "main" has a client that is not a MongoClient`

**When:** calling `defineMongo` with a `client` that is not a driver
`MongoClient`: a `Db`, a `Promise` of one, or the connection string.

**Why:** the client is told by its `db()` method, which the wiring calls to
reach each database. A `Db`, or the promise from `MongoClient.connect()` that was
not awaited, has none.

**Fix:**

```ts
import { MongoClient } from 'mongodb';

const client = await new MongoClient(uri).connect(); // the client, not a promise
defineMongo({ client, database: 'main', collections });
```

### `defineMongo: database "main" has an empty database name`

**When:** calling `defineMongo` with `database: ''`.

**Why:** `database` is the name on the server and is read as given. An empty
string is usually a variable that was set but left empty; leaving `database` out
is allowed and takes the name the `uri` carries, or `test`.

**Fix:**

```ts
defineMongo({ uri, database: process.env.MONGO_DB || undefined, collections });
```

### `defineMongo: database "main" has no collections object`

**When:** calling `defineMongo` with no `collections`, or one that is not an
object: `undefined`, `null`, a string.

**Why:** the collections are read from a module object, and nothing else says
what the database holds. `undefined` is most often a module that was not
imported as a namespace, or a path that resolved to nothing.

**Fix:**

```ts
import * as collections from './models';

defineMongo({ uri, collections });
```

### `` defineMongo: database "main" has a collections object with no definition in it: pass the module, as in `import * as collections` ``

**When:** calling `defineMongo`.

**Why:** the object holds no value that looks like a `defineCollection` —
usually a module of *types* only, a default export, or a barrel whose files
export builders rather than definitions.

**Fix:**

```ts
// src/models/index.ts
export * from './users.model';   // `export const users = defineCollection(…)`
export * from './posts.model';

// src/db.ts
import * as collections from './models';
defineMongo({ uri, collections });
```

Anything in that module that is not a definition — a function, a constant, a
type — is left out of the scope rather than refused.

### `defineMongo: database "main" wires "users" and "people" to the same collection, "users"`

**When:** calling `defineMongo`.

**Why:** two exports carry definitions with the same `name`, so two keys on
`mongo.db` would write to one server collection with two schemas and two sets of
options. Usually a copy-and-pasted model whose `name` was not changed.

**Fix:**

```ts
export const people = defineCollection({ name: 'people', schema });
//                                       ^ one `name` per collection
```

### `defineMongo: database "main" has "session" in options, which the wiring decides: …`

The full message names what to use instead:

```text
defineMongo: database "main" has "session" in options, which the wiring decides:
a database is named by its key, `as` and `withSession` carry the actor and the
session, and `autoSync` is the database's
```

The same refusal covers `db`, `actor` and `autoSync`, in `options` and under
`optionsFor` — where the text reads `has "session" in the options of "users"`.

**When:** calling `defineMongo`.

**Why:** those four are the Mongo's. A `session` pinned in the config would
outrank the one a transaction hands the collection, and the write would land
outside the transaction.

**Fix:**

```ts
const mongo = await openMongo(config);
await mongo.transaction(async (tx) => {   // the session is the Mongo's
	await tx.db.users.create({ email: 'ada@example.com' });
});
```

`autoSync` belongs to the database, beside `collections`, not to a collection's
options.

### `defineMongo: database "main" has options for "posts", which it does not wire`

**When:** calling `defineMongo`, when the types were bypassed — an `as never`,
a config built at run time, or JavaScript.

**Why:** the same cause as the type error
[above](#posts-is-not-wired-by-this-database-there-are-no-options-for-it):
`optionsFor` names a key `collections` does not export.

**Fix:** write the config as a literal, so the compiler refuses it first:

```ts
export const config = defineMongo({ uri, collections, optionsFor: { users: {} } });
```

### ``defineMongo: databases names none. Give it at least one, as `{ databases: { main: … } }`.``

**When:** calling `defineMongo` with `databases: {}`.

**Why:** the multi-database shape was used and the object came out empty —
typically built from environment variables that were not set.

**Fix:**

```ts
defineMongo({ databases: { main: { uri, collections } } });
```

### `` defineMongo: database "main" has a buckets object with no bucket definition in it: pass the module, as in `import * as buckets` ``

**When:** calling `defineMongo` with a `buckets` that holds no
`defineBucket` — or that is not an object at all.

**Why:** a bucket is told by its shape, and nothing in the object had it.
Usually the collections passed as `buckets` by mistake, a module of types
only, or a default export.

**Fix:**

```ts
// src/files/index.ts
export const avatars = defineBucket({ name: 'avatars' });

// src/db.ts
import * as buckets from './files';
defineMongo({ uri, collections, buckets });
```

Leave `buckets` out when the database has none; an empty object is refused.

### `defineMongo: database "main" wires "users" as both a collection and a bucket: export one of them under another name`

**When:** calling `defineMongo`, when the types were bypassed — an
`as never`, a config built at run time, or JavaScript.

**Why:** the same cause as the
[type error](#users-is-also-a-collection-of-this-database-wire-this-bucket-under-another-key):
two exports would both be `mongo.db.users`. `error.key` is the key.

**Fix:** rename one export, as above.

### `defineMongo: database "main" wires "avatars" and "pictures" to the same bucket, "avatars"`

**When:** calling `defineMongo`.

**Why:** two exports carry buckets with the same `name`, so two keys on
`mongo.db` would write to one pair of server collections, `avatars.files` and
`avatars.chunks`, perhaps with two metadata schemas. Usually a
copy-and-pasted `defineBucket` whose `name` was not changed.

**Fix:**

```ts
export const pictures = defineBucket({ name: 'pictures' });
//                                     ^ one `name` per bucket
```

### `defineMongo: database "main" has "session" in bucketOptions, which the wiring decides: …`

The full message:

```text
defineMongo: database "main" has "session" in bucketOptions, which the Mongo
decides: `withSession` and transactions carry the session, and `autoSync` is
the database's
```

It reads `has "autoSync" in bucketOptions` for the other one.

**When:** calling `defineMongo`, when the types were bypassed.

**Why:** the same cause as the
[type error](#autosync-is-the-wirings-to-decide-withsession-and-transactions-carry-the-session-and-autosync-is-the-databases):
a session pinned for every bucket would put file writes outside the
transaction around them.

**Fix:** take it out, and set `autoSync` on the database beside
`collections` if you want it.

### `defineMongo: database "main" has bucketOptions but no buckets: pass the buckets they are for, or leave them out`

**When:** calling `defineMongo`, when the types were bypassed.

**Why:** the same cause as the
[type error](#this-database-wires-no-buckets-there-are-no-bucket-options-to-give):
options with no bucket to apply to, which would otherwise do nothing without
a word — as `optionsFor` under a key nothing is wired under is refused.

**Fix:**

```ts
defineMongo({ uri, collections, buckets, bucketOptions: { hash: false } });
```


### `openMongo: database "main" wires a collection under "command", which is a member of the driver's Db: it would be unreachable. Export that definition under another name.`

**When:** `await openMongo(config)`, and the connections opened before it are
given back before it throws.

**Why:** the same collision as the
[type error](#command-is-a-member-of-the-drivers-db-wire-this-collection-under-another-key),
asked of the live `Db` object rather than of its type. A `WiringError` with
`code: 'COLLISION'`, carrying the `database` and the `key` it refused. It
fires when the types were bypassed, and when a driver release adds a member
your key already uses.

**Fix:** rename the export, as above. If the driver added the member, raising
`mongodb` is what surfaced it — the check is deliberate, not a regression.

### `openMongo: database "main" wires a bucket under "watch", which is a member of the driver's Db: it would be unreachable. Export that definition under another name.`

**When:** `await openMongo(config)`, with the connections opened before it
given back.

**Why:** the bucket form of the collision above, asked of the live `Db`:
the types refuse it
[where the config is written](#watch-is-a-member-of-the-drivers-db-wire-this-bucket-under-another-key),
and this catches the config that bypassed them, or a member a later driver
adds. `code: 'COLLISION'`, with the `database` and the `key`.
`defineMongo` cannot ask it: it has no `Db` until `openMongo` connects.

**Fix:** rename the export.

```ts
export const watchClips = defineBucket({ name: 'watch' });
```

### `Bucket "avatars" has no files_id_1_n_1 on "avatars.chunks": every read scans the whole collection, and the cost grows with the bucket rather than with the file. Call syncIndexes() at start-up, or bind with autoSync.`

Printed as a process warning, not thrown:

```text
(node:4242) [NxgtGridFSMissingIndex] Warning: Bucket "avatars" has no files_id_1_n_1 on "avatars.chunks": …
```

**When:** the first read of a file from a bucket whose chunk index is not
there, once per database and bucket for the life of the process. The read
itself works.

**Why:** nothing creates a bucket's indexes until something is asked to, and
`mongo.sync()` does not: it syncs collection definitions. Without
`files_id_1_n_1`, reading one file examines every chunk of the bucket. The
warning comes from `@nxgt/mongo/gridfs`, which is why it names that package's
`syncIndexes()`; on the Mongo the call is `syncBuckets()`.

**Fix:** create the indexes at start-up, beside `sync()`:

```ts
await mongo.sync();
await mongo.syncBuckets();
```

In tests and development, the database's `autoSync: true` does it before
each bucket's first call instead — mind its
[transaction caveat](guide/wiring/files.md#autosync-and-the-first-upload-in-a-transaction).
To act on the warning rather than read it, listen for its code:

```ts
process.on('warning', (warning) => {
	if ((warning as { code?: string }).code === 'NxgtGridFSMissingIndex') {
		log.warn(warning.message);
	}
});
```

### `MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017`

**When:** `await openMongo(config)` — never at `defineMongo`.

**Why:** `defineMongo` connects to nothing; `openMongo` is the one call that
opens clients. A wrong URI, a server that is not up, or an unreachable host
therefore fails at start-up, not at the first query.

**Fix:** check the connection where the application starts, and let it fail
there:

```ts
export const mongo = await openMongo(config);   // top level: a bad URI stops the boot
```

### `ping: no answer in 2000ms`

**When:** the `error` of a `{ ok: false }` that `mongo.ping()` reported, never
a throw. A health route that used to hang for 30 s right after a failover
answers with this instead, within `timeoutMS` and a 250 ms grace.

**Why:** the database did not answer within `timeoutMS` plus a 250 ms grace,
and the driver's own `MongoOperationTimeoutError` did not come first. The
`ping` races a timer of its own because `timeoutMS` does not bound server
selection, which waits `serverSelectionTimeoutMS` (30 s by default): a client
handed over unconnected makes its connect on the first command, and a
connected client that has just lost its server makes its second ping wait the
same way (measured on mongodb 7.6.0). A server that is merely too slow still
reports `MongoOperationTimeoutError`.

**Fix:** answer 503 and look at the server. If the database is a `client` you
handed over, connect it before `openMongo`:

```ts
const client = await new MongoClient(uri).connect();
```

### `MongoTopologyClosedError: Topology is closed`

**When:** every command on a database the configuration gave a `client`, and
every `ping` of it, after one failure — at once, with no retry.

**Why:** the client was handed over unconnected, its first command made the
connect, and the connect failed. Measured on mongodb 7.6.0, the driver then
closes that client for good, so the server coming back changes nothing.

**Fix:** connect the client yourself before handing it over, so a server that
is down fails where the application starts, and a client that connected
reconnects on its own afterwards:

```ts
const client = await new MongoClient(uri).connect();
export const mongo = await openMongo(defineMongo({ client, collections }));
```

### `connectMongo: this URI is already connected with other options. Pass the same options everywhere, or close the first connection.`

**When:** `openMongo`, or a second `openMongo` in the same process.

**Why:** `@nxgt/mongo` shares one client per URI, and a shared client can only
have one set of options. Two databases on one URI with different
`clientOptions` — or a test that builds a second Mongo with other options —
ask for two.

**Fix:** give the same options on that URI, and name the databases instead:

```ts
defineMongo({
	databases: {
		main: { uri, database: 'main', collections },
		analytics: { uri, database: 'analytics', collections: events },
	},
});
```

Both databases then share the one client, which is the point.

### ``db: this Mongo has several databases. Read the one you mean, as `mongo.databases.main`.``

**When:** reading `mongo.db` on a Mongo built from a `databases` config.

**Why:** `db` is the sole database's scope. With several there is no sole one,
so its type is already `never` — this is what a cast or a JavaScript call-site
gets at run time. `code: 'SEVERAL_DATABASES'`.

**Fix:**

```ts
await mongo.databases.main.users.create({ email: 'ada@example.com' });
```

### `No database "reporting" in this Mongo: it has "main", "analytics".`

**When:** `transaction(fn, { on })` with a name the config does not hold.

**Why:** the names are the keys of `databases` in the config, nothing else —
not the database names on the server. `code: 'NO_DATABASE'`, with the name
that was asked for as `error.database`. (Reading `mongo.databases.<name>` for a
name that is not there does not throw: it does not compile, and gives
`undefined` where the types were bypassed.)

**Fix:**

```ts
await mongo.transaction(fn, { on: 'main' });   // a key of `config.databases`
```

### ``close: this Mongo came from `as`, `withSession` or a transaction. Close the one `openMongo` returned — the clients are shared.``

**When:** `close()` — including the implicit one of `await using` — on a Mongo
that came from `as`, `withSession`, or the one handed to a transaction body.

**Why:** a derived Mongo shares the databases and the clients of the Mongo
`openMongo` returned. Closing it would take the connections from every other
Mongo derived from the same root. `code: 'DERIVED'`.

**Fix:** keep `await using` for the root, and let the derived ones fall away:

```ts
await using mongo = await openMongo(config);   // the only one to close
const actor = mongo.as(userId);                // no close, nothing to give back
```

### `not authorized on app to execute command { collMod: "users", … }`

**When:** `mongo.sync()`, or the first operation of a collection when
`autoSync: true`.

**Why:** applying a `$jsonSchema` validator and the collection options is
`collMod`, which needs `dbAdmin`; `readWrite` alone is enough for the indexes
and every data operation but not for that.

**Fix:** run `sync()` as a deployment step, with a user that has `dbAdmin`, and
leave the application's own user on `readWrite`:

```ts
// scripts/sync.ts — run with the migration user, not the app's
await using mongo = await openMongo(config);
await mongo.sync();
```

`autoSync` is for tests and development for the same reason.


### ``transaction: this Mongo holds more than one client, and a transaction lives on one. Name the database it runs on, as `{ on: 'main' }`.``

**When:** `mongo.transaction(fn)` on a Mongo whose databases are on more than one
client.

**Why:** a transaction lives on a single client, and the types cannot decide:
two databases on one URI share a client and need no `on`, so what matters is
the number of *clients*, which is known only once they are open.
`code: 'TRANSACTION'`.

**Fix:**

```ts
await mongo.transaction((tx) => tx.databases.main.users.create(user), { on: 'main' });
```

### ``transaction: this Mongo is already in a session, which this call joins, so `on` has no client left to choose.``

**When:** `transaction({ on })` inside a transaction body, or on a Mongo from
`withSession`.

**Why:** a nested transaction **joins** the outer one rather than opening a
second beside it, so it runs on the session that is already open — there is no
client left to pick. `code: 'TRANSACTION'`, as above.

**Fix:**

```ts
await mongo.transaction(async (tx) => {
	await service(tx);            // its own `tx.transaction(fn)` joins this one
}, { on: 'main' });               // `on` belongs to the outermost call
```

### `ClientSession must be from the same MongoClient`

A `MongoInvalidArgumentError`, from the driver.

**When:** inside a transaction body, touching a database that is on another
client than the one the transaction runs on.

**Why:** a transaction reaches the databases of **one** client. With
`{ on: 'main' }`, an operation on a database of a second client carries a
session that client does not own, and the driver refuses it.

**Fix:** put the two databases on one client, or write two transactions and
accept that they do not commit together:

```ts
await mongo.transaction((tx) => tx.databases.main.users.create(user), { on: 'main' });
await mongo.databases.analytics.events.create({ kind: 'signup' }); // outside it
```


`discoverCollections` is for scripts run from the repository: it reads a glob
from the file system, gives no types, and does not survive bundling. What it
refuses is a `WiringError` with `code: 'DISCOVERY'`, and the path it was reading
as `error.key`.

### `ReferenceError: Bun is not defined`

**When:** calling `discoverCollections` from a script run by Node.

**Why:** the glob is `Bun.Glob`. This one function needs the Bun runtime;
everything else in the package runs anywhere.

**Fix:** run the script with Bun, or wire the collections statically — which is
what an application does anyway:

```ts
import * as collections from './models';    // a bundler follows this, Bun.Glob is not needed
```

### `discoverCollections: a glob is required`

**When:** running the script, with `glob` empty or absent — typically an
argument the script was not given, or an environment variable that is unset.

**Why:** the glob is the only thing that says which files to read. An empty
one matches nothing, and a discovery that came back empty would sync no
collection at all without saying so, so it is refused instead.

**Fix:** give the option a default the script can run with:

```ts
const glob = process.argv[2] ?? 'src/models/*.model.ts';
const definitions = await discoverCollections({ glob });
```

### `discoverCollections: src/models/one.model.ts and src/models/two.model.ts both define the collection "twice"`

**When:** running the script, while reading the files the glob matched.

**Why:** two matched files export definitions with the same collection `name`.
A sync driven from them would apply two schemas to one server collection.

**Fix:** give each collection its own `name`, or narrow the glob so only the
files you mean are read:

```ts
await discoverCollections({ glob: 'src/models/*.model.ts' });
```

### `discoverCollections: src/models/notes.ts exports no definition named "definition"`

**When:** running the script with the `export` option set.

**Why:** `export` names the single export to read in each matched file, and one
of them does not have it — or has it under that name holding something that is
not a definition.

**Fix:** drop the option and let every definition in each file be read, which
is what `import * as collections` gives:

```ts
await discoverCollections({ glob: 'src/models/*.model.ts' });
```
