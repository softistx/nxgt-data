---
"@nxgt/mongo-meilisearch": minor
---

First release: `createSearchSync` keeps a Meilisearch index in step with a MongoDB collection — a transform typed by both definitions (`null` keeps a document out), `reindex`, and `start`, which follows the collection's changes in batches and resumes from a point recorded in MongoDB, reindexing when the server's history no longer reaches it. A quiet collection's resume point is kept fresh by recording where the stream is every `positionIntervalMs`. Errors are `SearchSyncError`, with the codes `HISTORY_LOST`, `ID_MISMATCH`, `RUNNING` and `FAILED`.
