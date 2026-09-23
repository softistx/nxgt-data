---
'@nxgt/mongo-meilisearch': minor
'@nxgt/mongo-search-kit': patch
---

A `RUNNING` the lease refuses now says who holds the name and until when as fields, not only in its message, so a standby waits exactly for the holder instead of a fixed time. `SearchSyncError` gains `holder: string | undefined` — the holder as that process described itself, `host:pid:<ObjectId>`, a label for a log rather than a value to parse — and `expiresAt: Date | undefined`, read from the lease document and so on MongoDB's clock; `SearchSyncErrorOptions` takes both. The names and types are those of `@nxgt/mongo`'s `MigrationLockedError`. Both are `undefined` on every other code, on the `RUNNING` a sync object gives when it is already following in this process — the name is its own, renewed while it follows, so there is nothing to wait for but its `close()` — and when the holder let go before its lease could be read. The messages are unchanged. A live holder renews its lease every third of `leaseMs`, so a start at `expiresAt` can be refused again with a later one; a dead holder is taken over as soon as its lease lapses. The README, the guide on following changes and the troubleshooting entry give the standby loop that waits for it.

`@nxgt/mongo-search-kit` passes the error through unchanged, as before; its docs now say the fields are there, its troubleshooting entry's standby loop waits for `expiresAt`, and its introduction names the sync's field as `sync`, which it had called `name`.
