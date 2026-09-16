---
'@nxgt/mongo': patch
---

Internal: a collection is now assembled from modules instead of one factory.

Nothing public moved — every export, every signature and every behaviour is
what 0.3.0 shipped, and the same 144 tests pass on both sides of the change.

`getCollection` was one 583-line file whose `build()` function held 487 of
them: a closure over a dozen variables with twenty functions inside it. It is
now a `CollectionContext` of plain resolved data, passed as the first argument
to functions that live in `filters.ts`, `documents.ts`, `reads.ts`,
`writes.ts` and `paginate.ts`. The factory that is left resolves the database,
assembles the surface and proxies the driver's own collection, and nothing
else; the largest function in the folder is now 66 lines.

`withSession` and `as` still rebuild the collection with one option changed,
exactly as before.

The one thing this tidies in passing: `delete` and `deleteMany` built the
soft-delete update separately, and now share it.
