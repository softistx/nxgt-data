# @nxgt/mongo-meilisearch

## 0.1.4

### Patch Changes

- Updated dependencies [[`9117fff`](https://github.com/softistx/nxgt-data/commit/9117fffc1897452d1503c814fc878dbd8082286e)]:
  - @nxgt/mongo@0.13.0

## 0.1.3

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
- Updated dependencies [[`6f08b69`](https://github.com/softistx/nxgt-data/commit/6f08b6905b7b73d29afbb99cd7e87b7054f3e3c5)]:
  - @nxgt/mongo@0.12.1

## 0.1.2

### Patch Changes

- Updated dependencies [[`5012472`](https://github.com/softistx/nxgt-data/commit/5012472fdcbb374961b2d604303c9f732da69114)]:
  - @nxgt/mongo@0.12.0

## 0.1.1

### Patch Changes

- [#35](https://github.com/softistx/nxgt-data/pull/35) [`7d5e04c`](https://github.com/softistx/nxgt-data/commit/7d5e04cb3dfb62085d397e95f5e703269df3fa89) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Corrects the published peer range on `@nxgt/mongo`: 0.1.0 asked for `^0.10.0`, which has no `position` on a change subscription — the token this package records while a collection is quiet. It asks for `^0.11.0`, the version it is built against.

## 0.1.0

### Minor Changes

- [#33](https://github.com/softistx/nxgt-data/pull/33) [`21fbb04`](https://github.com/softistx/nxgt-data/commit/21fbb04e6a4b895027e9bd0e80ec2a5338a56619) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: `createSearchSync` keeps a Meilisearch index in step with a MongoDB collection — a transform typed by both definitions (`null` keeps a document out), `reindex`, and `start`, which follows the collection's changes in batches and resumes from a point recorded in MongoDB, reindexing when the server's history no longer reaches it. A quiet collection's resume point is kept fresh by recording where the stream is every `positionIntervalMs`. Errors are `SearchSyncError`, with the codes `HISTORY_LOST`, `ID_MISMATCH`, `RUNNING` and `FAILED`.
