# Roadmap

Where `@nxgt/meilisearch` is going. A direction, not a commitment: the version
an item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

_Nothing queued._

## Not planned

- **A typed federated search** — with `federation`, Meilisearch merges every
  query's hits into one list, so a hit is a document of any of the indexes,
  told apart only by `_federation.indexUid`. `multiSearch` wraps the
  per-query form; the federated one stays the SDK's
  `client.multiSearch({ federation, queries })`.
- **A typed filter builder** — `filter` is handed to Meilisearch as the SDK
  takes it, a string or an array. What is typed instead is the definition: the
  searchable, sortable and filterable attribute lists, and the `sort` and
  `facets` a search may use, which is where a wrong attribute name actually
  costs something.
- **A tasks or errors layer** — tasks and errors come back as the SDK's own.
  The only error this package adds is `SearchIndexError`, and the one place
  it wraps the SDK's is a rebuild that stopped, whose `REBUILD_FAILED`
  carries it as `cause`.
- **Syncing documents from a database** — writing documents stays the
  caller's, with `add` and `update` where the data changes. For MongoDB,
  `@nxgt/mongo-meilisearch` keeps an index in step with a collection.

## Shipped

- **Tenant tokens fail closed** — `tenantToken` requires `expiresAt` and a
  rule for every index it is given, in the types and at run time: a missing
  `expiresAt` is `INVALID_EXPIRES_AT`, a missing or empty rule a
  `TypeError`, and an index searched with no filter takes an explicit
  `null` — the only way to spell it. Each rule is read once, into a plain
  copy that is what is checked and signed, so a getter, a `toJSON` or
  another key is refused rather than signed; `expiresAt` is read once too,
  with the intrinsic `Date.prototype.getTime`, into the whole seconds that
  are signed; and an index typed as a union of uids is keyed like a dynamic
  one in the types. A token can no longer become a permanent, unfiltered
  credential by a line left out — 0.5.0.
- **Tenant tokens typed by their indexes** — `tenantToken({ apiKey,
  apiKeyUid, indexes, searchRules, expiresAt })` signs a token that may search
  only the bound indexes given, with `searchRules` keyed by their uids, and
  refuses an `expiresAt` that is past, in milliseconds, fractional or invalid
  before signing, as `INVALID_EXPIRES_AT`; a rule under a uid none of the
  indexes has, or inherited from a prototype, is refused rather than
  dropped, which would leave its index unfiltered; the SDK's `force` is
  passed through — 0.4.0.
- **Several indexes in one typed request** — `multiSearch(client, [{ index,
  q, …options }, …])` sends the SDK's multi-search and resolves to a tuple,
  each result typed by its own index, and each query's `sort`, `facets`,
  `distinct` and attribute lists checked against its own definition —
  0.4.0.
- **Rebuilding an index without a gap** — `rebuild(fill)` fills
  `<uid>_next` with the definition's settings, waits for every task the fill
  left, swaps it with the live index in one atomic task and deletes the old
  one; the first run renames it in, a leftover from a crashed run is deleted
  first, and a failure deletes the next index — or says it could not — and
  leaves the live one untouched, as `REBUILD_FAILED`; once the swap is sent,
  a failure to wait for it says the outcome is unknown and deletes nothing
  — 0.4.0.
- **Deleting documents by filter** — `deleteByFilter(filter)` takes every
  document a filter matches out of the index in one task, instead of reading
  their ids first and deleting them by id; an empty filter is refused by the
  server before anything is deleted — 0.3.0.
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
