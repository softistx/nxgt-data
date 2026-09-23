---
'@nxgt/mongo-meilisearch': minor
---

A lease on each sync name, so two processes can no longer follow the same name side by side.

`start()` takes it before anything else, and `reindex()` called on its own takes it for as long as it runs. It is one document in the state collection (`_id: { lease: <name> }`), timed by the server's clock, and renewed every third of the new `leaseMs` option (default `30000`). A second process gets `SearchSyncError` `RUNNING`, naming the holder and when its lease lapses. A process that dies leaves the name taken until then, and the next `start` takes it over. `close()` resolves once the lease is let go.

A running sync whose renewal finds the lease someone else's stops, and `closed` rejects with the new code `LEASE_LOST`. A `reindex()` or a `start()` still reindexing rejects with it too, and checks the lease with the server before it removes documents or records a resume point, so it never undoes what the new holder did. A `switch` over `SearchSyncErrorCode` that is exhaustive gains a case to handle.

No new privilege: the lease lives in the collection the resume point already uses.
