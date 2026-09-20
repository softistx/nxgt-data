# Upsert

`upsert(filter, values)` changes the live document that matches, or writes a
new one, in **one** round trip — there is no read to go stale between the
look-up and the write.

```ts
import { getCollection } from '@nxgt/mongo';
import { users } from './collections';

const collection = getCollection(db, users);

const user = await collection.upsert(
	{ email: 'ada@example.com' },   // what identifies it
	{ name: 'Ada' },                // what to write, either way
);
```

Two requests racing on the same key give one document and not two **when a
unique index covers that key**; without one, MongoDB can insert twice, so the
index is part of the guarantee and not an optimisation. The index is also
what the loser of the race meets: its call rejects with `ConflictError`, and
nothing here retries it.

## The filter is written, not only matched

MongoDB builds an inserted document out of the filter's equality conditions,
so `{ email: 'ada@example.com' }` lands with its `email`. That makes an
upsert's filter unlike every other filter in this package — it is held to
what a write is held to, and each of these is a `TypeError` naming the field:

| The filter | Why it cannot stand |
| --- | --- |
| `{ rank: { $gt: 5 } }` | a condition seeds nothing; the new document would have no `rank` |
| `{ email: /ada/ }` | the same: measured, a regular expression seeds nothing |
| `{ $or: [{ tier: 'gold' }, …] }` | the server seeds from inside `$and` and `$or` too, and a choice cannot say what it would insert |
| `{ 'profile.name': 'Ada' }` | a seed is a whole field value, not a part of one |
| `{ nope: 1 }` | the schema has no such field, and the server would **store** it |
| `{ version: 0 }` | the collection keeps that stamp itself |
| `{}` | nothing to seed, and nothing to identify |

```ts
// A TypeError, before anything is sent:
await collection.upsert({ loginCount: { $gt: 5 } }, { name: 'Ada' });
```

`_id` is allowed in the filter, and an upsert filtered by one inserts a
document with the id you chose. It is **required** there when the schema
fills `_id` with something that is not an `ObjectId`: the server generates
one before the pipeline runs, so an upsert cannot apply that default.

In the **values**, `_id` compiles — as it does in a patch — and the server
refuses it on the update half as an immutable field. Put it in the filter.

## What each half writes

**An insert lands what `create` would have landed**: the schema's defaults,
`createdAt`, `createdBy`, and version 0 — and under `validate: 'off'`, the
stamps alone, exactly as `create` lands them there. **An update does what
`update` does**: `updatedAt`, `updatedBy`, and the version raised by one.
`createdAt` and `createdBy` are never moved by an update, and an `updatedAt`
you write yourself is left alone.

The values are the document's own fields, each optional — **no operators**.
An upsert is sent as an aggregation pipeline, where `$set` and `$inc` have no
meaning:

```ts
// @ts-expect-error an upsert is a pipeline: no operators in its values
await collection.upsert({ email: 'ada@example.com' }, { $set: { name: 'Ada' } });
```

An expected version is refused too: a document that may not exist has no
version to be at. For a conditional write on a document you know is there,
use `update` — see [Optimistic locking](transactions.md#optimistic-locking).

## It must always be able to insert

Before the server is asked, the filter's seeds plus the values plus the
schema's defaults are parsed as a whole document. A missing required field is
the `ZodError` `create` would have raised, naming the same field — and not a
server `ValidationError` on the day the document happened not to be there.

The cost is the other half of that: a required field with no default has to
be named on **every** upsert, matching or not, because nothing here can know
which half will run.

```ts
// posts.slug is required and has no default: it is named even when the
// document is already there.
await postsCollection.upsert({ title: 'Hello' }, { slug: 'hello', authorId });
```

A collection where that reads badly wants `findFirst` and `update` instead.

## Which half ran

It is told to the [hooks](hooks.md), not to the caller: `upsert` gives back
the document either way. The one hook that runs **before** is
`beforeUpsert`, because until the server has answered nobody knows which of
the two it will be; afterwards `afterCreate` or `afterUpdate` runs according
to what the server actually did, with `context.operation` still `'upsert'`.

```ts
const scoped = getCollection(db, users, {
	hooks: {
		beforeUpsert: ({ filter, values }) => ({
			filter: { ...filter, teamId },   // the rule above holds here too
			values,
		}),
		afterCreate: (document) => audit('created', document),
		afterUpdate: (document) => audit('changed', document),
	},
});
```

## Two traps worth knowing before you use it

**An upsert filtered on `_id` fills holes the other one leaves.** The server
seeds an inserted document from the filter, so `_id` is missing during an
insert — and that is how an upsert tells its two halves apart. A filter that
names `_id` takes the signal away, and each field then falls back to its own
absence: on the half that matched, a field the stored document is **missing**
is filled from the schema's default, and an absent `createdBy` from the actor
upserting now. A value stored as `null` is left alone either way.

**An upsert cannot see a soft-deleted document.** It is scoped to the live
ones like every other write, so an upsert on a deleted document's key inserts
a new one — which a unique index refuses with `ConflictError`. Restore it, or
hard-delete it, before writing over its key.

## A route that takes a webhook twice

An idempotent endpoint is the case this is for: the same payload arriving
twice must leave one document.

```ts
app.post('/webhooks/contact', async (c) => {
	const body = await c.req.json();
	const contact = await getCollection(c.env.db, contacts).upsert(
		{ externalId: body.id },          // covered by a unique index
		{ email: body.email, name: body.name },
	);
	return c.json(contact);
});
```

## The signature

```ts
upsert(filter: FilterOf<Def>, values: UpsertOf<Def>): Promise<ReadDocumentOf<Def>>;

/** The document's own writable fields, each optional — and no operators. */
type UpsertOf<Def> = Partial<WritableDocumentOf<Def>> & {
	[K in FixedOnUpdate<Def>]?: never;   // the stamps the collection keeps
};
```

## Next

- [Documents](documents.md) — `create`, `update` and the rest.
- [Errors](errors.md) — `ConflictError`, and what it carries.
