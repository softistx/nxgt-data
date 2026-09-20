# @nxgt/meilisearch

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
