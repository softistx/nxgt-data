---
'@nxgt/mongo-search-kit': minor
---

`search.syncIndexes(options?)` brings every index the search kit wires in line with its definition — created with its primary key when missing, only the settings that differ updated — one after another, and reports `@nxgt/meilisearch`'s `SyncReport` under each key. `dryRun` and `wait` pass through; the first index that throws stops the rest. A deployment is now `kit.sync()` and `search.syncIndexes()`, rather than one `syncIndex` per index.
