---
"@nxgt/mongo": minor
---

`withTransaction` and `mongo.transaction` now let the driver retry a transient error raised by a collection method: it arrives as a `DataError`, which the driver does not retry, so a write conflict inside a transaction used to fail instead of running the callback again. `DataError` also carries the driver error's `errorLabels` and a `hasErrorLabel(label)`.
