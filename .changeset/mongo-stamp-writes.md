---
"@nxgt/mongo": minor
---

Type and guard what a write may say about the stamps.

- `create` takes `createdAt` and `updatedAt` as optional `Date`s and keeps them.
- `update` and `updateMany` take `updatedAt`, and `$currentDate` on it is left to the server instead of conflicting with the stamp the collection adds.
- A refusal is a compile error and, before anything is sent, a `TypeError`; `raw` is the way to set a stamp by hand. One is runtime only: an expected version on a collection opened with `optimisticLock: false`.
- `validate: 'off'` now fills the stamps the collection keeps, since a caller can no longer give them.
- `undefined` values inside an update operator are dropped, as they already were at the top of a patch.
- The field builders have explicit return types (`ObjectIdField`, `TimestampField`, `DeletedAtField`, `VersionField`, `ActorField`), so an editor shows the stamps as `Date` rather than as inferred aliases.
- New exports: `StampNameOf`, `VersionNameOf`, `SetByCollection`, `FixedOnUpdate`, `ManyPatch`, `ExpectedVersion`, `WritableDocumentOf`, `WritableFieldOf`, `WritablePath`, `RemovablePath`, `ObjectIdField`.

**Breaking:**

- The expected version is given in `update`'s patch, under the version field's configured name (`{ subject, revision: 3 }`). The `expectedVersion` option is gone, and `UpdateOptions` with it. The version must be a whole number and needs the optimistic lock; `updateMany` refuses it.
- `create` refuses the version, the soft-delete field and the actors: importing soft-deleted documents through `create` no longer works, so use `raw`.
- `update` and `updateMany` refuse `createdAt`, the soft-delete field, the actors and the version, as fields and through any operator (`$set`, `$inc`, `$unset`, `$rename`, `$push`…). `$inc: { version }` is no longer a way out.
- `updatedAt` can no longer be removed or renamed.
- The actors come only from `collection.as(actor)`: a `createdBy` or `updatedBy` given explicitly is refused, where it used to be kept.
- `NewDocumentOf` leaves the stamps the collection keeps out.
