---
'@nxgt/mongo-meilisearch': minor
---

A transform that gives back something that is not a document has its own code.

```ts
const error = await sync.reindex().catch((e: unknown) => e);
// SearchSyncError: Search sync "articles:articles": transform gave a string
//   for the document 6721…. It must give a document to index, or null to
//   keep it out.
//   code: 'NOT_A_DOCUMENT'
```

`SearchSyncErrorCode` gains `NOT_A_DOCUMENT`. It used to be a bare
`TypeError`, which `failed()` wrapped as `FAILED` — the code that means
"anything else" — so a transform written wrong and a Meilisearch outage were
the same code, and telling them apart meant reading the sentence. It now
names the sync and the document, beside `ID_MISMATCH`, which already did.

The message reports the **shape** of what came back, never its value: a
transform is handed whole documents, and what it returns can hold anything
they held.
