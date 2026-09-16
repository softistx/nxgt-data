# @nxgt/mongo

A typed MongoDB collection, from one Zod schema: the schema types every read
and write, and the same schema becomes the collection's `$jsonSchema`
validator, applied idempotently. On top of it, a collection with pagination,
transactions, optimistic locking, soft delete, audit stamps, and MongoDB's
errors turned into ones you can catch.

It wraps the official `mongodb` driver, which stays a peer dependency — and it
does not hide it: the driver's own methods are on the very same object, so
`aggregate`, `watch` and `bulkWrite` are always at hand.

## Install

```sh
bun add @nxgt/mongo mongodb zod
```

`mongodb` (>=7) and `zod` (>=4.6.5) are peer dependencies, so your application
decides their versions and there is only ever one copy of each.

## Setup

```ts
import { MongoClient } from 'mongodb';
import { defineCollection, id } from '@nxgt/mongo';
import { z } from 'zod';

export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.email(),
		name: z.string().nullable().default(null),
		loginCount: z.int().default(0),
	}),
	timestamps: true,
	softDelete: true,
	optimisticLock: true,
	actors: true,
	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
});

const client = await MongoClient.connect(process.env.MONGO_URL);
const db = client.db('app');
```

## Definition

`defineCollection` takes the collection's name, the Zod schema of its
documents, its indexes, and how its validator is applied.

An index is keyed on the schema's own fields, so an editor completes them and a
typo does not compile. A path into a field is allowed too, since that is how
MongoDB indexes a nested key. Everything else is the driver's own
`IndexDescription` — `unique`, `name`, `collation`, `expireAfterSeconds`,
`partialFilterExpression`:

```ts
indexes: [
	{ key: { email: 1 }, unique: true, name: 'users_email_unique' },
	{ key: { createdAt: -1 } },
	{ key: { 'address.city': 1 } },
	// @ts-expect-error there is no such field
	{ key: { emial: 1 } },
]
```

The schema is the one source of truth. `z.output` is what a read gives back,
`z.input` what a write takes: a field with a default — `_id`, `createdAt`,
`version` — is optional to write and always there once read.

### Stamps

Four options add fields to the schema and turn the behaviour that reads them
on. They are options rather than fields you spread in, because a field on its
own is only a field: adding `deletedAt` by hand never made `delete` soft.

| option | fields | what the collection does with them |
| --- | --- | --- |
| `timestamps` | `createdAt`, `updatedAt` | sets `updatedAt` on every update |
| `softDelete` | `deletedAt` | `delete` sets it, reads leave those documents out |
| `optimisticLock` | `version` | raised on every update; `expectedVersion` checks it |
| `actors` | `createdBy`, `updatedBy`, `deletedBy` | stamped from `collection.as(actor)` |

Each one reads the same way: `true` for its fields under their default names,
`false` or absent for none, or an object naming them one by one. **Inside that
object an absent key means on, under its default name**; only `false` turns a
field off.

```ts
defineCollection({
	name: 'tickets',
	schema: z.object({ _id: id(), subject: z.string() }),
	timestamps: { createdAt: 'openedAt' },   // updatedAt keeps its name
	softDelete: { deletedAt: 'removedAt' },
	optimisticLock: { version: 'revision' },
	actors: { type: z.string(), createdBy: 'openedBy', deletedBy: false },
});
```

The name follows everywhere: the document's TypeScript type, the `$jsonSchema`
validator, the field `delete` writes, the field a read filters on, and the
fields an index may be keyed on. Nothing in the package spells a stamp's name
out, which is what makes a rename true rather than cosmetic.

`actors.type` is the actor's own Zod type — `z.string()`, a branded id, an
`objectId()` by default — and it is what `collection.as(actor)` takes.

The single-field builders are still there for a field with **no** behaviour
attached: `timestampField()`, `deletedAtField()`, `versionField()`,
`actorFieldOf(type)`, plus `id()` and `objectId()`.

### MongoDB's own collection options

`options` is what MongoDB is given when the collection is created, keyed on the
schema's fields where it names one:

