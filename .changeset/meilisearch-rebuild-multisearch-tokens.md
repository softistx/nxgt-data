---
'@nxgt/meilisearch': minor
---

Rebuild an index without a gap in the searches: `movieIndex.rebuild(fill)` creates `movies_next` with the definition's primary key and settings, hands `fill` a `TypedIndex` bound to it, waits for every task the fill left there (enqueued ones included), swaps it with the live index in one atomic task and deletes the previous one. The first run, with no live index, renames it in; a `movies_next` left by a crashed run is deleted first; a fill that throws, or a task it left that failed, deletes the next index, leaves the live one untouched and throws `SearchIndexError` with the new code `REBUILD_FAILED`. New exports: `RebuildFill`, `RebuildOptions`, `RebuildReport`.
