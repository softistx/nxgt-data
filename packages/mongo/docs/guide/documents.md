# Documents

`getCollection` binds a [definition](collections.md) to a database and gives
back the collection you read and write through: this package's methods and
the driver's own, on one object.

```ts
import { getCollection } from '@nxgt/mongo';
import { users } from './collections';

const collection = getCollection(db, users);   // a Db, or a MongoClient

const ada = await collection.create({ email: 'ada@example.com' });
ada.id;        // '507f1f77bcf86cd799439011' — the _id as a string
ada.name;      // null, from the schema's default
ada.version;   // 0

await collection.update(ada._id, { name: 'Ada' });
await collection.delete(ada._id);   // soft, on a collection with deletedAt
```

`getCollection` opens nothing and is cheap: call it where you need it, or
export one per collection from a module.

## Reading

```ts
await collection.findById(ada._id);          // the document, or undefined
await collection.getById(ada._id);           // or NotFoundError
await collection.findFirst({ email: 'ada@example.com' });
await collection.findMany({
	filter: { name: null },
	sort: { createdAt: -1 },
	projection: { email: 1, name: 1 },
	limit: 10,
	skip: 0,
});
await collection.count({ name: null });
await collection.exists({ email: 'ada@example.com' });
await collection.distinct('email');
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `filter` | `FilterOf<Def>` | `{}` | the driver's filter, with a string allowed wherever the collection reads one |
| `sort` | `SortOf<Def>` | — | `1`, `-1`, `'asc'`, `'desc'`; a field the schema does not have is a compile error |
| `projection` | `ProjectionOf<Def>` | — | `0`, `1` or an operator, keyed on the schema's fields |
| `limit`, `skip` | `number` | — | `findMany` only |
| `withDeleted` | `boolean` | `false` | include soft-deleted documents |

Every read leaves soft-deleted documents out; `withDeleted: true` is on all
of them, `findById` and `count` included.

```ts
await collection.findById(ada._id, { withDeleted: true });
await collection.count({ name: null }, { withDeleted: true });
```

Paging is its own page: [Pagination](pagination.md).

## Writing

```ts
await collection.create({ email: 'ada@example.com' });
await collection.createMany([{ email: 'a@example.com' }, { email: 'b@example.com' }]);

await collection.update(ada._id, { name: 'Ada' });              // field by field
await collection.update(ada._id, { $inc: { loginCount: 1 } });  // MongoDB's operators
await collection.updateMany({ name: null }, { name: 'unknown' }); // → number

await collection.delete(ada._id);       // soft, where there is a deletedAt
await collection.restore(ada._id);
await collection.hardDelete(ada._id);   // really gone
await collection.deleteMany({ name: null });      // → number
await collection.hardDeleteMany({ name: null });  // → number
```

`create` parses the document against the schema before sending it, which is
also what fills its defaults. `update` checks each field of a patch, and
each operator's operand: `$inc` wants a numeric field, `$push` an array one.

`updateMany`, `deleteMany` and `hardDeleteMany` **refuse an empty filter** —
a filter built from a variable that came out empty must not rewrite a
collection. Pass `{ _id: { $exists: true } }` to mean every document.

One write inserts or updates in a single round trip: see
[Upsert](upsert.md).

### What a write may say

The collection writes its own stamps; a write says only what a caller can
know. Each refusal is a compile error, through an operator too, and a
`TypeError` at run time for a caller the types do not reach.

| Stamp | `create` | `update` | `updateMany` | `upsert` |
| --- | --- | --- | --- | --- |
| `createdAt` | an optional `Date` | refused | refused | refused |
| `updatedAt` | an optional `Date` | an optional `Date` | an optional `Date` | an optional `Date` |
| `version` | refused | the version expected, optional | refused | refused |
| `deletedAt` | refused | refused | refused | refused |
| `createdBy`, `updatedBy`, `deletedBy` | refused | refused | refused | refused |

A timestamp left out is `new Date()`; one given — an import, a backfill — is
kept. The version in a patch is not written: it is the version the document
must still be at, and the update raises it as every update does. See
[Transactions and locking](transactions.md#optimistic-locking).

```ts
await collection.create({ email: 'ada@example.com', createdAt: new Date('2019-04-01') });
// @ts-expect-error the collection keeps the version
await collection.create({ email: 'b@example.com', version: 1 });
```

`raw` is the way to set a stamp by hand.

### `_id` never changes

MongoDB never changes a document's `_id`, so no `update`, `updateMany` or
`upsert` writes one. A patch that names `_id` — as a field, through any
operator (`$set`, `$unset`, `$rename` onto it or away from it, a path under
it), even as `undefined` or through a cast — is refused **before anything is
sent**, and before any hook runs:

```
update on "users": "_id" is immutable, and an update never writes it. Leave it out; a document that needs another _id is a new document
```

It is a bare `TypeError`, like every refused argument here, and it names the
call and the collection, never the value. `updateMany` throws the same
message with `updateMany on` in front; `upsert` has its own, in
[Upsert](upsert.md#what-it-throws).

The types refuse the same patches, with one gap: a **top-level `_id:
undefined`** compiles — `update(id, { _id: undefined, name })`, or the idiom
`update(id, { ...body, _id: undefined })` — because `_id?: never` accepts
`undefined` unless your tsconfig turns on `exactOptionalPropertyTypes`. It is
refused at run time only. Inside an operator, `$set: { _id: undefined }`
does not compile.

```ts
const { _id, ...patch } = body;           // a body that carries its own id
await collection.update(ada._id, patch);

