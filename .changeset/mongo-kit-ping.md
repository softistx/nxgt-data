---
'@nxgt/mongo-kit': minor
---

`kit.ping(options?)` sends `ping` to every database the kit wires, at once, and reports `@nxgt/mongo`'s `PingResult` under each database's name — `{ ok: true, latencyMs }` or `{ ok: false, error }` — for a health endpoint. It never throws and answers within `timeoutMS` (2 s by default) even for a `client` the configuration handed over unconnected, whose first connect the driver bounds by `serverSelectionTimeoutMS` instead. Every kit answers, derived ones included.
