# @nxgt/meilisearch

## 0.1.0

### Minor Changes

- [#3](https://github.com/softistx/nxgt-data/pull/3) [`fd21b39`](https://github.com/softistx/nxgt-data/commit/fd21b396342437ad9aa79f1d53a668849828e049) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: a typed Meilisearch index on the official `meilisearch` SDK. `defineIndex<Doc>()({ uid, primaryKey, settings })` types every attribute list by the document, dot paths included; `syncIndex` and `syncIndexes` create the index with its primary key and update only the settings that differ, and report what changed; `bindIndex` gives typed document operations (`add`, `update`, `get`, `getMany`, `list`, `delete`, `deleteAll`, in batches too, with a `wait` option) and a `search` whose hits are documents and whose `sort` and `facets` only take the definition's sortable and filterable attributes.
