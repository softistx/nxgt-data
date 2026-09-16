---
'@nxgt/mongo': minor
---

Add `@nxgt/mongo`: a typed MongoDB collection from one Zod schema.

The schema is the single source. `z.output` types every read and `z.input`
every write, and the same schema becomes the collection's `$jsonSchema`
validator — which is not a mechanical conversion: MongoDB rejects `$ref`,
`$schema`, `default`, `format` and `id`, has no `integer` type, and treats a
keyword it does not know as an error rather than ignoring it.
`toMongoJsonSchema` inlines every `$ref`, keeps only the keywords MongoDB
knows, and maps `integer` onto the BSON types a whole number actually arrives
as.

`syncCollection` creates the collection, writes the validator when it changed
and brings the indexes in line, idempotently and with a `dryRun`.
`createRepository` gives typed reads and writes by `_id` or by filter, offset
and cursor pagination, soft delete, optimistic locking through a `version`
field, and audit stamps from `repository.as(actor)`. `withTransaction` runs a
callback in a transaction and joins one that is already open, since MongoDB
has no savepoints.

MongoDB's errors arrive as `NotFoundError`, `ConflictError`, `ValidationError`,
`OptimisticLockError` and `DataError`, so an application never reads a numeric
code — and a duplicate key is the same `ConflictError` whether it came from a
single write, which carries `keyPattern` and `keyValue`, or from a bulk one,
which carries neither.

The driver, `mongodb` (>=7), and `zod` (>=4.6.5) are peer dependencies.
