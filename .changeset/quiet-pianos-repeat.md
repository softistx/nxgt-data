---
'@nxgt/mongo': minor
---

Index keys are typed by the schema, documents carry `id`, and ids arrive from
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
