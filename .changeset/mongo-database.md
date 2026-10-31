---
'@nxgt/mongo': minor
---

Add `mongo.database(name, { from?, options?, optionsFor? })`: derives, synchronously, a `Mongo` for another database of the same client, with the same collections, buckets, options and `autoSync`, carrying the actor (`as`) and the session or transaction it was derived in. It opens no connection, and like `as` it cannot be closed, so the client stays open. `from` names the source database and is required when the Mongo holds several. `options` and `optionsFor` are merged over the source's for that database (the derived ones win, even over the source's `optionsFor`); `db`, `session`, `actor` and `autoSync` are refused. The name is checked at call time, and a refusal is the new `WiringErrorCode` `DATABASE_NAME`.

Behaviour change: the memo behind the public `autoSync` / `resetAutoSync` is now kept per client and database name instead of per `Db` object, so two `Db` objects of one database sync once.
