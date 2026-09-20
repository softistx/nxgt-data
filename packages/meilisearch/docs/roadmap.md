# Roadmap

Where `@nxgt/meilisearch` is going. A direction, not a commitment: the version
an item shipped in is the only number on this page.

## Now

- **Deleting documents by filter** — take every document a filter matches out
  of the index in one call, instead of reading their ids first and deleting
  them by id.

## Next

_Nothing queued._

## Later

_Nothing queued._

## Not planned

- **A typed filter builder** — `filter` is handed to Meilisearch as the SDK
  takes it, a string or an array. What is typed instead is the definition: the
  searchable, sortable and filterable attribute lists, and the `sort` and
  `facets` a search may use, which is where a wrong attribute name actually
  costs something.
- **A tasks or errors layer** — tasks and errors come back as the SDK's own.
  The only error this package adds is `SearchIndexError`, for a request
  Meilisearch refuses.
- **Syncing documents from a database** — writing documents stays the
  caller's, with `add` and `update` where the data changes. For MongoDB,
  `@nxgt/mongo-meilisearch` keeps an index in step with a collection.

## Shipped

- **`diffSettings` takes a definition's own settings** — a definition's
  settings go straight in, with no cast: the first parameter is the exported
  `WantedSettings`, every list `readonly` and every value allowed to be
  `undefined`, and a plain `Settings` from anywhere else still goes in; what
  comes back is still a `Settings` the SDK will take — 0.2.0.
- **Documentation that travels with the package** — a guide page for the
  definition, documents, search and `syncIndex`, a troubleshooting page whose
  headings are the exact error text, and this roadmap, installed in `docs/`
  rather than left on GitHub — 0.1.1.
- **First release** — `defineIndex<Doc>()({ uid, primaryKey, settings })`
  typing every attribute list by the document, dot paths included;
  `syncIndex` / `syncIndexes` creating the index and updating only the
  settings that differ, and reporting what changed; and `bindIndex` for typed
  documents (`add`, `update`, `get`, `getMany`, `list`, `delete`,
  `deleteAll`, in batches, with `wait`) and a `search` whose hits are
  documents — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/meilisearch/CHANGELOG.md) — it is not in
the published package, only in the repository.
