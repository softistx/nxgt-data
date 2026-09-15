---
---

Tests only: nothing in the published code changed, so nothing is released.

`@nxgt/drizzle`'s specs now cover cursor pagination's limit clamp, its
`withDeleted`, its refusal to page along a column that is null in a row and on
a table with no primary key, the `orderBy` and `where` type errors, `with()`
keeping the repository's options, `findFirst({ withDeleted })`, `restore` on a
row that was never deleted, and a write in a read-only transaction.

`@nxgt/meilisearch`'s specs now cover the settings a server reads back sorted,
merged with its defaults or reshaped, round-tripping to an empty second sync; a
dry run on an index with no primary key; `customMetadata` kept on the task;
`list({ offset })`; and a missing index reaching the caller. A scripted client
covers the two branches a real server cannot produce: the `index_already_exists`
race and the failed tasks.

The repository's own scripts cover `$MEILISEARCH_BIN` and the publish order.
