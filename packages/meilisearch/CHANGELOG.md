# @nxgt/meilisearch

## 0.4.1

### Patch Changes

- [#103](https://github.com/softistx/nxgt-data/pull/103) [`4373d63`](https://github.com/softistx/nxgt-data/commit/4373d63297e3614bb69d738c47747d986db04d09) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A `TASK_FAILED` `SearchIndexError` no longer copies Meilisearch's sentence into its message. That sentence quotes the filter a `deleteByFilter` sent, or the document id an `add` was refused, and a message reports a shape, never a value. The message now holds the task's uid, the call you made, the index and Meilisearch's error code, and nothing else — `Task 7 (deleteByFilter) on index "movies" failed: invalid_document_filter`. The sentence is still on `cause` and on `task.error`.
  
  **The message text changes.** Before, it was `Task 7 (documentDeletion) on index "movies" failed: ` followed by the server's sentence; a canceled task ended with `: it was canceled`, and now ends at `canceled`. The parentheses now name the call — `add`, `addInBatches`, `update`, `updateInBatches`, `delete`, `deleteByFilter`, `deleteAll`, `sync` or `rebuild` — instead of the task type, which stays on `task.type`. Anything that matched on the old text should match on `code` and `task.error.code` instead.
  
  The two bridges' `SearchSyncError` messages end with that message, so they change the same way: `Search sync "articles:articles" failed removing documents: Task 0 (delete) on index "articles" failed: index_not_found`. Their troubleshooting pages are updated to the new headings.

## 0.4.0

### Minor Changes

- [#97](https://github.com/softistx/nxgt-data/pull/97) [`c065f43`](https://github.com/softistx/nxgt-data/commit/c065f430bdc41923fb8562cd348a27d396b11703) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Rebuild an index without a gap in the searches: `movieIndex.rebuild(fill)` creates `movies_next` with the definition's primary key and settings, hands `fill` a `TypedIndex` bound to it, waits for every task the fill left there (enqueued ones included), swaps it with the live index in one atomic task and deletes the previous one. The first run, with no live index, renames it in; a `movies_next` left by a crashed run is deleted first; a failure creating the next index, a fill that throws, a task it left that failed, or a swap task that failed deletes the next index — or says it could not — leaves the live one untouched and throws `SearchIndexError` with the new code `REBUILD_FAILED`, the cause on `cause`. Once the swap request is sent, a failure to read its task back (a timeout, a lost response, a key that cannot read it) may hide a swap that happened: `REBUILD_FAILED` then says the outcome is unknown and nothing is deleted. `fill`'s index has the next uid, typed `string`. New exports: `RebuildDefinition`, `RebuildFill`, `RebuildOptions`, `RebuildReport`.
  
  Search several indexes in one request: `multiSearch(client, [{ index: movieIndex, q, sort }, { index: peopleIndex, q, filter }])` sends the SDK's `client.multiSearch({ queries })` and resolves to a tuple of results in the same order, each typed by its own index; each query's options are `search`'s for that index, so a sort on another index's attribute, or a misspelt option, does not compile. Federated search is not wrapped. New exports: `multiSearch`, `MultiSearchQuery`, `CheckedQuery`, `MultiSearchResults`.
  
  Tenant tokens typed by their indexes: `tenantToken({ apiKey, apiKeyUid, indexes: [movieIndex], searchRules: { movies: { filter } }, expiresAt })` signs with the SDK's `generateTenantToken` (from `meilisearch/token`) a token that may search only the bound indexes given; `searchRules` is keyed by their uids, so a rule for another index does not compile. An `expiresAt` already past, in milliseconds, with a fraction of a second or an invalid `Date` throws `SearchIndexError` with the new code `INVALID_EXPIRES_AT` before anything is signed; a `searchRules` key that is not the runtime uid of one of the indexes throws a `TypeError` instead of leaving that index unfiltered. The SDK's `force` is passed through as it is (its type is checked in the type tests; the SDK's own check is not exercised, since Bun passes it). An inherited rule is refused the same way. New exports: `tenantToken`, `TenantTokenOptions`, `TenantTokenRules`, `TokenIndexes`.

### Patch Changes

- [#93](https://github.com/softistx/nxgt-data/pull/93) [`348c1f3`](https://github.com/softistx/nxgt-data/commit/348c1f3672f2a596abecaa1a7d08dcdf04a55696) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Refactor, nothing public moved: `bindIndex` is split into a data-only `index/context.ts` and `index/operations/reads.ts` and `writes.ts`, and is now a thin assembler. No behaviour and no export changed — the declarations are the same and the 45 specs are untouched.

## 0.3.0

### Minor Changes

- [#86](https://github.com/softistx/nxgt-data/pull/86) [`c4069fc`](https://github.com/softistx/nxgt-data/commit/c4069fcdddc6efb3e74ec352f42c094a7d285fb1) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `deleteByFilter(filter, options)` on a bound index takes every document a filter matches out of the index in one task, without reading their ids first. The filter is Meilisearch's own, on the definition's `filterableAttributes`; an empty one is refused by the server when the request is sent, so nothing is deleted, and one on an attribute that is not filterable fails the task — a `SearchIndexError` with `TASK_FAILED` when the call waits.

## 0.2.0

### Minor Changes

- [#70](https://github.com/softistx/nxgt-data/pull/70) [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `diffSettings` takes a definition's own settings.
  
  ```ts
  const update = diffSettings(movies.settings, await index.getSettings());
  ```
  
  That line did not compile. `defineIndex` infers a definition's lists as
  `readonly` — which is what makes `SortableOf` and the typed `sort` work — and
  the SDK's `Settings` has mutable arrays, so the obvious call was a type error
  and every call site needed a cast. This package's own `syncIndex` had one; it
  is gone.
  
  The first parameter is now `WantedSettings`, exported: the settings as
  something *wants* them, with every list `readonly` and every value allowed to
  be `undefined`. A plain, mutable `Settings` from anywhere else still goes in,
  and what comes back is still a `Settings` the SDK will take.

## 0.1.1

### Patch Changes

- [#66](https://github.com/softistx/nxgt-data/pull/66) [`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every package now ships a `docs/` folder, linked from its npm page.
  
  The README stays the short version: what the package is, how to install it,
  and one copy-paste example per area. `docs/` is the long one — a guide page
  per area with the option tables, the defaults, what is returned and what is
  thrown; a `troubleshooting.md` whose headings are the exact error text you
  would paste into a search box, with the line that prevents each one; and a
  `roadmap.md` saying what is coming, and what is deliberately not.
  
  `docs` is named in each package's `files`, so it travels in the tarball
  rather than living only on GitHub.

## 0.1.0

### Minor Changes

- [#3](https://github.com/softistx/nxgt-data/pull/3) [`fd21b39`](https://github.com/softistx/nxgt-data/commit/fd21b396342437ad9aa79f1d53a668849828e049) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: a typed Meilisearch index on the official `meilisearch` SDK. `defineIndex<Doc>()({ uid, primaryKey, settings })` types every attribute list by the document, dot paths included; `syncIndex` and `syncIndexes` create the index with its primary key and update only the settings that differ, and report what changed; `bindIndex` gives typed document operations (`add`, `update`, `get`, `getMany`, `list`, `delete`, `deleteAll`, in batches too, with a `wait` option) and a `search` whose hits are documents and whose `sort` and `facets` only take the definition's sortable and filterable attributes.
