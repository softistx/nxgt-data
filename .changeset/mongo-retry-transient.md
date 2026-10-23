---
"@nxgt/mongo": minor
---

`withTransaction` and `mongo.transaction` take `retryTransient: false`, which runs the callback exactly once and hands the first transient error (from a write or from the commit) back as a `DataError` labelled `TransientTransactionError`, for the caller's own bounded retry. The default stays the driver's 120 s retry.
