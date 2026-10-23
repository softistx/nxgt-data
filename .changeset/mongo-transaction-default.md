---
"@nxgt/mongo": minor
---

`defineMongo` takes `transactions: { retryTransient: false }`, a client-wide default for the `retryTransient` of every transaction the Mongo starts. A call's own `retryTransient` outranks it, and with neither the body is retried as before. A call that joins an open transaction takes no default and does not throw, and a derived Mongo keeps it. A `transactions` that is not an object, an unknown key in it or a non-boolean `retryTransient` is refused with a `CONFIG` `WiringError`.