// @ts-expect-error `_id` is not in a patch
await collection.update(ada._id, { _id: other });
// @ts-expect-error …nor through an operator
await collection.update(ada._id, { $set: { _id: other } });

// compiles, and throws at run time
await collection.update(ada._id, { ...body, _id: undefined });
```

An upsert's values are written on both halves, so they never carry `_id`.
Its **filter** may, and seeds the inserted document with it — but a filter
is also what the upsert **matches**, so naming `_id` there changes which
document it finds. See
[Upsert](upsert.md#the-filter-is-written-not-only-matched):

```ts
await posts.upsert({ _id: chosen }, { title: 'a', rank: 1 });
```

A document that really needs another `_id` is a new document: `create` it
with the new id and `hardDelete` the old one, in a
[transaction](transactions.md).

Before 0.18.0 the patch reached the server, which answered a changed `_id`
with `ImmutableField` (66) — a plain `DataError` with `serverCode: 66`, whose
message, on an upsert, quoted the new value — and let the same `_id` through
as no change. Both are refused now.

What newly breaks is a whole document spread back into an update, which
carries its own `_id` unchanged:

```ts
const doc = await posts.raw.findOne({ _id: id });   // a raw or driver read
if (!doc) return;
await posts.update(id, { ...doc, title: 'b' });
// 0.17: no change to _id. 0.18: a compile error, and a TypeError at run
// time for a caller the types do not reach (JavaScript, a cast)

const { _id, ...rest } = doc;                        // take it out first
await posts.update(id, { ...rest, title: 'b' });
```

The same goes for a client body with `id` taken off but `_id` left on, and
for a collection whose schema declares its own `id`, where a read carries no
computed one. On a collection that keeps stamps, the stamps in such a
document were refused already. A spread of this package's own `getById`
result on any other collection already threw in 0.17, on `id`.

The driver's own methods are not this package's: `updateOne`,
`findOneAndUpdate`, `replaceOne`, `bulkWrite` and `raw` send what they are
given, and the server refuses a changed `_id` there as it always did (see
[below](#the-driver-is-on-the-same-object)).

### Who is writing

`as(actor)` gives back a collection that stamps `createdBy`, `updatedBy` and
`deletedBy` from it. The actor is typed by `actors.type` — `objectId()`
unless the definition says otherwise — and it is **not** coerced: check a
string that arrived from outside yourself.

```ts
import { toObjectId } from '@nxgt/mongo';

const acting = collection.as(toObjectId(session.userId));
await acting.create({ email: 'ada@example.com' });   // createdBy is set
```

`as` and `withSession` return a new collection and leave the one you hold
alone; both keep the [hooks](hooks.md).

## `id`, and strings from outside

Every document a read gives back carries `id`: its `_id` as a string. It is
computed, never stored, and an ordinary enumerable property — so
`JSON.stringify` and a spread carry it, and a handler can return the
document as it is. Because it is not stored, filtering or patching on it is
a compile error: query on `_id`.

A collection reads the strings that arrive from outside on its own, so a
handler parses no ids and no dates before a query:

```ts
await collection.getById(params.id);                    // a 24-hex string is enough
await collection.update(params.id, { name: 'Ada' });
await collection.findMany({ filter: { teamId: query.team } });
await collection.findMany({ filter: { createdAt: { $gte: '2026-01-01' } } });
await collection.create({ email: 'ada@example.com', teamId: body.teamId });
```

| Where | From | To |
| --- | --- | --- |
| a field whose schema says `bsonType: 'objectId'` — `objectId()`, `id()`, your own `.meta()` | 24 hex characters | `ObjectId` |
| a field declared `z.date()` | `YYYY-MM-DD`, or that with a time **and a zone** | `Date` |
| `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, `$each`, `$not` | each value, each element | the same |
| `$and`, `$or`, `$nor`, a nested path, `$elemMatch` | | the same |
| the id argument of `findById`, `getById`, `update`, `delete`, `hardDelete`, `restore` | | the same |
| a patch of fields, a patch in operators, and `onChange`'s filter | | the same |

