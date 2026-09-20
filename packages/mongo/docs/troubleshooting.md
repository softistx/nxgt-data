# Troubleshooting

Every method turns a driver error into one of this package's own, so the
heading is usually a `DataError` subclass's message: `ConflictError`,
`ValidationError`, `NotFoundError`, `OptimisticLockError`, `InvalidIdError`,
`InvalidCursorError`, `CorruptFileError`, `MigrationError`,
`MigrationLockedError`. Each carries a `code` you can switch on, and the
driver's error as `cause`. A mistake in a call — a field that is not in the
schema, an option a collection does not have — is a `TypeError` instead:
that is a bug in the code, not data.

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
  - [`update: "users" has no field "emial" in its schema`](#update-users-has-no-field-emial-in-its-schema)
  - [`deleteMany needs a filter. Pass { _id: { $exists: true } } to target every document of "users".`](#deletemany-needs-a-filter-pass--_id--exists-true---to-target-every-document-of-users)
  - [`upsert: "users" cannot upsert on "rank": it is matched rather than given a value`](#upsert-users-cannot-upsert-on-rank-it-is-matched-rather-than-given-a-value)
  - [`restore: "users" has no soft delete`](#restore-users-has-no-soft-delete)
  - [`update: the expected "version" must be a whole number, not 3.5`](#update-the-expected-version-must-be-a-whole-number-not-35)
  - [`upsert: "users" wrote nothing`](#upsert-users-wrote-nothing)
- **Reads, ids and pagination**
  - [`No document in "users" with _id 6721…`](#no-document-in-users-with-_id-6721)
  - [`_id: expected an ObjectId or its 24-character hex string, got the string "nope"`](#_id-expected-an-objectid-or-its-24-character-hex-string-got-the-string-nope)
  - [`Invalid cursor: it cannot be decoded`](#invalid-cursor-it-cannot-be-decoded)
  - [`Invalid cursor: it was written for the ordering createdAt:asc, not _id:asc`](#invalid-cursor-it-was-written-for-the-ordering-createdatasc-not-_idasc)
  - [`paginateByCursor: "createdAt" is null in a document of "users". Page along a field every document has.`](#paginatebycursor-createdat-is-null-in-a-document-of-users-page-along-a-field-every-document-has)
  - [`page must be an integer of at least 1, not 0`](#page-must-be-an-integer-of-at-least-1-not-0)
  - [`Invalid cursor: unexpected shape`](#invalid-cursor-unexpected-shape)
  - [`Invalid cursor: expected 1 value(s), got 2`](#invalid-cursor-expected-1-values-got-2)
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
  - [`Chunk 3 of file 6721… in "avatars" is missing`](#chunk-3-of-file-6721-in-avatars-is-missing)
  - [`File 6721… in "avatars" reads 900 bytes where its chunks should hold 1024: a chunk of it was truncated`](#file-6721-in-avatars-reads-900-bytes-where-its-chunks-should-hold-1024-a-chunk-of-it-was-truncated)
  - [``put: "contentType" and "sha256" are kept by "avatars" itself.``](#put-contenttype-and-sha256-are-kept-by-avatars-itself)
  - [`put: expected a file, a blob, a response, a stream or bytes, not null`](#put-expected-a-file-a-blob-a-response-a-stream-or-bytes-not-null)
  - [`A chunk of this file holds no bytes`](#a-chunk-of-this-file-holds-no-bytes)
  - [`defineBucket: "avatars.small" is not a bucket name.`](#definebucket-avatarssmall-is-not-a-bucket-name)
  - [A read of one file scans the whole chunks collection](#a-read-of-one-file-scans-the-whole-chunks-collection)
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

### `upsert: "users" wrote nothing`

**When:** `upsert`, when the server answered an upsert with no document.
**Why:** MongoDB does not do that — `findOneAndUpdate` with `upsert: true`
and `returnDocument: 'after'` either matches, inserts, or errors. Reaching
this means a bug in this package, or something between the process and the
server rewriting replies. Nothing was stored.
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

### `Invalid cursor: it cannot be decoded`

**When:** `paginateByCursor({ after })` with a cursor this package did not
write — truncated in a URL, or made up.
**Why:** an `InvalidCursorError`, `code: 'INVALID_CURSOR'`: a client's input,
so a 400.
**Fix:**

```ts
import { InvalidCursorError } from '@nxgt/mongo';

if (error instanceof InvalidCursorError) return badRequest('cursor');
```

### `Invalid cursor: it was written for the ordering createdAt:asc, not _id:asc`

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
other order for the same reason.

### `paginateByCursor: "createdAt" is null in a document of "users". Page along a field every document has.`

**When:** paging along a field some documents do not have, or have as `null`.
**Why:** a keyset cannot step past a value that is not there.
**Fix:**

```ts
await users.paginateByCursor({ orderBy: '_id' });
```

### `page must be an integer of at least 1, not 0`

**When:** `paginate({ page })` with `0`, a negative, or a fraction. The same
message names `pageSize` for that option, and `limit` for a cursor page's —
`paginateByCursor({ limit })` and a bucket's `paginate({ limit })` both.
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

### `Invalid cursor: unexpected shape`

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

### `Invalid cursor: expected 1 value(s), got 2`

**When:** paging on with a cursor whose ordering matches the call but whose
number of keyset values does not — a cursor edited by hand, or one from a
build whose `orderBy` meant a different pair of fields.
**Why:** paging on `_id` keeps one value; paging on any other field keeps that
field **and** `_id`, which breaks its ties, so two. A cursor carrying the
wrong count cannot be turned into a keyset condition.
**Fix:**

```ts
const page = await users.paginateByCursor({ orderBy: 'createdAt', direction: 'asc' });
await users.paginateByCursor({ orderBy: 'createdAt', direction: 'asc', after: page.nextCursor });
```

Unlike the two cursor errors above, this one arrives as a plain `DataError`
with `code: 'DATABASE'`, not as an `InvalidCursorError`: a handler that maps
only `InvalidCursorError` to a 400 answers 500 for it. Match on `DataError`
with that message, or carry the ordering with the cursor so it cannot happen.

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

### `Chunk 3 of file 6721… in "avatars" is missing`

**When:** reading the bytes — `text()`, `bytes()`, `stream()`, `serve()` —
never at `get`, which only reads the `files` document.
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

### `put: expected a file, a blob, a response, a stream or bytes, not null`

**When:** `put` or `putOnce` with a source that is none of those — the `null`
a `FormData` field gives when nothing was sent, a plain object, or a string.
**Why:** the source is read as a `File` or `Blob`, a `Response`, a
`ReadableStream`, an async iterable of chunks, or bytes; nothing else can be
turned into chunks. A `TypeError`, since it is a mistake in the call.
**Fix:**

```ts
const field = form.get('avatar');
if (!(field instanceof File)) return badRequest('avatar');
const saved = await files.put(field, { type: field.type });
```

A string is not bytes on purpose: encode it first (`new TextEncoder().encode(text)`).

### `A chunk of this file holds no bytes`

**When:** reading a file — `bytes()`, `text()`, `stream()`, `serve()` — whose
chunk documents hold something other than binary in `data`.
**Why:** a `CorruptFileError`. A chunk written by a GridFS client holds a
`Binary`; a chunk restored from a dump that mapped the field to a string, or
inserted by hand as a fixture, holds something that cannot be read as bytes.
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

### A read of one file scans the whole chunks collection

**When:** any bucket with no indexes: no error, just reads whose cost grows
with the size of the bucket rather than of the file.
**Why:** the driver builds GridFS's two indexes on its first upload, and this
package does not upload through the driver — it writes the chunk documents
itself, which is what lets a file write run in a transaction. `putOnce` is
the one call that creates them anyway, because it elects on the unique
`{ files_id, n }` index.
**Fix:**

```ts
await files.syncIndexes(); // at start-up; or bind the bucket with `autoSync`
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
rather than handing back a dead client.
**Fix:**

```ts
await mongo.close(); // give back one holder; closeMongo() takes every client away
```

`mongo.client.close()` skips the count: the closed client stays shared, and
every later `connectMongo` for that URI gets it, dead, until `closeMongo()`.