```ts
defineCollection({
	name: 'readings',
	schema: z.object({ _id: id(), at: z.date(), sensor: z.string(), value: z.number() }),
	options: {
		timeseries: { timeField: 'at', metaField: 'sensor' },
		expireAfterSeconds: 7 * 24 * 3600,
	},
});

defineCollection({
	name: 'audit',
	schema: z.object({ _id: id(), message: z.string() }),
	options: { capped: { size: 64 * 1024, max: 1000 } },
});
```

`capped` is one object rather than MongoDB's three sibling keys, because the
server refuses `capped` without a `size`: here that is a compile error.
`collation`, `clusteredIndex` and `changeStreamPreAndPostImages` are the
driver's own.

A time-series collection gets **no validator**: MongoDB answers `'timeseries'
is not allowed with 'validator'`. The default turns itself off there, and
asking for one anyway throws where the definition is written rather than hours
later against a server.

## Sync

`sync` creates the collection with its validator, writes the validator when it
changed, creates the indexes that are missing, and rebuilds those whose options
changed. Run it twice and the second run sends nothing.

```ts
import { syncCollections } from '@nxgt/mongo';

const reports = await syncCollections(db, [users, teams]);
// [{ name: 'users', created: true, validator: 'created',
//    indexes: { created: ['users_email_unique'], recreated: [], dropped: [], unchanged: [] } }]

// What a deploy would do, without doing it:
await syncCollections(db, [users, teams], { dryRun: true });
```

It is a deployment step, not a request-time one: writing a validator runs
`collMod`, which needs the `dbAdmin` role that an application's own user does
not have, and neither it nor an index build may run inside a transaction.

`validation: { level: 'off' }` writes no validator at all, and removes one that
is already there. `{ action: 'warn' }` logs a document that fails instead of
refusing it, which is how a validator is rolled out onto a collection that is
already full.

### Every collection at once

Defining a collection registers it, so `syncAll` needs no list anyone has to
keep up to date — importing the module that defines a collection is what puts
it in:

```ts
import { syncAll } from '@nxgt/mongo';
import './collections';            // the definitions

const reports = await syncAll(db);
```

It covers every definition the process has loaded. When one process holds the
collections of several databases, sync each database's own list with
`syncCollections(db, [users, teams])` instead.

### Options MongoDB cannot change

Most collection options are decided once. `sync` changes the few `collMod`
accepts — `capped.size`, `capped.max`, `expireAfterSeconds`, a time series'
granularity and bucket spans, `changeStreamPreAndPostImages` — and **throws**
on the rest, naming the option, what the collection has and what the definition
asks for:

```
sync: "logs" already exists with options MongoDB cannot change:
  capped: the collection has null, the definition asks for true
```

Making an existing collection capped, its collation and its clustered index are
among those. `dryRun: true` lists every difference at once instead of throwing
on the first.

Only what the definition actually asks for is compared, which is also why a
sync of an unchanged collection sends nothing: MongoDB fills its own defaults
in — a `collation: { locale: 'fr' }` comes back with eleven keys and a
`version` — and comparing those for equality would report a difference every
single time.

### Syncing from the collection, for tests and development

`autoSync` syncs once per database, before the first operation:

```ts
const collection = getCollection(db, users, { autoSync: true });
await collection.create({ email: 'ada@example.com' });   // the collection is there
```

It is **not** for production: `collMod` needs `dbAdmin`, and neither it nor an
index build may run in a transaction. Only this package's own methods wait for
it — `raw` and the driver's own methods are the escape hatch, and the escape
hatch is not managed. A test that drops its database between cases calls
`resetAutoSync(db)` alongside, or the next case would think a collection it can
no longer see is still in shape.

## Documents

```ts
import { getCollection } from '@nxgt/mongo';

const collection = getCollection(db, users);   // a Db, or a MongoClient

const ada = await collection.create({ email: 'ada@example.com' });
// → { _id: ObjectId, id: '507f…', email, name: null, createdAt: Date, version: 0, … }

await collection.findById(ada._id);            // the document, or undefined
await collection.getById(ada._id);             // or NotFoundError
await collection.findFirst({ email: 'ada@example.com' });
await collection.findMany({ filter: { name: null }, sort: { createdAt: -1 }, limit: 10 });
await collection.count({ name: null });
await collection.exists({ email: 'ada@example.com' });

await collection.update(ada._id, { name: 'Ada' });             // checked field by field
await collection.update(ada._id, { $inc: { loginCount: 1 } }); // MongoDB's operators too
await collection.updateMany({ name: null }, { name: 'unknown' });

await collection.delete(ada._id);       // soft, on a schema with deletedAt
await collection.restore(ada._id);
await collection.hardDelete(ada._id);   // really gone
```

