---
'@nxgt/redis': minor
---

Queue flow control. `pause()` and `resume()` stop and restart every worker of a queue, running jobs finishing as they go, and `counts()` gains `paused`. A queue's `rateLimit: { limit, per, burst? }` caps how many jobs start per span across every worker of every process, counted by the same GCRA as `defineRateLimit`. `add` and `addMany` take `debounce: { key, wait }` (jobs added under one key collapse into one that runs `wait` after the last, replacing the data of a job that has not started) or `throttle: { key, window }` (the first add under a key wins for `window`, later ones answer its id with `deduplicated: true`). Each is refused with a `TypeError` when combined with `id`, with each other, or (for `debounce`) with `delay` or `at`. New types: `QueueRateLimit`, `QueueRate`, `DebounceOptions` and `ThrottleOptions`.
