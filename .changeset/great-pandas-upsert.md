---
'@nxgt/mongo': minor
---

`upsert(filter, values)`: the live document that matches, changed — or a new
one — in one round trip, with no read to go stale in between. Two requests
racing on the same key give one document and not two **when a unique index
covers that key**; without one, MongoDB may insert twice. The loser of that
race meets the index and rejects with `ConflictError`; nothing here retries.

```ts
const user = await users.upsert({ email: 'ada@example.com' }, { name: 'Ada' });
```

An insert lands what `create` would have landed: the schema's defaults,
`createdAt`, `createdBy` and version 0. An update does what `update` does:
`updatedAt`, `updatedBy`, and the version raised by one — `createdAt` and
`createdBy` are never moved. It is sent as **one** aggregation pipeline
update, which is what makes that branch possible: measured on mongod 8.2,
`$inc: { version: 1 }` beside `$setOnInsert: { version: 0 }` is refused by the
server, and `$inc` alone starts an inserted document one ahead of a created
one.

The filter seeds an insert, which makes it unlike every other filter in this
package — it is written, not only matched — so it is checked as a write is.
A condition rather than a value (an operator bag or a regular expression), a
field the schema does not have, a stamp the collection keeps, `$and`/`$or`
— the server seeds from inside those too, measured — and a dotted path are
each a `TypeError` naming the field. `_id` is allowed, and required there
when the schema fills `_id` with something that is not an `ObjectId` — the
server generates one before the pipeline runs, so an upsert cannot apply that
default and asks rather than land a document `create` would not have landed.

An upsert must always be able to insert, so the seeds, the values and the
schema's defaults are parsed as a whole document before the server is asked:
a missing required field is the `ZodError` `create` would have raised, and
not a server `ValidationError` on the day the document happened not to be
there. The cost is that such a field has to be named on every upsert,
matching or not.

The values are the document's own fields, each optional, and no operators.
Which half ran is told to the hooks: `afterCreate` or `afterUpdate` runs
according to what the server did, and the new `beforeUpsert` is the one hook
that runs before — until the server answers, which of the two it will be is
not known.

Also recorded in the Traps, measured while building this: a **filter** does
not refuse a field the schema has no idea about, here or anywhere else — the
driver's `Filter<T>` carries `Document`'s index signature. Sorts, projections
and patches are checked; filters are not.