**The driver's collection is the same object.** Everything this package does
not wrap is on it directly — no `.collection` to go through:

```ts
await collection.aggregate([{ $group: { _id: '$teamId', n: { $sum: 1 } } }]).toArray();
collection.watch();
await collection.distinct('email');
await collection.bulkWrite([…]);
collection.collectionName;   // 'users'
```

Three names are defined by both, and this package's win, because a filter that
came out empty must not rewrite a collection: `count`, `updateMany` and
`deleteMany` return a number and require a filter. The driver's own are on
`raw`, which is its `Collection`, untouched:

```ts
await collection.updateMany({ name: null }, { name: 'x' });      // → number
await collection.raw.updateMany({}, { $set: { name: 'x' } });    // → UpdateResult
```

`raw` is also the way out for an update operator this package does not name.

`create` checks the document against the schema before sending it, which is
also what fills its defaults. `update` checks each field of a patch — the
driver's own `UpdateFilter` is intersected with `Document` and accepts any key
whatsoever, including a typo.

## Ids

Every document a repository gives back carries `id`: its `_id` as a string. It
is computed, never stored — the collection holds `_id` alone — and it is an
ordinary enumerable property, so `JSON.stringify` and a spread carry it and a
handler can return the document as it is.

Because it is not a stored field, nothing can be filtered or patched on it: the
server would match nothing, and TypeScript refuses it. To go the other way,
from a string that arrived over HTTP:

```ts
import { toObjectId, tryObjectId, isValidObjectId, objectIdParam } from '@nxgt/mongo';

await repo.getById(toObjectId(params.id));   // an ObjectId, or InvalidIdError
tryObjectId(params.id);                      // an ObjectId, or undefined
isValidObjectId(params.id);                  // a boolean
toObjectIds(query.ids);                      // for a `$in` filter

// Or as part of a schema, where the parameters are parsed:
const route = z.object({ id: objectIdParam() });
const { id } = route.parse(params);          // ObjectId
```

**Do not call `new ObjectId(value)` on input you did not produce.** Given
`null` or `undefined` the driver does not throw: it invents a fresh id, so a
parameter that never arrived becomes a perfectly valid id that matches nothing.
`toObjectId` throws `InvalidIdError`, which a handler can turn into a 400 or a
404.

## Hooks

Hooks run around this package's writes, typed by the collection's schema:

```ts
const collection = getCollection(db, users, {
	hooks: {
		beforeCreate: ({ values }) => ({
			values: { ...values, email: values.email.toLowerCase() },
		}),
		afterDelete: async (user, { hard, actor, session, collection }) => {
			await collection.db
				.collection('audit')
				.insertOne({ user: user._id, hard, actor }, { session });
		},
	},
});
```

| hooks | around | `before` gets and may return | `after` gets |
| --- | --- | --- | --- |
| `beforeCreate`, `afterCreate` | `create`, and each document of `createMany` | `{ values }` | the document |
| `beforeUpdate`, `afterUpdate` | `update` | `{ id, patch }` | the document |
| `beforeUpdateMany`, `afterUpdateMany` | `updateMany` | `{ filter, patch }` | the count |
| `beforeDelete`, `afterDelete` | `delete`, `hardDelete` | `{ id }` | the document |
| `beforeDeleteMany`, `afterDeleteMany` | `deleteMany`, `hardDeleteMany` | `{ filter }` | the count |
| `beforeRestore`, `afterRestore` | `restore`, on a collection that soft deletes | `{ id }` | the document |

- A `before` hook that returns a value of the same shape **replaces** what is
  written — a filled field, a narrower filter. Returning nothing keeps it.
  Throwing stops the write.
- An `after` hook gets the result, with the arguments beside the context. The
  write has happened: throwing rejects the call and undoes nothing, unless the
  write ran in a transaction.
- Every hook gets `operation`, `collection` — the one the write runs on,
  session and actor included — `session` and `actor`. The delete hooks also
  get `hard`, which is `true` for a hard delete and for a `delete` on a
  collection that does not soft delete.