It is deliberately conservative, because a wrong guess is a query that
silently matches nothing: `'5'`, `'2026'`, `'2026-02-31'` and
`'2026-01-01T00:00'` are all things `new Date` reads, and none of them means
one instant, so all four are left as the strings they are. A number is never
a date. **Nothing throws**: a string that cannot be read is handed on, so a
read matches nothing and a write meets the schema's own message.

Three surfaces convert nothing: `raw` and the driver's own methods,
`as(actor)`, and a pipeline you write yourself.

`coerce: false` turns it off for one collection. The types stay as wide — the
definition alone decides them — so with it off it is on you to pass what the
field holds:

```ts
const strict = getCollection(db, users, { coerce: false });
```

### When a malformed id should be a 400

Coercion never throws, so `getById('nope')` is a `NotFoundError` and not an
`InvalidIdError`. Where the refusal has to be its own answer, convert the
parameter yourself:

```ts
import { isValidObjectId, objectIdParam, toObjectId, tryObjectId } from '@nxgt/mongo';
import { z } from 'zod';

toObjectId(params.id);        // an ObjectId, or InvalidIdError
tryObjectId(params.id);       // an ObjectId, or undefined
isValidObjectId(params.id);   // a boolean

const route = z.object({ id: objectIdParam() });
const { id } = route.parse(params);   // ObjectId
```

**Do not call `new ObjectId(value)` on input you did not produce.** Given
`null` or `undefined` the driver invents a fresh id, so a parameter that
never arrived becomes a valid id that matches nothing.

## The driver is on the same object

Everything this package does not wrap is on the collection directly — there
is no `.collection` to go through:

```ts
await collection.aggregate([{ $group: { _id: '$teamId', n: { $sum: 1 } } }]).toArray();
await collection.bulkWrite([{ insertOne: { document: { email: 'x@example.com' } } }]);
collection.collectionName;   // 'users'
collection.watch();
```

Four names are defined by both, and this package's win. `count`,
`updateMany` and `deleteMany` return a number and require a filter;
`distinct` leaves soft-deleted documents out, as every read does. The
driver's own are on `raw`, which is its `Collection`, untouched:

```ts
await collection.updateMany({ name: null }, { name: 'x' });     // → number
await collection.raw.updateMany({}, { $set: { name: 'x' } });   // → UpdateResult
```

`raw` is also the way out for an update operator this package does not name,
and the way to write a stamp by hand. It runs no hooks, coerces nothing, and
does not filter out soft-deleted documents.

