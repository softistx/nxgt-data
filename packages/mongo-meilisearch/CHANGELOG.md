# @nxgt/mongo-meilisearch

## 0.1.0

### Minor Changes

- [#33](https://github.com/softistx/nxgt-data/pull/33) [`21fbb04`](https://github.com/softistx/nxgt-data/commit/21fbb04e6a4b895027e9bd0e80ec2a5338a56619) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: `createSearchSync` keeps a Meilisearch index in step with a MongoDB collection — a transform typed by both definitions (`null` keeps a document out), `reindex`, and `start`, which follows the collection's changes in batches and resumes from a point recorded in MongoDB, reindexing when the server's history no longer reaches it. A quiet collection's resume point is kept fresh by recording where the stream is every `positionIntervalMs`. Errors are `SearchSyncError`, with the codes `HISTORY_LOST`, `ID_MISMATCH`, `RUNNING` and `FAILED`.