- `hooks` takes an array too: each set runs in order, and every `before` sees
  what the previous one returned. A set typed as `CollectionHooks<typeof users>`
  can be written once and shared.
- `withSession` and `as` keep the hooks. Reads, and the driver's own methods,
  run none.

## Change streams

`onChange` listens to a collection's changes, typed by its schema, in this
package's words: a soft delete is a `delete`, not an update that set a date.

```ts
const subscription = users.onChange(
	async (change) => {
		switch (change.type) {
			case 'create':  await welcome(change.document.email); break;
			case 'update':  await reindex(change.document);       break;
			case 'delete':  await forget(change.id, change.hard);  break;
			case 'restore': await reindex(change.document);       break;
		}
	},
	{ events: ['create', 'delete'], filter: { age: { $gte: 18 } } },
);
await subscription.ready;          // a change made from here on is heard;
                                   // rejects if it failed before opening
// …
await subscription.close();        // or `await using subscription = …`
```

| change | carries |
| --- | --- |
| `create` | `document` |
| `update` | `document` (`undefined` if deleted since), `before`, `fields: { set, removed }` — `undefined` for a replacement |
| `delete` | `hard`, `document` after a soft delete, `before` |
| `restore` | `document`, `before` — only on a collection that soft deletes |

Every change also has `id`, `at` and `resumeToken`.

- **One change at a time.** The next is handed over once the handler's
  promise settles, so the order is the server's.
- **The document is the one after the change** when the collection keeps
  post-images (`options: { changeStreamPreAndPostImages: { enabled: true } }`),
  and the document **as it is now** otherwise — a later write may already be
  in it. `before` is there only with pre-images.
- **`filter`** is a filter on the documents, matched against the one after the
  change. It takes field conditions, `$and`, `$or` and `$nor`; any other
  top-level operator is refused, since it would read the event rather than the
  document.
- **Updates to soft-deleted documents** are left out, like every read, unless
  `withDeleted: true`. The soft delete and the restore always come through.
- **A delete or a restore is a change of the soft-delete stamp.** With
  pre-images, the stamp before and after is compared: stamping a deleted
  document again is an update. Without them the event alone decides — see the
  pitfalls.
- **It keeps going.** The driver resumes on its own after a dropped
  connection. When it gives up, the stream is reopened from the last token it
  held — nothing is missed while the process is up — up to `retries` times in
  a row (default 5, with a pause that doubles from 100 ms to 10 s). A history
  the server no longer has, or a user who may not read, is not retried.
- **Errors.** A handler that throws, or a stream that fails for good, goes to
  `onError`; the stream goes on after a handler's error. Without `onError`,
  the first error closes the subscription and rejects `closed`.
- **A restarted process starts from now.** Keep a change's `resumeToken`
  somewhere durable and pass it back as `startAfter` to pick up where it was.
  It is typed `ResumeToken`, so an id is not taken for one; a token read back
  from storage is `saved as ResumeToken`. A token the server refuses fails
  at once rather than being retried.
- A dropped or renamed collection ends the subscription: `closed` resolves
  with `'invalidated'`.

## Pagination

```ts
const page = await repo.paginate({ filter: { name: null }, page: 2, pageSize: 20 });
// { items, total, page, pageSize, pageCount }

let after: string | null = null;
do {
	const page = await repo.paginateByCursor({ after, limit: 100, orderBy: 'createdAt', direction: 'desc' });
	send(page.items);
	after = page.nextCursor;
} while (after);
```

The cursor is a keyset on the field and `_id`, which breaks its ties: no
document is repeated or skipped while the collection is written to, where
`skip` would do both. It is opaque and URL-safe, and it survives `ObjectId`,
`Date` and `bigint` values. It is encoded, not signed.

## Transactions

```ts
import { withTransaction } from '@nxgt/mongo';

await withTransaction(client, async (session) => {
	const team = await teams.withSession(session).create({ name: 'Core' });
	await users.withSession(session).update(userId, { teamId: team._id });
});
```

**Every operation has to be given the session.** MongoDB has no ambient
session: a write that was not given one runs outside the transaction and is not
rolled back with it. `collection.withSession(session)` is how a collection
takes it, and it returns a new collection rather than changing the one you
have.

