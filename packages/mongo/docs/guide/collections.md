# Collections and definitions

One Zod schema describes a collection: it types every read and every write,
it becomes the `$jsonSchema` validator on the server, and it is what the
indexes are keyed on. `defineCollection` is where that schema and the
behaviours around it are written down.

```ts
import { defineCollection, id, objectId } from '@nxgt/mongo';
import { z } from 'zod';

export const users = defineCollection({
	name: 'users',
	schema: z.object({
		_id: id(),
		email: z.email(),
		name: z.string().nullable().default(null),
		teamId: objectId().nullable().default(null),
		loginCount: z.int().default(0),
	}),
	timestamps: true,
	softDelete: true,
	optimisticLock: true,
	actors: true,
	indexes: [{ key: { email: 1 }, unique: true, name: 'users_email_unique' }],
});
```

A definition is data, not a connection: it can be imported anywhere, and it
is bound to a database by [`getCollection`](documents.md) and brought to the
server by [`sync`](sync.md).

## What the config takes

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `name` | `string` | — | the collection's name on the server |
| `schema` | `z.ZodObject` | — | the documents, as they are stored. It must have an `_id` |
| `indexes` | `CollectionIndex<Doc>[]` | `[]` | what `sync` creates, keyed on the schema's fields |
| `validation` | `{ level?, action? }` | `{ level: 'strict', action: 'error' }` | the `$jsonSchema` validator `sync` writes |
| `options` | `MongoCollectionOptions` | `{}` | MongoDB's own collection options: capped, time series, collation, clustered |
| `timestamps` | `true` / `{ createdAt?, updatedAt? }` | `false` | the `createdAt` and `updatedAt` stamps |
| `softDelete` | `true` / `{ deletedAt? }` | `false` | `delete` writes the stamp instead of removing the document |
| `optimisticLock` | `true` / `{ version? }` | `false` | every update raises the version |
| `actors` | `true` / `{ type?, createdBy?, updatedBy?, deletedBy? }` | `false` | who wrote, from `collection.as(actor)` |

The schema is the one source of truth: `z.output` is what a read gives back,
`z.input` what a write takes. A field with a default — `_id`, `createdAt` —
is optional to write and always there once read.

```ts
import type { DocumentOf, ReadDocumentOf } from '@nxgt/mongo';

type User = DocumentOf<typeof users>;        // as stored
type ReadUser = ReadDocumentOf<typeof users>; // the same, plus the computed `id`
```

## The schema needs an `_id`

`id()` is an `ObjectId` field that fills itself on create; `objectId()` is
the same field with no default, for a reference to another collection. A
schema with no `_id` at all is a `TypeError` where the definition is written.

```ts
schema: z.object({ _id: id(), authorId: objectId() });
```

The single-field builders are there for a field with **no** behaviour
attached — a date that nothing touches, a counter nothing raises:

```ts
import { actorFieldOf, deletedAtField, timestampField, versionField } from '@nxgt/mongo';

schema: z.object({
	_id: id(),
	seenAt: timestampField(),         // a Date, defaulting to now
	archivedAt: deletedAtField(),     // a nullable Date — but `delete` ignores it
	revision: versionField(),         // an int, defaulting to 0
	owner: actorFieldOf(z.string()),  // nullable, defaulting to null
});
```

Declaring a stamp field by hand does **not** turn its behaviour on: a
collection whose schema has `deletedAt` and no `softDelete` option still
deletes for good. Asking for both throws, because the field would be added
twice.

## Stamps

Four options add fields **and** the behaviour that reads them.

| Option | Fields it adds | What the collection does with them |
| --- | --- | --- |
| `timestamps` | `createdAt`, `updatedAt` | sets `updatedAt` on every update |
| `softDelete` | `deletedAt` | `delete` sets it; every read leaves those documents out |
| `optimisticLock` | `version` | raised on every update; one given in a patch is checked |
| `actors` | `createdBy`, `updatedBy`, `deletedBy` | stamped from `collection.as(actor)` |

Each reads the same way: `true` for its fields under their default names,
`false` or absent for none, or an object naming them one by one. **Inside
that object an absent key means on, under its default name**; only `false`
turns a field off.

```ts
export const tickets = defineCollection({
	name: 'tickets',
	schema: z.object({ _id: id(), subject: z.string() }),
	timestamps: { createdAt: 'openedAt' },   // updatedAt keeps its name
	softDelete: { deletedAt: 'removedAt' },
	optimisticLock: { version: 'revision' },
	actors: { type: z.string(), createdBy: 'openedBy', deletedBy: false },
});

const collection = getCollection(db, tickets);
const ticket = await collection.getById(ticketId);
await collection.update(ticket._id, { subject: 'b', revision: ticket.revision });
// `version` there is a compile error: this collection calls it `revision`
```

