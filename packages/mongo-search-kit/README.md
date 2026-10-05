# @nxgt/mongo-search-kit

> **Deprecated.** This package moved into
> [`@nxgt/mongo-meilisearch`](https://www.npmjs.com/package/@nxgt/mongo-meilisearch),
> which now holds the whole API under new names. `@nxgt/mongo-search-kit` only
> re-exports it, with the old names marked `@deprecated`, and will not grow.

## What was renamed

| `@nxgt/mongo-search-kit` | `@nxgt/mongo-meilisearch` |
| --- | --- |
| `createSearchKit` | `createSearchSyncs` |
| `SearchKit<I>` | `SearchSyncs<I>` |
| `RunningSearchKit<I>` | `RunningSearchSyncs<I>` |
| `SearchConfig` | `SearchSyncsConfig` |
| `SearchEntry` | `SearchSyncEntry` |

`IndexMap`, `SoleCollections` and `ByKey` keep their names.

**What else changed in the move:** the first argument is now what
`@nxgt/mongo`'s `openMongo` returns (`Mongo`), not a `MongoKit` from
`@nxgt/mongo-kit`, and the messages changed with the names:

| was | is |
| --- | --- |
| `createSearchKit: this kit holds N databases (…), and a search kit follows the collections of one. Build one search kit per database, from a kit that wires that database alone` | `createSearchSyncs: this Mongo holds N databases (…), and createSearchSyncs follows the collections of one. Build one \`createSearchSyncs\` per database, from a Mongo that wires that database alone` |
| `createSearchKit: this kit wires no collection called "…"` | `createSearchSyncs: this Mongo wires no collection called "…"` |
| `mongo-search-kit: this kit wires no collection called "…"` (the type-level refusal) | `createSearchSyncs: this Mongo wires no collection called "…"` |

A test that matches one of those messages has to change with them, whichever
package it imports from. `createSearchKit === createSearchSyncs`: the alias is
the same function.

## Moving over

```ts
// before
import { createSearchKit } from '@nxgt/mongo-search-kit';

const search = createSearchKit(kit, { articles: { index, transform } });
```

```ts
// after
import { createSearchSyncs } from '@nxgt/mongo-meilisearch';

const search = createSearchSyncs(mongo, { articles: { index, transform } });
```

Everything else (`syncs`, `state()`, `syncIndexes()`, `reindexAll()`,
`start()`, `failed`, `flush()` and `close()`) is unchanged. The guides are in
[`@nxgt/mongo-meilisearch`](https://github.com/softistx/nxgt-data/tree/develop/packages/mongo-meilisearch/docs/guide/search-syncs).

## Install

```sh
bun add @nxgt/mongo-search-kit @nxgt/mongo-meilisearch @nxgt/mongo @nxgt/meilisearch mongodb meilisearch zod
```

`@nxgt/mongo-meilisearch` is a required peer, and so are `@nxgt/mongo`,
`@nxgt/meilisearch`, `mongodb`, `meilisearch` and `zod` through it, with
`typescript`.

## License

MIT