`withSession` binds **this package's** methods. A driver method on the same
object — `aggregate`, `bulkWrite`, `countDocuments` — takes its session the
driver's way, in its options: `collection.aggregate(pipeline, { session })`.

Given a session that is already in a transaction, `withTransaction` joins it.
MongoDB has no savepoints, so an inner failure takes the whole transaction
down.

## Optimistic locking

With `optimisticLock`, every update raises the version field. Pass the
version you read and the update only applies while the document is still that
one:

```ts
const user = await repo.getById(id);
try {
	await repo.update(id, { name: 'Ada' }, { expectedVersion: user.version });
} catch (error) {
	if (error instanceof OptimisticLockError) {
		// error.expectedVersion, error.actualVersion: someone else wrote first
	}
}
```

## Errors

Every method turns a MongoDB error into one of this package's, so an
application never reads a numeric code:

| error | `code` | when |
| --- | --- | --- |
| `NotFoundError` | `NOT_FOUND` | a method by `_id` matched nothing |
| `ConflictError` | `CONFLICT` | a unique index refused the write (`E11000`) |
| `ValidationError` | `VALIDATION` | the collection's validator refused it (121) |
| `OptimisticLockError` | `OPTIMISTIC_LOCK` | `expectedVersion` no longer matches |
| `InvalidCursorError` | `INVALID_CURSOR` | a cursor this package did not write |
| `InvalidIdError` | `INVALID_ID` | a value that is no `ObjectId`, nor the string of one |
| `DataError` | `DATABASE` | any other server error, with its `serverCode` |

`ConflictError` carries `index`, `keys` and, when the server gives them,
`values`. `ValidationError` carries `issues`, MongoDB's `errInfo` flattened
into `{ path, reason, specifiedAs, consideredValue }`. Anything that is not a
server error reaches you untouched.

## Connecting

```ts
import { closeMongo, connectMongo, getCollection } from '@nxgt/mongo';

const mongo = await connectMongo('mongodb://db.internal:27017/app', { appName: 'api' });
const users = getCollection(mongo.db, usersDefinition);

app.get('/health', async () => mongo.ping({ timeoutMS: 500 }));
// { ok: true, latencyMs: 1.2 } — or { ok: false, error }, never a throw

process.on('SIGTERM', () => closeMongo());   // yours to wire
```

- **One client per URI.** Every `connectMongo` with the same URI shares a
  `MongoClient`, connected once even when the calls race. Each call gets its
  own connection; the client closes when the last one is closed, so a module
  that closes its own does not cut the others off. `await using` closes it
  too.
- **Same options everywhere.** A second call with other options for a
  connected URI throws; the message does not repeat the URI, which may hold a
  password.
- **A failed connect is forgotten**, so calling again tries again.
- `closeMongo()` closes every client, whoever still holds one — the end of a
  process or of a test file. Nothing listens to signals for you.
- A `MongoClient` you open yourself works everywhere too: `connectMongo` is a
  convenience, not a requirement.

## Not included

- **No aggregation helpers.** The collection *is* the driver's collection as
  well: `.aggregate()`, `.watch()` and the rest are on it, and `raw` is the
  driver's own, untouched.
- **No migrations.** `sync` brings the schema and the indexes in line; it never
  rewrites a document.

## API

| export | what it is |
| --- | --- |
| `defineCollection(config)` | a collection: name, schema, stamps, options, indexes, validation |
| `id`, `objectId`, `timestampField`, `deletedAtField`, `versionField`, `actorFieldOf` | the field builders |
| `toObjectId`, `toObjectIds`, `tryObjectId`, `objectIdParam` | a string from outside as an `ObjectId` |
| `isValidObjectId`, `isObjectIdString`, `isObjectId` | the checks behind them |
| `connectMongo(uri, options?)`, `closeMongo()`, `MongoConnection`, `PingResult` | a shared client, closed with its last holder |
| `getCollection(dbOrClient, definition, options?)` | the typed collection, driver methods included |
| `CollectionHooks<Def>` and its pieces | hooks around the writes |
| `ChangeOf<Def>`, `ChangeOptions<Def>`, `ChangeSubscription`, `ResumeToken` | what `onChange` hands over and takes |
| `syncCollection`, `syncCollections`, `syncAll` | create and bring in line, with `dryRun` |
| `registeredCollections`, `clearCollectionRegistry` | what `syncAll` covers |
| `resetAutoSync(db?)` | forget the syncs `autoSync` has run |
| `withTransaction(clientOrSession, fn, options?)` | a transaction, joined when nested |
| `toMongoJsonSchema(schema)` | a Zod schema as a MongoDB `$jsonSchema` |
| `encodeCursor`, `decodeCursor`, `pageWindow`, `toPage` | the pagination pieces |
| `DataError` and its subclasses, `toDataError` | the errors |
| `diffIndexes`, `normalizeIndex`, `validationMatches`, `diffCollectionOptions` | what `sync` compares with |

