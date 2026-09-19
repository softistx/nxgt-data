# @nxgt/drizzle

## 0.1.1

### Patch Changes

- [#54](https://github.com/softistx/nxgt-data/pull/54) [`6f08b69`](https://github.com/softistx/nxgt-data/commit/6f08b6905b7b73d29afbb99cd7e87b7054f3e3c5) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Four things these packages do that their documentation did not say, each one
  measured, and recorded rather than changed.
  
  - **`@nxgt/mongo`: a read is never checked against the schema.** `validate` is
    about writes, so a document written by `raw`, by a migration or before a
    field existed comes back typed as though the field were there. Parse what
    you read when it matters.
  - **`@nxgt/drizzle`: `findById` with a value the column's type refuses throws.**
    On a `uuid` primary key, `findById('nope')` is a `DataError` with
    `code: 'DATABASE'`, not an empty read.
  - **`@nxgt/mongo`: `$setOnInsert` does nothing.** No write this package makes
    is an upsert, so there is no insert for it to apply to.
  - **`@nxgt/mongo-meilisearch`: a reindex holds one id per live document in
    memory** and pages the whole index. It is a deployment step.
  
  `@nxgt/drizzle`'s "`paginate` counts, then reads" was also corrected: the two
  queries run together. Two queries are still not one snapshot.

## 0.1.0

### Minor Changes

- [#1](https://github.com/softistx/nxgt-data/pull/1) [`2323bbc`](https://github.com/softistx/nxgt-data/commit/2323bbc98ae2fe22b961bb76d8d866d605f6771e) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: typed repositories over a Drizzle table (`createRepository`), offset and cursor pagination, `withTransaction`, the package's own errors with `toDataError` mapping PostgreSQL's constraint violations, and the `id()`, `timestamps()` and `softDelete()` column helpers. PostgreSQL first, on drizzle-orm 1.0.
