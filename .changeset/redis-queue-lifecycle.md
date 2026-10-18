---
'@nxgt/redis': minor
---

Queue jobs return a typed result; `add` gives a handle with `finished()` and `cancel()`; a job has a `timeout`, an `AbortSignal` and `progress()`; workers emit typed events and have `idle()` and `close({ grace })`.
