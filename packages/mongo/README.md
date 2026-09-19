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

## Subpaths

| import | what it holds |
| --- | --- |
| `@nxgt/mongo` | everything below, but migrations |
| `@nxgt/mongo/migrations` | [migrations](#migrations): `defineMigration`, `migrate`, `rollback`, `migrationStatus`, `MigrationError`, `MigrationLockedError` |

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
`z.input` what a write takes: a field with a default — `_id`, `createdAt` —
is optional to write and always there once read. The stamps the collection
keeps itself are the exception: see [What a write may say](#what-a-write-may-say).

### Stamps

Four options add fields to the schema and turn the behaviour that reads them
on. They are options rather than fields you spread in, because a field on its
own is only a field: adding `deletedAt` by hand never made `delete` soft.

| option | fields | what the collection does with them |
| --- | --- | --- |
| `timestamps` | `createdAt`, `updatedAt` | sets `updatedAt` on every update |
| `softDelete` | `deletedAt` | `delete` sets it, reads leave those documents out |
| `optimisticLock` | `version` | raised on every update; one given in the patch is checked |
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

#### What a write may say

The collection writes its stamps; a write says only what a caller can know.

| stamp | `create` | `update` | `updateMany` |
| --- | --- | --- | --- |
| `createdAt` | an optional `Date` | refused | refused |
| `updatedAt` | an optional `Date` | an optional `Date` | an optional `Date` |
| `version` | refused | the version expected, optional | refused |
| `deletedAt` | refused | refused | refused |
| `createdBy`, `updatedBy`, `deletedBy` | refused | refused | refused |

A timestamp left out is `new Date()`; one given — an import, a backfill — is
kept. The version in an update's patch is **not written**: it is the version
the document must still be at, under the name the collection gives it, and the
update raises it as every update does. `delete` and `restore` write
`deletedAt`, and `collection.as(actor)` the actors.

```ts
const ticket = await tickets.getById(id);
await tickets.update(id, { subject: 'b', revision: ticket.revision });
```

A refusal is a compile error, through any operator too (`$inc: { version: 1 }`,
`$unset: { deletedAt: '' }`, `$rename: { name: 'deletedAt' }`), and a
`TypeError` at runtime for a caller the types do not reach, before anything is
sent. `updatedAt` may be set but not taken away with `$unset` or `$rename`.
One refusal is runtime only: a version in the patch of a collection opened
with `optimisticLock: false`, since the types see the definition and not the
options. `raw` is the way to set a stamp by hand.

`validate: 'off'` does not parse, so the collection fills the stamps it keeps
itself — the ones a caller can no longer give.

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
await collection.raw.distinct('email');   // `distinct` is this package's
await collection.bulkWrite([…]);
collection.collectionName;   // 'users'
```

Four names are defined by both, and this package's win. `count`, `updateMany`
and `deleteMany` return a number and require a filter, because a filter that
came out empty must not rewrite a collection; `distinct` leaves soft-deleted
documents out, as every read does. The driver's own are on
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
server would match nothing, and TypeScript refuses it.

To go the other way, from a string that arrived over HTTP, the collection reads
it for you — see [Strings from outside](#strings-from-outside). These are for
when you want the refusal **explicit**, so that a malformed id is a 400 of its
own rather than the 404 an id that matches nothing gives:

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

## Strings from outside

A collection converts the strings that arrive from outside on its own, so a
handler parses no ids and no dates before a query. **Which** fields it converts
is read from the schema and never guessed at; **whether** a given string is one
is a shape it checks, and one it does not recognise is handed on untouched:

```ts
await repo.getById(params.id);                    // a 24-hex string is enough
await repo.update(params.id, { title: 'a' });     // so is an id to patch on
await repo.findMany({ filter: { authorId: query.author } });
await repo.findMany({ filter: { createdAt: { $gte: '2026-01-01' } } });
await repo.create({ authorId: body.authorId });   // stored as an ObjectId
await repo.update(id, { $set: { authorId: body.authorId } });
```

The types say the same thing the runtime does: an `ObjectId` field takes
`ObjectId | string`, a `Date` field takes `Date | string`, and every other
field is typed exactly as the schema declares it. `filter: { authorId: 42 }`
is still a compile error, and so is `{ $gte: 1 }` on a date.

| where | from | to |
| --- | --- | --- |
| a field whose schema says `bsonType: 'objectId'` — `objectId()`, `id()`, or your own `.meta()` | a 24-hex string | `ObjectId` |
| a field the schema declares with `z.date()` | `YYYY-MM-DD`, or that with a time **and a zone** | `Date` |
| `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, `$each`, and `$not` over any of them | each value, each element | the same |
| `$and`, `$or`, `$nor`, a nested path (`author.id`) and the `$elemMatch` that names the same thing | | the same |
| the id argument of `findById`, `getById`, `update`, `delete`, `hardDelete`, `restore` | | the same |
| a patch of fields, a patch in operators (`$set`, `$push`, `$min`…), and `onChange`'s filter | | the same |

`optional()`, `nullable()`, `default()` and an array of either are unwrapped to
find the field's kind, so `z.array(objectId()).optional()` converts too.

It is deliberately conservative, because a wrong guess is a query that silently
matches nothing. An id is 24 hexadecimal characters and nothing else. A date is
`2026-01-01`, or `2026-01-01T12:30:00Z` with a zone on it, and nothing else —
`new Date` would read `'5'` as the first of May 2001 in the server's own zone,
`'2026'` as a new year, `'2026-02-31'` as the third of March and
`'2026-01-01T00:00'` as a different instant on every machine. A **number** is
never a date either: `1` would otherwise be 1970. And a field the schema does
not describe is passed on exactly as it came, which leaves `$exists`, `$type`,
`$size`, `$mod`, `$regex` and anything only the driver knows about alone.

**Nothing throws.** A string the collection cannot read is handed on as it is,
so the schema refuses it on a write with its own message, and a read matches
nothing — `getById('nope')` is a `NotFoundError`, not an `InvalidIdError`. A
handler that wants to tell a malformed id from a missing document apart, and
answer 400 rather than 404, still calls `toObjectId` or `objectIdParam` itself.

Three surfaces convert nothing, on purpose: `raw` and the driver's own methods,
which this package does not touch; `collection.as(actor)`, whose actor is
stamped as given — check it with `tryObjectId` where it arrives; and an
aggregation pipeline you write yourself.

`coerce: false` turns it off for one collection, and a string is then sent to
the server as a string, as it was before. The types stay as wide, so with it
off it is on you to pass what the field holds:

```ts
const repo = getCollection(db, users, { coerce: false });
```

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
- **A restarted process starts from now.** Keep a change's `resumeToken`,
  or the subscription's `position`, somewhere durable and pass it back as
  `startAfter` to pick up where it was.
  It is typed `ResumeToken`, so an id is not taken for one; a token read back
  from storage is `saved as ResumeToken`. A token the server refuses fails
  at once rather than being retried.
- **`position` moves while the collection is quiet**, and `resumeToken` does
  not. `resumeToken` is the last change handled; `position` is that, or, after
  a read that brought nothing, the point the server gave — every change up to
  it has been handled either way. A worker that keeps its place recording
  `position` is not sent back to the start of a long silence by a history the
  server has since dropped.
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

With `optimisticLock`, every update raises the version field. Give the
version you read in the patch, under the version field's own name, and the
update only applies while the document is still at it:

```ts
const user = await repo.getById(id);
try {
	await repo.update(id, { name: 'Ada', version: user.version });
} catch (error) {
	if (error instanceof OptimisticLockError) {
		// error.expectedVersion, error.actualVersion: someone else wrote first
	}
}
```

It must be a whole number, and it needs the lock: a collection opened with
`optimisticLock: false` refuses it rather than ignore it — at runtime only, as
the types do not see that option. `updateMany` takes
none — one version cannot stand for many documents.

## Errors

Every method turns a MongoDB error into one of this package's, so an
application never reads a numeric code:

| error | `code` | when |
| --- | --- | --- |
| `NotFoundError` | `NOT_FOUND` | a method by `_id` matched nothing |
| `ConflictError` | `CONFLICT` | a unique index refused the write (`E11000`) |
| `ValidationError` | `VALIDATION` | the collection's validator refused it (121) |
| `OptimisticLockError` | `OPTIMISTIC_LOCK` | the version in the patch no longer matches |
| `InvalidCursorError` | `INVALID_CURSOR` | a cursor this package did not write |
| `InvalidIdError` | `INVALID_ID` | a value that is no `ObjectId`, nor the string of one — raised by `toObjectId`, `toObjectIds` and `objectIdParam`, and by nothing else: the collection's own reading of a string never throws |
| `MigrationError` | `MIGRATION` | a migration failed, or the list does not match the records — from `@nxgt/mongo/migrations` |
| `MigrationLockedError` | `MIGRATION_LOCKED` | another run holds the migration lock, or this one lost it — from `@nxgt/mongo/migrations` |
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

app.get('/health', async () => {
	const result = await mongo.ping({ timeoutMS: 500 });   // never throws
	if (!result.ok) log.warn(result.error);   // the error names the hosts: keep it in
	return { ok: result.ok };
});

process.on('SIGTERM', () => closeMongo());   // yours to wire
```

- **One client per URI.** Every `connectMongo` with the same URI shares a
  `MongoClient`, connected once even when the calls race. Each call gets its
  own connection; the client closes when the last one is closed, so a module
  that closes its own does not cut the others off. `await using` closes it
  too.
- **Same options everywhere.** A second call with other options for a
  connected URI throws; the message does not repeat the URI, which may hold a
  password. Options are compared by value — a `serverApi` built again at each
  call is the same — except functions and class instances, which must be the
  same object. What the first call passed is kept: changing its object
  afterwards changes nothing.
- **A failed connect is forgotten**, so calling again tries again.
- `closeMongo()` closes every client, whoever still holds one — the end of a
  process or of a test file. Nothing listens to signals for you.
- A `MongoClient` you open yourself works everywhere too: `connectMongo` is a
  convenience, not a requirement.

## Migrations

`sync` brings the validator and the indexes in line; a migration is for what it
never does — rewriting documents. They are a list, in code, applied in order
and recorded:

```ts
import { defineMigration, migrate, migrationStatus, rollback } from '@nxgt/mongo/migrations';

export const migrations = [
	defineMigration({
		id: '2026-09-17-posts-by-slug',
		transaction: false,   // an index build cannot run in a transaction
		async up({ db }) {
			await db.collection('posts').createIndex({ slug: 1 }, { name: 'posts_slug' });
		},
		async down({ db }) {
			await db.collection('posts').dropIndex('posts_slug');
		},
	}),
	defineMigration({
		id: '2026-09-18-backfill-slug',
		async up({ db, session }) {
			await db
				.collection('posts')
				.updateMany({ slug: null }, [{ $set: { slug: '$title', slugBackfilled: true } }], { session });
		},
		async down({ db, session }) {
			await db
				.collection('posts')
				.updateMany({ slugBackfilled: true }, { $unset: { slug: '', slugBackfilled: '' } }, { session });
		},
	}),
];

await migrate(db, migrations);                    // { applied: [{ id, durationMs }, …], pending: [] }
await migrate(db, migrations, { dryRun: true });  // { applied: [], pending: ['…'] }
await rollback(db, migrations);                   // undoes 2026-09-18-backfill-slug
await rollback(db, migrations, { to: '2026-09-17-posts-by-slug', dryRun: true });
// { reverted: [], pending: ['2026-09-18-backfill-slug'] }
await migrationStatus(db, migrations);            // [{ id, state: 'applied' | 'pending' | 'missing', appliedAt }]
```

- **The id is permanent.** It is what the migration is recorded under:
  renaming one makes it a new migration. It takes letters, digits, `_`, `-`,
  `.` and `:`; anything else throws when `defineMigration` runs, which is
  usually when the list is imported. The order is the list's, not the ids'.
- **Each migration runs in a transaction**, with its record: it is applied and
  recorded, or neither. That needs a replica set, as every transaction does.
  `session` is that transaction's, and every operation has to be given it.
  `transaction: false` is for what a transaction cannot hold — an index build,
  `collMod`, a dropped collection — and such a migration that fails half-way
  stays half-done; it is not recorded.
- **The list only grows at its end.** `migrate` and `rollback` refuse, before
  running anything, a list that lost an applied migration or has a pending one
  before an applied one. `migrationStatus` reports those two as `missing` and
  `pending` instead. All three refuse a list that names an id twice.
- **`to`** applies up to and including a migration; for `rollback`, it undoes
  everything after it, the last first. Without it, `rollback` undoes the last
  applied migration alone. Either way, a rollback that would reach a migration
  with no `down` is refused as a whole, before anything is undone.
- **A dry run** reports what would run, and neither takes the lock nor creates
  the records' collection.
- **Two runs never migrate at once.** A run holds a lock, a document in
  `<collection>_lock`, renewed every third of `lockTtlMs` while it works and
  timed by the server's clock, so hosts whose clocks disagree still agree. A
  second run fails with `MigrationLockedError`, whose `holder` and `expiresAt`
  say who holds it and until when. A crashed run blocks the next one for
  `lockTtlMs` at most — default 60 000, at least 1000. A run whose lock was
  taken over or removed throws `MigrationLockedError` ("lost its migration
  lock") before its next migration.
- **A failure is a `MigrationError`**: `migration` names it, `cause` holds
  the original error, and the ones before it stay applied.
- The records are in `nxgt_migrations`, one document per migration
  (`{ _id: id, appliedAt, durationMs }`). Another name goes to all three
  calls, the same each time:

```ts
const options = { collection: 'schema_history', lockTtlMs: 5 * 60_000 };
await migrate(db, migrations, options);
await migrationStatus(db, migrations, options);
```

## Aggregation

Three helpers for what comes up most, typed by the schema, soft-deleted
documents left out as every read does (`withDeleted: true` to keep them).
Anything else is `.aggregate()`, which is on the collection too.

```ts
await members.distinct('level');                       // ['junior', 'senior']
await members.distinct('tags', { teamId });            // an array field gives its elements

await orders.groupBy('status', {
	filter: { createdAt: { $gte: monthStart } },
	measures: { total: { sum: 'amount' }, average: { avg: 'amount' }, last: { max: 'createdAt' } },
});
// [{ key: 'paid', count: 12, total: 4310, average: 359.2, last: Date }, …]

const withRelations = await members.populate(await members.findMany(), {
	team: { from: teams, by: 'teamId' },          // a team, or null
	mentors: { from: members, by: 'mentorIds' },  // a list field gives a list, in its order
	mentees: { from: members, on: 'mentorIds' },  // the members that point to this one
});
```

- **`groupBy`** gives each group's `key`, `count` and the measures: `sum` and
  `avg` take numeric fields, `min` and `max` any field. The largest groups
  come first, ties by key; `sort: 'key'` orders by key, and `limit` keeps the
  first ones. Documents without the field are one group, keyed `null`. A
  group whose field is missing everywhere sums to `0` and averages to `null`.
- **`populate`** takes documents you already have — from `findMany`,
  `paginate`, anywhere — and sends **one query per relation**, however many
  documents there are. `by` follows a field of these documents — a list
  field gives a list, `[]` when it is missing, and any other field a document
  or `null`; `on` gathers
  the documents of `from` whose field points back. The related collection
  reads as it always does: its session (pass `withSession(session)` for a
  transaction), its soft delete, and `withDeleted` on the relation. It
  returns copies and leaves your documents alone. Ids are matched by value,
  whatever their type: an `ObjectId`, a date, an embedded document.
- **`distinct`** answers in the server's order, and never `undefined`. It
  takes no collation or hint; `raw.distinct` does.
- A bad measure, `sort` or `limit` rejects with a `TypeError`, as every
  method here rejects rather than throws.

## Not included

- **No aggregation pipeline builder.** The helpers above cover the common
  cases; `.aggregate()` and `raw` are the driver's own, untouched.
- **No migration files or CLI.** Migrations are a list in code, run from a
  script of yours: nothing reads a directory, and there is no binary to
  configure.

## API

| export | what it is |
| --- | --- |
| `defineCollection(config)` | a collection: name, schema, stamps, options, indexes, validation |
| `id`, `objectId`, `timestampField`, `deletedAtField`, `versionField`, `actorFieldOf` | the field builders |
| `toObjectId`, `toObjectIds`, `tryObjectId`, `objectIdParam` | a string from outside as an `ObjectId` |
| `isValidObjectId`, `isObjectIdString`, `isObjectId` | the checks behind them |
| `connectMongo(uri, options?)`, `closeMongo()`, `MongoConnection`, `PingResult` | a shared client, closed with its last holder |
| `FilterOf`, `NewOf` | a filter and a create, with the strings the collection reads allowed in them |
| `NewDocumentOf`, `Patch`, `ManyPatch`, `ExpectedVersion`, `WritableDocumentOf`, `WritableFieldOf`, `WritablePath`, `RemovablePath`, `StampNameOf`, `VersionNameOf`, `SetByCollection`, `FixedOnUpdate` | what a write may say |
| `DistinctOf`, `Group`, `GroupKeyOf`, `GroupByOptions`, `Measure`, `Measures`, `NumericFieldOf`, `Populated`, `Relations`, `ByRelation`, `OnRelation`, `ReferenceFieldOf`, `RelatedCollection` | what `distinct`, `groupBy` and `populate` take and give |
| `getCollection(dbOrClient, definition, options?)` | the typed collection, driver methods included |
| `CollectionHooks<Def>` and its pieces | hooks around the writes |
| `ChangeOf<Def>`, `ChangeOptions<Def>`, `ChangeSubscription` (`ready`, `closed`, `resumeToken`, `position`, `close`), `ResumeToken` | what `onChange` hands over and takes |
| `syncCollection`, `syncCollections`, `syncAll` | create and bring in line, with `dryRun` |
| `registeredCollections`, `clearCollectionRegistry` | what `syncAll` covers |
| `resetAutoSync(db?)` | forget the syncs `autoSync` has run |
| `withTransaction(clientOrSession, fn, options?)` | a transaction, joined when nested |
| `toMongoJsonSchema(schema)` | a Zod schema as a MongoDB `$jsonSchema` |
| `encodeCursor`, `decodeCursor`, `pageWindow`, `toPage` | the pagination pieces |
| `DataError` and its subclasses, `toDataError` | the errors |
| `defineMigration`, `migrate`, `rollback`, `migrationStatus`, `MigrationError`, `MigrationLockedError` | from `@nxgt/mongo/migrations`: migrations, in code |
| `diffIndexes`, `normalizeIndex`, `validationMatches`, `diffCollectionOptions` | what `sync` compares with |

`CollectionOptions` turns the behaviours off one by one: `softDelete`,
`touchUpdatedAt`, `optimisticLock`, `validate: 'off'`, `coerce: false`,
`maxPageSize`, `autoSync`, `hooks`, and it names the database with `db` when
you pass a client.

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
await collection.create({ email, version: 1 });          // the collection keeps it
await collection.create({ email, createdAt: '2024' });   // a timestamp is a Date
await collection.update(id, { createdAt: new Date() });  // fixed once created
await collection.update(id, { $inc: { version: 1 } });   // not through an operator either
await collection.update(id, { deletedAt: null });        // `delete` and `restore`
await tickets.update(id, { version: 3 });                // the version is `revision` there
await collection.updateMany(filter, { version: 3 });     // no expected version for many
collection.as('not-an-object-id');                       // the schema types the actor
posts.as(someone);                                       // posts stamp no actor
await members.groupBy('level', { measures: { n: { sum: 'name' } } });  // not a number
await members.groupBy('level', { measures: { count: { sum: 'score' } } }); // count is taken
await members.populate(found, { team: { from: teams, by: 'name' } });  // not a reference
await members.populate(found, { name: { from: teams, by: 'teamId' } }); // name is a field
await migrate(client, migrations);                       // a Db, not a client
await migrate(db, migrations, { to: backfill });         // `to` is the migration's id
defineMigration({ id: 'x', up: () => {} });              // up is awaited
```

The aggregation cases are in `test/types/aggregation.ts`, the stamp cases in
`test/types/stamp-writes.ts`, the migration cases in `test/types/migrations.ts`.

A migration is refused structurally: an object shaped like one that did not go
through `defineMigration` compiles, and skips its id check.

What is **not** checked: the tail of a dotted path, and a `filter`, which stays
the driver's `Filter` — rebuilding it would mean reimplementing every query
operator, and getting it subtly wrong is worse than being honest about it.

## Traps

- **A document that was read is not a create.** It carries its version, its
  `deletedAt` and its actors, which a create refuses. Take the stamps out
  first, or copy it with `raw`.
- **A version in an update is a condition, not a value.** `{ version: 3 }`
  never sets the version to 3: it makes the update fail unless the document is
  at 3, and the update then leaves it at 4.
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
- **`populate` matches ids by type, not by collection.** Any `ObjectId`
  field can point to any collection keyed by `ObjectId`; the type checks the
  kind of id, and nothing more can. A `by` naming the wrong collection
  compiles and finds nothing.
- **`populate`'s `$in` holds every id at once.** One query per relation is
  the point, but a page of ten thousand documents makes a filter of ten
  thousand ids: page first, then populate.
- **Close a shared client through its connection.** `mongo.client.close()`
  skips the count: the closed client stays shared, and every later
  `connectMongo` for that URI gets it, dead, until `closeMongo()`.
- **A connect that `closeMongo()` interrupts rejects.** At shutdown, a request
  still connecting fails rather than getting a closed client.
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
- **Coercion reads the schema, not the value.** A field the schema does not
  declare an `ObjectId` or a `Date` keeps whatever you sent, so a string on a
  field typed `z.string()` that happens to hold 24 hexadecimal characters stays
  a string — and a filter on a field the schema does not mention at all is
  passed to the server untouched. It also never guesses: a number is not a
  date, a string of any other length is not an id, and a date is only
  `2026-01-01` or a time with a zone on it — `'5'`, `'2026'`, `'2026-02-31'`
  and `'2026-01-01T00:00'` are all things `new Date` reads and none of them
  means one instant, so all four are left as the strings they are.
- **Coercion never throws, so a malformed id is a 404 and not a 400.**
  `getById('nope')` hands the string on, matches nothing and raises
  `NotFoundError`. Call `toObjectId` or `objectIdParam` where you want the
  refusal to be its own answer.
- **`coerce: false` does not narrow the types.** An `ObjectId` field still
  takes a string at compile time, because the option is read at runtime and
  the definition alone decides the types. With it off, passing one sends a
  string to the server, which matches nothing.
- **A `before` hook sees the caller's input, not the read form.** It runs
  before the collection converts anything, so `args.id` is the string the
  caller passed when that is what they passed — its type says so. A hook that
  needs the stored form calls `toObjectId` itself.
- **`new ObjectId(undefined)` is a fresh id, not an error.** So is
  `new ObjectId(null)`. A missing route parameter turns into a valid id that
  matches nothing, and the bug surfaces as an empty result rather than as a
  failure. Use `toObjectId`, which throws, or `tryObjectId`, which answers
  `undefined`.
- **`id` is computed, not stored.** It is on every document a repository
  returns, and on none in the collection: a filter or a patch keyed on it would
  match nothing, so both are compile errors. Query on `_id`. A schema that
  declares an `id` field of its own keeps it, untouched.
- **`$setOnInsert` does nothing.** It is in the update operators, because it
  is one of MongoDB's, but no write this package makes is an upsert — nothing
  passes `upsert: true` to the driver — so an insert it could apply to never
  happens: `update` on a document that is not there throws `NotFoundError`
  instead. For an upsert, use `raw.updateOne(filter, update, { upsert: true })`
  and fill the stamps yourself.
- **A read is never checked against the schema.** `validate` is about writes:
  `findOne` and the rest return the driver's document with `id` added on
  (`collection/operations/reads.ts`), and nothing parses it. So a document
  written by `raw`, by a migration, or before a field was added comes back
  typed as if the field were there and is `undefined` at run time, and the
  failure surfaces wherever the handler reads it rather than at the read. If
  that matters, parse what you read: `users.schema.parse(document)`.
- **`validate: 'off'` also turns the schema's defaults off.** Filling them is
  what parsing does: a field like `name: z.string().default('')` stays absent.
  The stamps the collection keeps are still filled, and the driver still
  generates an `_id`.
- **The driver retries a transaction's callback** on a transient error, for up
  to 120 seconds, so `fn` must be safe to run twice — and must not swallow
  errors, or the driver cannot tell whether the transaction was aborted.
- **A migration without a transaction runs again after a failure.** It is not
  recorded, so the next `migrate` starts it over, on top of what it did
  before failing: write it so a second run changes nothing more. In a
  transaction, only what `up` does outside the session can happen twice.
- **`session.abortTransaction()` inside the callback resolves.**
  `withTransaction` returns the callback's value; it does not throw.

## Testing against a real MongoDB

Transactions need a replica set, which a standalone `mongod` is not. This
package's own specs run against a single-node replica set from
`mongodb-memory-server-core`, with no Docker; the same works in any consumer's
test suite.

## License

MIT