**The boundary is this package's own calls.** Its rules — the stamps a write
may not give, [`_id` never written](#_id-never-changes), the empty filter
refused — hold for `update`, `updateMany`, `upsert` and the rest of its
methods. A method that is the driver's own — `updateOne`,
`findOneAndUpdate`, `replaceOne`, `bulkWrite`, `raw.updateMany` — is left as
the driver wrote it: it checks nothing here, and what it sends is the
server's to refuse. A changed `_id` sent that way comes back as the driver's
`MongoServerError`, code 66.

## The options

```ts
const collection = getCollection(db, users, {
	validate: 'parse',
	coerce: true,
	maxPageSize: 100,
	autoSync: false,
});
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `softDelete` | `boolean` | on where there is a `deletedAt` | `false` makes `delete` a real delete |
| `touchUpdatedAt` | `boolean` | on where there is an `updatedAt` | `false` leaves the stamp to the caller |
| `optimisticLock` | `boolean` | on where there is a `version` | `false` refuses an expected version instead of checking it |
| `validate` | `'parse' \| 'off'` | `'parse'` | `'off'` sends documents as they are — and fills no schema default |
| `coerce` | `boolean` | `true` | read a string as the `ObjectId` or `Date` its field holds |
| `maxPageSize` | `number` | `100` | the largest `pageSize` or `limit` a page may ask for |
| `session` | `ClientSession` | — | the session every operation runs in; `withSession` is the same thing, later |
| `actor` | `ActorOf<Def>` | — | who is writing; `as` is the same thing, later |
| `db` | `string` | the URI's | which database, when `getCollection` is given a client |
| `autoSync` | `boolean` | `false` | sync before the first operation — for tests and development, see [Sync](sync.md#syncing-from-the-collection) |
| `hooks` | `CollectionHooks<Def>` or an array | — | [hooks](hooks.md) around the writes |

A collection whose definition has no `deletedAt` takes `softDelete: false`
only — the option is typed against the definition, not guessed at.

`validate: 'off'` also turns the schema's defaults off, since filling them is
what parsing does. The stamps the collection keeps are still filled, and the
driver still generates an `_id`.

## A handler, end to end

```ts
import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { getCollection, NotFoundError, toObjectId } from '@nxgt/mongo';
import { users } from './collections';

export const app = new Hono<{
	Bindings: { db: Db };
	Variables: { userId: string };
}>();

app.get('/users/:id', async (c) => {
	const collection = getCollection(c.env.db, users);
	const user = await collection.findById(c.req.param('id'));
	return user ? c.json(user) : c.json({ error: 'not found' }, 404);
});

app.patch('/users/:id', async (c) => {
	const collection = getCollection(c.env.db, users).as(toObjectId(c.get('userId')));
	try {
		const user = await collection.update(c.req.param('id'), await c.req.json());
		return c.json(user);   // `id` is on it, so the client never sees `_id`
	} catch (error) {
		if (error instanceof NotFoundError) return c.json({ error: 'not found' }, 404);
		throw error;
	}
});
```

Turning the rest of this package's errors into answers is
[Errors](errors.md).

## The signature

```ts
function getCollection<Schema extends z.ZodObject, Names extends StampNames>(
	source: Db | MongoClient,
	definition: CollectionDefinition<Schema, Names>,
	options?: CollectionOptions<CollectionDefinition<Schema, Names>>,
): TypedCollection<CollectionDefinition<Schema, Names>>;

type TypedCollection<Def> = CollectionApi<Def> &
	Omit<Collection<DocumentOf<Def>>, keyof CollectionApi<Def>>;

interface CollectionApi<Def> {
	readonly definition: Def;
	readonly db: Db;
	readonly raw: Collection<DocumentOf<Def>>;
	readonly session: ClientSession | undefined;

	withSession(session: ClientSession | undefined): TypedCollection<Def>;
	as(actor: ActorOf<Def>): TypedCollection<Def>;
	sync(options?: SyncOptions): Promise<SyncReport>;

	findById(id: IdOf<Def> | string, options?: ReadOptions): Promise<ReadDocumentOf<Def> | undefined>;
	getById(id: IdOf<Def> | string, options?: ReadOptions): Promise<ReadDocumentOf<Def>>;
	findFirst(filter?: FilterOf<Def>, options?: FindFirstOptions<Def>): Promise<ReadDocumentOf<Def> | undefined>;
	findMany(options?: FindManyOptions<Def>): Promise<ReadDocumentOf<Def>[]>;

	create(values: NewOf<Def>): Promise<ReadDocumentOf<Def>>;
	createMany(values: readonly NewOf<Def>[]): Promise<ReadDocumentOf<Def>[]>;
	update(id: IdOf<Def> | string, patch: Patch<Def>): Promise<ReadDocumentOf<Def>>;
	updateMany(filter: FilterOf<Def>, patch: ManyPatch<Def>): Promise<number>;
	upsert(filter: FilterOf<Def>, values: UpsertOf<Def>): Promise<ReadDocumentOf<Def>>;

	delete(id: IdOf<Def> | string): Promise<ReadDocumentOf<Def>>;
	deleteMany(filter: FilterOf<Def>): Promise<number>;
	hardDelete(id: IdOf<Def> | string): Promise<ReadDocumentOf<Def>>;
	hardDeleteMany(filter: FilterOf<Def>): Promise<number>;
	restore(id: IdOf<Def> | string): Promise<ReadDocumentOf<Def>>;

	count(filter?: FilterOf<Def>, options?: ReadOptions): Promise<number>;
	exists(filter: FilterOf<Def>, options?: ReadOptions): Promise<boolean>;
}
```

`paginate`, `paginateByCursor`, `distinct`, `groupBy`, `populate` and
`onChange` are on the same interface; each has its own page.

## Next

- [Upsert](upsert.md) — insert or change, in one round trip.
- [Hooks](hooks.md) — something around every write.
- [Pagination](pagination.md), [Aggregation](aggregation.md),
  [Change subscriptions](changes.md).
