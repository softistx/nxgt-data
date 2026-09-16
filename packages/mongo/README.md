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
import { defineCollection, id, timestamps, softDelete, optimisticLock, actors } from '@nxgt/mongo';
import { z } from 'zod';

export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.email(),
		name: z.string().nullable().default(null),
		loginCount: z.int().default(0),
		...timestamps(),
		...softDelete(),
		...optimisticLock(),
		...actors(),
	}),
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

The field helpers are ordinary Zod schemas, so a collection can take some of
them, all of them, or none:

| helper | fields | what the repository does with them |
| --- | --- | --- |
| `id()` | `_id` | a fresh `ObjectId` on create |
| `objectId()` | — | an `ObjectId`, declared as `bsonType: 'objectId'` |
| `timestamps()` | `createdAt`, `updatedAt` | sets `updatedAt` on every update |
| `softDelete()` | `deletedAt` | `delete` sets it, reads leave those documents out |
| `optimisticLock()` | `version` | raised on every update; `expectedVersion` checks it |
| `actors(schema?)` | `createdBy`, `updatedBy`, `deletedBy` | stamped from `repository.as(actor)` |

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

On a schema with `optimisticLock()`, every update raises `version`. Pass the
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

## Not included

- **No aggregation helpers.** `repository.collection` is the driver's
  collection: `.aggregate()`, `.watch()` and the rest are there.
- **No migrations.** `sync` brings the schema and the indexes in line; it never
  rewrites a document.
- **No connection management.** The client is yours to open and close.

## API

| export | what it is |
| --- | --- |
| `defineCollection(config)` | a collection: name, schema, indexes, validation |
| `id`, `objectId`, `timestamps`, `softDelete`, `optimisticLock`, `actors` | the field helpers |
| `toObjectId`, `toObjectIds`, `tryObjectId`, `objectIdParam` | a string from outside as an `ObjectId` |
| `isValidObjectId`, `isObjectIdString`, `isObjectId` | the checks behind them |
| `getCollection(dbOrClient, definition, options?)` | the typed collection, driver methods included |
| `syncCollection`, `syncCollections` | create and bring in line, with `dryRun` |
| `withTransaction(clientOrSession, fn, options?)` | a transaction, joined when nested |
| `toMongoJsonSchema(schema)` | a Zod schema as a MongoDB `$jsonSchema` |
| `encodeCursor`, `decodeCursor`, `pageWindow`, `toPage` | the pagination pieces |
| `DataError` and its subclasses, `toDataError` | the errors |
| `diffIndexes`, `normalizeIndex`, `validationMatches` | what `sync` compares with |

`CollectionOptions` turns the behaviours off one by one: `softDelete`,
`touchUpdatedAt`, `optimisticLock`, `validate: 'off'`, `maxPageSize`, and it
names the database with `db` when you pass a client.

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
