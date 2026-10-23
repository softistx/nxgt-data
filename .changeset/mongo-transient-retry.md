---
"@nxgt/mongo": minor
---

`withTransaction` and `mongo.transaction` now let the driver retry a transient error raised by a collection method: it arrives as a `DataError`, which the driver does not retry, so a write conflict inside a transaction used to fail instead of running the callback again. `DataError` also carries the driver error's `errorLabels` and a `hasErrorLabel(label)`. An abort that is labelled transient but happens every time, such as `putOnce` against a stray committed chunk inside a transaction, is now retried until the driver's window closes (120 seconds by default) and then fails with the abort on the `DataError`'s `cause`, where it used to fail at once.
