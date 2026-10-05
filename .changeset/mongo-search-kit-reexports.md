---
"@nxgt/mongo-search-kit": minor
---

`@nxgt/mongo-search-kit` is deprecated: its API moved into `@nxgt/mongo-meilisearch`, and this package now only re-exports it. `@nxgt/mongo-meilisearch` is its one peer besides `typescript` (`@nxgt/mongo`, `@nxgt/meilisearch`, `mongodb`, `meilisearch` and `zod` come with it), and the docs are gone from the package — they live in `@nxgt/mongo-meilisearch`.

Every renamed name keeps its old spelling as a `@deprecated` alias: `createSearchKit` is `createSearchSyncs`, and `SearchKit`, `RunningSearchKit`, `SearchConfig` and `SearchEntry` are `SearchSyncs`, `RunningSearchSyncs`, `SearchSyncsConfig` and `SearchSyncEntry`; `IndexMap`, `SoleCollections` and `ByKey` are re-exported as they were.

**What changes for a caller:** the first argument is what `@nxgt/mongo`'s `openMongo` returns, not a `MongoKit` from `@nxgt/mongo-kit`, which this package no longer peers on; and the messages follow `@nxgt/mongo-meilisearch`. A refusal begins `createSearchSyncs:` instead of `createSearchKit:` (and the type-level one, `mongo-search-kit:`); `this kit holds N databases … Build one search kit per database, from a kit that wires that database alone` is now `this Mongo holds N databases … Build one \`createSearchSyncs\` per database, from a Mongo that wires that database alone`, and `this kit wires no collection called "…"` is `this Mongo wires no collection called "…"`. A test that matches one of those has to change. Move to `@nxgt/mongo-meilisearch` when you can: `bun add @nxgt/mongo-meilisearch`, then rename as above.
