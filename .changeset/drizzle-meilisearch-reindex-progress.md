---
'@nxgt/drizzle-meilisearch': minor
---

`reindexAll({ onPage })` reports where a reindex is: after each page is applied, `onPage` is called with the running `pages`, `indexed` and `skipped`, and awaited when it returns a promise. A callback that throws stops the reindex — it rejects as a `SearchSyncError` with `FAILED` and the callback's error as `cause` — which is also how to stop one on purpose. `ReindexOptions` and `ReindexProgress` are exported.