The name follows everywhere — the document's type, the validator, the field
`delete` writes, the field a read filters on, the fields an index may be
keyed on. `actors.type` is the actor's own Zod type (`objectId()` by
default), and it is what `collection.as(actor)` takes.

Which stamps a write may say, and which the collection keeps to itself, is
in [Documents](documents.md#what-a-write-may-say).

## Indexes

An index is keyed on the schema's own fields — the stamps included — so a
typo does not compile. A path into a field is allowed, since that is how
MongoDB indexes a nested key. Everything else is the driver's own
`IndexDescription`.

```ts
export const people = defineCollection({
	name: 'people',
	schema: z.object({
		_id: id(),
		email: z.email(),
		teamId: objectId().nullable().default(null),
		address: z.object({ city: z.string(), zip: z.string() }),
	}),
	timestamps: true,
	indexes: [
		{ key: { email: 1 }, unique: true, name: 'people_email_unique' },
		{ key: { createdAt: -1 } },                  // a stamp is a field like any other
		{ key: { 'address.city': 1 } },              // a path into a field
		{ key: { teamId: 1 }, partialFilterExpression: { teamId: { $ne: null } } },
		// @ts-expect-error there is no such field
		{ key: { emial: 1 } },
	],
});
```

Nothing creates them at run time: [`sync`](sync.md) does, as a deployment
step.

## The validator

`sync` writes the schema as a `$jsonSchema` validator. `validation` decides
how strict the server is about it.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `level` | `'strict' \| 'moderate' \| 'off'` | `'strict'` (`'off'` on a time series) | `'off'` writes no validator, and removes one that is there; `'moderate'` exempts documents that were already invalid from updates |
| `action` | `'error' \| 'warn'` | `'error'` | `'warn'` logs a document that fails instead of refusing it |

```ts
// Rolling a validator onto a collection that is already full:
defineCollection({
	name: 'logs',
	schema: z.object({ _id: id(), message: z.string() }),
	validation: { level: 'moderate', action: 'warn' },
});
```

`$jsonSchema` is not JSON Schema: MongoDB refuses `$ref`, `$schema`,
`default`, `format` and `id`, and has no `integer` type.
`toMongoJsonSchema(schema)` is the translation, and it throws on a recursive
schema rather than writing a validator the server would refuse.

```ts
import { toMongoJsonSchema } from '@nxgt/mongo';

const jsonSchema = toMongoJsonSchema(users.schema);
```

## MongoDB's own collection options

`options` is what the server is given when the collection is created, keyed
on the schema's fields wherever it names one.

```ts
export const readings = defineCollection({
	name: 'readings',
	schema: z.object({
		_id: id(),
		at: z.date(),
		sensor: z.string(),
		value: z.number(),
	}),
	options: {
		timeseries: { timeField: 'at', metaField: 'sensor' },
		expireAfterSeconds: 7 * 24 * 3600,
	},
});

export const audit = defineCollection({
	name: 'audit',
	schema: z.object({ _id: id(), message: z.string() }),
	options: { capped: { size: 64 * 1024, max: 1000 } },
});
```

`capped` is one object rather than MongoDB's three sibling keys, because the
server refuses `capped` without a `size`: here that is a compile error. A
time-series collection gets **no** validator — MongoDB answers `'timeseries'
is not allowed with 'validator'` — so `validation.level` defaults to `'off'`
there, and asking for anything else throws where the definition is written.

Most of these are fixed at creation; [`sync`](sync.md#options-mongodb-cannot-change)
is where the ones that cannot change are reported.

## Defining registers

Every definition goes into a registry, which is what lets
[`syncAll`](sync.md#every-collection-at-once) sync an application without a
list anyone keeps up to date. Importing the module that defines a collection
is what puts it in.

```ts
import { registeredCollections } from '@nxgt/mongo';

registeredCollections().map((definition) => definition.name);
```

## The signature

```ts
function defineCollection<Shape, TS, SD, OL, AC>(
	config: CollectionConfig<Shape, TS, SD, OL, AC>,
): CollectionDefinition<
	StampedSchema<Shape, TS, SD, OL, AC>,
	StampNamesOf<TS, SD, OL, AC>
>;

interface CollectionDefinition<Schema, Names> {
	readonly name: string;
	/** The declared schema, extended with whatever the stamp options added. */
	readonly schema: Schema;
	readonly indexes: readonly IndexDescription[];
	readonly validation: Required<ValidationConfig>;
	readonly options: MongoCollectionOptions;
	/** What each stamp is called here, or `false` when there is none. */
	readonly stamps: Names;
}
```

The definition is frozen. `definition.stamps` is what every behaviour reads
its field name from, so a rename is true rather than cosmetic.

## Next

- [Documents](documents.md) — binding a definition to a database and writing
  through it.
- [Sync](sync.md) — getting the validator and the indexes onto the server.
- [Files](gridfs.md) — `defineBucket`, the same idea for GridFS.
