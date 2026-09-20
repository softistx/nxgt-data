# @nxgt/meilisearch

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
