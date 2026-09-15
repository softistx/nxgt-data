---
'@nxgt/meilisearch': minor
---

First release: a typed Meilisearch index on the official `meilisearch` SDK. `defineIndex<Doc>()({ uid, primaryKey, settings })` types every attribute list by the document, dot paths included; `syncIndex` and `syncIndexes` create the index with its primary key and update only the settings that differ, and report what changed; `bindIndex` gives typed document operations (`add`, `update`, `get`, `getMany`, `list`, `delete`, `deleteAll`, in batches too, with a `wait` option) and a `search` whose hits are documents and whose `sort` and `facets` only take the definition's sortable and filterable attributes.
