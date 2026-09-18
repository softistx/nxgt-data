---
"@nxgt/mongo-search-kit": minor
---

A search kit over `@nxgt/mongo-kit`: `createSearchKit(kit, config)` takes one
entry per collection — an index and a transform, under the key the kit wires
that collection under — and gives one `reindexAll`, one `start` and one
`close` for all of them. Each entry's sync is `@nxgt/mongo-meilisearch`'s,
unchanged.
