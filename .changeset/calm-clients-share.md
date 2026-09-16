---
'@nxgt/mongo': minor
---

`connectMongo(uri, options)`: one `MongoClient` shared per URI

Every call with the same URI shares a client, connected once even when the
calls race, and gets its own `MongoConnection` (`client`, `db`, `ping`,
`close`, `await using`). The client closes with its last connection, so one
module closing its own does not cut the others off. A second call with other
options throws without repeating the URI. A failed connect is forgotten, so
the next call retries. `ping({ timeoutMS })` answers `{ ok, latencyMs }` or
`{ ok: false, error }` and never throws. `closeMongo()` closes every client at
shutdown; nothing listens to signals for you.
