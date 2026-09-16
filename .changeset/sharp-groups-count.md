---
'@nxgt/mongo': minor
---

Typed aggregation helpers: `distinct`, `groupBy` and `populate`

- `collection.distinct(field, filter?, { withDeleted })`: the distinct values
  of a field, typed — an array field gives its elements. It now leaves
  soft-deleted documents out, like every read; the driver's is
  `raw.distinct`.
- `collection.groupBy(field, { filter, measures, sort, limit, withDeleted })`:
  each group's `key` and `count`, and typed measures — `sum` and `avg` on
  numeric fields, `min` and `max` on any. Largest groups first by default.
- `collection.populate(documents, relations)`: related documents under each
  relation's name, one query per relation. `{ from, by }` follows a field of
  these documents (a list field gives a list, in its order); `{ from, on }`
  gathers the documents that point back. The related collection reads with
  its own session and soft delete.

The types refuse a non-numeric sum, a measure named `key` or `count`, a
field that holds no reference, and a relation named after an existing field.