`CollectionOptions` turns the behaviours off one by one: `softDelete`,
`touchUpdatedAt`, `optimisticLock`, `validate: 'off'`, `maxPageSize`,
`autoSync`, `hooks`, and it names the database with `db` when you pass a client.

## What does not compile

The schema types more than the documents. These are compile errors, each one
kept as a test in `test/types/strictness.ts`:

```ts
await collection.findMany({ sort: { nope: 1 } });        // no such field
await collection.findMany({ sort: { email: 'up' } });    // not a direction
await collection.findMany({ projection: { nope: 1 } });  // no such field
await collection.findMany({ projection: { email: 2 } }); // 0, 1 or an operator
await collection.update(id, { $set: { nope: 1 } });      // no such field
await collection.update(id, { $set: { email: 1 } });     // email is a string
await collection.update(id, { $inc: { email: 1 } });     // not a numeric field
await collection.update(id, { $push: { title: 'x' } });  // not an array field
await collection.update(id, { id: 'abc' });              // id is computed
collection.as('not-an-object-id');                       // the schema types the actor
posts.as(someone);                                       // posts stamp no actor
```

What is **not** checked: the tail of a dotted path, and a `filter`, which stays
the driver's `Filter` — rebuilding it would mean reimplementing every query
operator, and getting it subtly wrong is worse than being honest about it.

## Traps

- **There is no ambient session.** An operation inside `withTransaction` that
  was not given the session is not part of the transaction. Use
  `collection.withSession(session)` for every one of them.
- **A driver method does not take the collection's session.** `withSession`
  binds this package's methods; `collection.aggregate(…)` is the driver's own,
  so it wants `{ session }` in its options like anywhere else. The session is
  on the collection as `collection.session` when you need to pass it along.
- **`estimatedDocumentCount` counts writes that have not committed.** It reads
  the storage engine's metadata rather than the documents, so it is not
  transactional and it is not exact — a document inserted by an open
  transaction is already in its answer. `count` queries, and is the one to
  assert on.
- **`$jsonSchema` is not JSON Schema.** MongoDB rejects `$ref`, `$schema`,
  `default`, `format` and `id`, has no `integer` type, and treats a keyword it
  does not know as an error rather than ignoring it. `toMongoJsonSchema`
  inlines every `$ref` and keeps only what MongoDB knows — so **a recursive
  schema cannot be a validator**, and it throws rather than writing one that
  would be refused.
- **A whole number is not an `int` past 32 bits.** `z.int()` becomes
  `bsonType: ['int', 'long', 'double']` with `multipleOf: 1`, because the
  driver sends a large integer as a double. A validator that asked for `int`
  alone would refuse a number your own schema accepts.
- **The validator is strict about unknown fields.** `z.object()` gives
  `additionalProperties: false`, so a field that is written but not in the
  schema is refused. `z.looseObject()` is the way out.
- **Existing documents are never checked** until they are modified: adding a
  validator to a full collection refuses nothing retroactively, and
  `validationLevel: 'moderate'` keeps it that way for updates too.
- **Writing a validator needs `dbAdmin`.** `collMod` is not granted by
  `readWrite`. Sync with a deployment credential, not the application's.
- **A stamp's name is not `deletedAt`.** It is whatever the option called it,
  and every filter, patch and index is typed against that name — indexing
  `deletedAt` on a collection that renamed it to `removedAt` is a compile
  error, not a silently useless index.
