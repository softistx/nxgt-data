---
'@nxgt/meilisearch': minor
---

`deleteByFilter(filter, options)` on a bound index takes every document a filter matches out of the index in one task, without reading their ids first. The filter is Meilisearch's own, on the definition's `filterableAttributes`; an empty one is refused by the server when the request is sent, so nothing is deleted, and one on an attribute that is not filterable fails the task — a `SearchIndexError` with `TASK_FAILED` when the call waits.
