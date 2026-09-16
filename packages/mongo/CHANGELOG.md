# @nxgt/mongo

## 0.2.0

### Minor Changes

- [#8](https://github.com/softistx/nxgt-data/pull/8) [`3aeeb5e`](https://github.com/softistx/nxgt-data/commit/3aeeb5edcb3f4b821ac355c33050ffa4c7f6b987) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Index keys are typed by the schema, documents carry `id`, and ids arrive from
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

## 0.1.0

### Minor Changes

- [#6](https://github.com/softistx/nxgt-data/pull/6) [`835971d`](https://github.com/softistx/nxgt-data/commit/835971d11ea47d3bffaf368db799d9a42421a56b) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/mongo`: a typed MongoDB collection from one Zod schema.
  
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
