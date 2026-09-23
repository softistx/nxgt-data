---
'@nxgt/mongo': minor
'@nxgt/drizzle': patch
---

`update`, `updateMany` and `upsert` in `@nxgt/mongo` no longer send a patch that names `_id`. A patch that gives `_id` as a field, through any operator (`$set`, `$setOnInsert`, `$unset`, `$rename` onto it or away from it, `$currentDate`, `$min`, `$max`…), under a path such as `_id.x`, or even as `undefined` or through a cast, is refused before anything is sent and before any hook runs, with a bare `TypeError`: `update on "users": "_id" is immutable, and an update never writes it. Leave it out; a document that needs another _id is a new document`. `updateMany on …` is the same refusal, and `upsert on "users": "_id" is immutable, and an upsert never writes it. Name it in the filter, which is what an inserted document is seeded from` is the one for an upsert's values, where the `_id` an insert gets now goes in the filter. What a `before` hook returns is checked again. The message names the call and the collection, never the value.

**A behaviour change, so a minor.** A new `_id` used to reach the server and come back as a plain `DataError` with `serverCode: 66` (`ImmutableField`) — on an upsert, in a message that quoted the value; the same `_id` went through as no change, and an `_id` in an upsert's values chose the id of an insert. Each of these throws now. `FixedOnUpdate` includes `'_id'`, so `Patch`, `ManyPatch`, `UpsertOf`, `WritableDocumentOf`, `WritableFieldOf`, `WritablePath` and `RemovablePath` leave it out: `update(id, { _id })`, `update(id, { $set: { _id } })` and `upsert(filter, { _id })` no longer compile, and neither does a whole document read back and handed to `update` on a collection with no stamps. Take `_id` out of the patch; name it in an upsert's filter.

The driver's own methods are untouched: `updateOne`, `findOneAndUpdate`, `replaceOne`, `bulkWrite` and `raw` check nothing, and the server refuses a changed `_id` there as before.

`@nxgt/drizzle`: documentation only. The table in `docs/guide/stamps.md` of what differs from `@nxgt/mongo` now says that `_id` is refused there too, and lists the two differences that remain — a key given as `undefined`, and a key in an upsert's values. No code changed.
