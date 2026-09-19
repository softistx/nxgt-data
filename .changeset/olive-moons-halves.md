---
'@nxgt/mongo': patch
---

`upsert` no longer writes, on the half that matched, things `update` would
never write: a field the stored document is **missing** is no longer filled
from the schema's default, and a document with no `createdBy` is no longer
credited to whoever happened to upsert it.

Measured on mongod 8.2: the server seeds an inserted document from the filter
before the pipeline runs, so `$type` of `$_id` is `missing` on an insert whose
filter did not name `_id`, and `objectId` on the update that follows — and
because an upsert's filter already refuses the `$and`/`$or` that could hide an
`_id`, that is a sound signal wherever the filter carries none.

A filter that **does** name `_id` — a collection keyed by a string `_id` has
to — takes the signal away, and there each field still falls back to its own
absence. That narrow case is what the Traps now describe; it was the general
case before.
