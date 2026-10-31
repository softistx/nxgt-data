---
'@nxgt/mongo': patch
---

Document, and pin with a test, that `close()` on a Mongo built with a given `client` leaves the client open and every other Mongo on it working.
