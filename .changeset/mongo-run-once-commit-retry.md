---
"@nxgt/mongo": patch
---

`retryTransient: false` no longer hands back a commit whose result is unknown. The callback still runs exactly once, but a commit that fails with `UnknownTransactionCommitResult` (other than `MaxTimeMSExpired`) is now retried on its own for up to 120 seconds, as the driver's `withTransaction` does, instead of reaching a caller whose own retry could apply the work twice.
