---
'@nxgt/meilisearch': patch
'@nxgt/mongo-meilisearch': patch
'@nxgt/drizzle-meilisearch': patch
---

A `TASK_FAILED` `SearchIndexError` no longer copies Meilisearch's sentence into its message. That sentence quotes the filter a `deleteByFilter` sent, or the document id an `add` was refused, and a message reports a shape, never a value. The message now holds the task's uid, the call you made, the index and Meilisearch's error code, and nothing else — `Task 7 (deleteByFilter) on index "movies" failed: invalid_document_filter`. The sentence is still on `cause` and on `task.error`.

**The message text changes.** Before, it was `Task 7 (documentDeletion) on index "movies" failed: ` followed by the server's sentence; a canceled task ended with `: it was canceled`, and now ends at `canceled`. The parentheses now name the call — `add`, `addInBatches`, `update`, `updateInBatches`, `delete`, `deleteByFilter`, `deleteAll`, `sync` or `rebuild` — instead of the task type, which stays on `task.type`. Anything that matched on the old text should match on `code` and `task.error.code` instead.

The two bridges' `SearchSyncError` messages end with that message, so they change the same way: `Search sync "articles:articles" failed removing documents: Task 0 (delete) on index "articles" failed: index_not_found`. Their troubleshooting pages are updated to the new headings.
