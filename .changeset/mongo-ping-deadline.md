---
"@nxgt/mongo": patch
---

A `ping` right after the server is lost answers within its deadline instead of after server selection's 30 s. `timeoutMS` does not bound server selection, so the second ping on a connected client that had just lost its server waited `serverSelectionTimeoutMS`; `ping` now races a timer set at `timeoutMS` plus a 250 ms grace, and answers `{ ok: false }` with a `ConnectionError` (`ping: no answer in …ms`) when it wins. The driver's own `MongoOperationTimeoutError` still comes first whenever the driver honours the deadline. The wiring's `ping` for a `client` handed in uses the same one.
