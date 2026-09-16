---
'@nxgt/mongo': minor
---

Hooks around the writes, typed by the schema

`getCollection(db, users, { hooks: { beforeCreate, afterDelete, … } })` runs
hooks around `create`, `createMany` (once per document), `update`,
`updateMany`, `delete`/`hardDelete`, `deleteMany`/`hardDeleteMany` and
`restore`. A `before` hook gets what is about to be written — `{ values }`,
`{ id, patch }`, `{ filter }` — and may return a replacement of the same shape
or throw to stop the write; an `after` hook gets the document or the count.
Every hook gets the operation, the collection the write runs on (session and
actor included), the session and the actor; the delete hooks also say whether
the delete is hard. `hooks` takes an array of sets, run in order, and
`withSession` and `as` keep them. `restore`'s hooks are only typed on a collection
whose definition soft deletes. An empty filter is refused before any hook
runs, so a hook that narrows the filter cannot turn `deleteMany({})` into a
delete of everything it can reach.

`getCollection` now infers its types from the definition alone. It used to
read them from the options too, which let a hook set typed for another
collection widen them until it fit.