- **A stamp option turns a behaviour on; a field does not.** Declaring
  `deletedAt` in the schema by hand leaves `delete` a real delete. Doing both
  throws: the field would be added twice.
- **A time-series collection cannot have a validator.** MongoDB refuses it at
  creation and refuses the later `collMod` too, so `validation.level` defaults
  to `'off'` there and asking for anything else throws.
- **A hook that writes to its own collection runs the hooks again.**
  `context.collection` is the collection the write runs on, hooks included:
  an `afterCreate` that creates in the same collection recurses. Write
  through `collection.raw`, or another collection, instead.
- **A misspelt field in a `before` hook's answer compiles.** TypeScript does
  not check a returned literal for extra properties, so
  `({ values }) => ({ values: { ...values, emial } })` is accepted, and the
  schema then drops `emial` without a word. The same mistake passed to
  `create` directly is refused.
- **A filter is checked before the hooks run.** `deleteMany({})` is refused
  even when a hook would have narrowed it, and no hook runs for it.
- **An `after` hook is not part of the write.** When it throws, the document
  is already stored. Run the write in `withTransaction`, and write through
  `context.session`, when the two must stand or fall together.
- **Change streams need a replica set.** A standalone `mongod` refuses them;
  a single-node replica set is enough, which is what this package's own specs
  run on.
- **Without post-images, an update's `document` is today's.** It is looked up
  when the change is read, so two quick updates can both arrive with the
  second one's document. Enable `changeStreamPreAndPostImages` when the exact
  state after each change matters.
- **Without pre-images, a hard delete is not filtered.** It carries no
  document to match, so a subscription with a `filter` still hears every
  hard delete. Ignore the ids you never saw, or enable pre-images.
- **Without pre-images, a soft delete is read from the event alone.** An
  update that sets the stamp is a `delete`, even on a document that was
  already deleted; one that clears it is a `restore`, even on one that was
  not. A replacement that leaves the stamp set is a `delete`, and one that
  clears it an `update`: nothing says it was deleted before. Writes through
  this package never meet these cases; the driver's own methods can.
- **`closed` rejects when nobody handles an error.** Like an `error` event
  nobody listens to, that ends the process if nothing awaits it. Pass
  `onError`, or await `closed`.
- **`autoSync` remembers across a dropped database.** The memo is what makes it
  sync once rather than before every call, and `dropDatabase` does not clear
  it. `resetAutoSync(db)` does.
- **A duplicate key from a bulk write carries no values.** MongoDB puts
  `keyPattern` and `keyValue` on a single write's error only; for
  `createMany`, `ConflictError.keys` is parsed out of the message and `values`
  is `undefined`.
- **`updateMany` and `deleteMany` refuse an empty filter.** Pass
  `{ _id: { $exists: true } }` to mean every document, so that a filter built
  from a variable that came out empty cannot rewrite the collection.
- **Rebuilding an index drops it first.** MongoDB cannot alter an index in
  place, so `sync` drops and recreates one whose options changed: there is a
  window with no index, and on a large collection the rebuild is not free.
- **`new ObjectId(undefined)` is a fresh id, not an error.** So is
  `new ObjectId(null)`. A missing route parameter turns into a valid id that
  matches nothing, and the bug surfaces as an empty result rather than as a
  failure. Use `toObjectId`, which throws, or `tryObjectId`, which answers
  `undefined`.
- **`id` is computed, not stored.** It is on every document a repository
  returns, and on none in the collection: a filter or a patch keyed on it would
  match nothing, so both are compile errors. Query on `_id`. A schema that
  declares an `id` field of its own keeps it, untouched.
- **`validate: 'off'` also turns the defaults off.** Nothing fills `_id`,
  `createdAt` or `version` any more, because filling them is what parsing does.
- **The driver retries a transaction's callback** on a transient error, for up
  to 120 seconds, so `fn` must be safe to run twice — and must not swallow
  errors, or the driver cannot tell whether the transaction was aborted.
- **`session.abortTransaction()` inside the callback resolves.**
  `withTransaction` returns the callback's value; it does not throw.

## Testing against a real MongoDB

Transactions need a replica set, which a standalone `mongod` is not. This
package's own specs run against a single-node replica set from
`mongodb-memory-server-core`, with no Docker; the same works in any consumer's
test suite.

## License

MIT
