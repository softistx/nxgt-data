---
'@nxgt/mongo': minor
---

Collections rather than repositories, with the driver's own methods on the same
object — and a good deal more of the schema actually checked by the compiler.

**Breaking.** `createRepository` and the `Repository` type are gone, replaced by
`getCollection` and `TypedCollection`. To migrate: `createRepository(db, def)`
becomes `getCollection(db, def)`, `.with(session)` becomes
`.withSession(session)`, and `.collection` — the driver's collection — becomes
`.raw`. `RepositoryOptions` is `CollectionOptions`.

What you get back is no longer a wrapper standing in front of the driver: it is
this package's methods **and** the driver's `Collection`, on one object.
`aggregate`, `watch`, `bulkWrite`, `distinct`, `collectionName` are all there
directly. Three names are defined by both and this package's win, because a
filter that came out empty must not rewrite a collection: `count`, `updateMany`
and `deleteMany` return a number and require a filter. The driver's own stay
reachable on `raw`, which is also the way out for an update operator this
package does not name.

`getCollection` takes a `Db` or a `MongoClient` — with a client, the database
is the URI's, or the one named in `{ db }`. It does not take a session, because
a session does not expose its client: the driver marks that field internal and
keeps it out of its public types, so reading it would be a bet on a private
field. `withSession` is how a collection joins a transaction.

**The typing is considerably stricter**, which is the other half of this
release. Measured on twelve mistakes that a user of 0.2.0 could make, seven got
past the compiler; all seven are now compile errors: `sort` and `projection` on
a field that does not exist, a projection that is neither 0, 1 nor an operator,
`$set` on an unknown field or with the wrong type, and an actor of any type at
all — `as()` now takes what the schema declares for `createdBy`, and a
collection that stamps no actor has no `as()` to call. The update operators are
declared by this package rather than taken from the driver, whose `UpdateFilter`
is intersected with `Document` and therefore accepts every key; `$inc` and
`$mul` want a numeric field, `$push` and `$addToSet` an array field and its
element type. What stays unchecked, on purpose: the tail of a dotted path, and
`filter`, which remains the driver's `Filter`.
