---
'@nxgt/mongo': minor
---

Add `mongo.database(name, { from? })`: derives, synchronously, a `Mongo` for another database of the same client, with the same collections, buckets, options and `autoSync`, carrying the actor (`as`) and the session or transaction it was derived in. It opens no connection, and like `as` it cannot be closed, so the client stays open. `from` names the source database and is required when the Mongo holds several.
