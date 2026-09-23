# @nxgt/mongo-meilisearch

## 0.3.2

### Patch Changes

- [#103](https://github.com/softistx/nxgt-data/pull/103) [`4373d63`](https://github.com/softistx/nxgt-data/commit/4373d63297e3614bb69d738c47747d986db04d09) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A `TASK_FAILED` `SearchIndexError` no longer copies Meilisearch's sentence into its message. That sentence quotes the filter a `deleteByFilter` sent, or the document id an `add` was refused, and a message reports a shape, never a value. The message now holds the task's uid, the call you made, the index and Meilisearch's error code, and nothing else — `Task 7 (deleteByFilter) on index "movies" failed: invalid_document_filter`. The sentence is still on `cause` and on `task.error`.
  
  **The message text changes.** Before, it was `Task 7 (documentDeletion) on index "movies" failed: ` followed by the server's sentence; a canceled task ended with `: it was canceled`, and now ends at `canceled`. The parentheses now name the call — `add`, `addInBatches`, `update`, `updateInBatches`, `delete`, `deleteByFilter`, `deleteAll`, `sync` or `rebuild` — instead of the task type, which stays on `task.type`. Anything that matched on the old text should match on `code` and `task.error.code` instead.
  
  The two bridges' `SearchSyncError` messages end with that message, so they change the same way: `Search sync "articles:articles" failed removing documents: Task 0 (delete) on index "articles" failed: index_not_found`. Their troubleshooting pages are updated to the new headings.
- Updated dependencies [[`528be97`](https://github.com/softistx/nxgt-data/commit/528be97359691b5bfe8f0ad08f09e0fc525e9115), [`4373d63`](https://github.com/softistx/nxgt-data/commit/4373d63297e3614bb69d738c47747d986db04d09), [`77e7140`](https://github.com/softistx/nxgt-data/commit/77e7140570a540ba3ed66edb0d9cc98b4a23ccfc)]:
  - @nxgt/mongo@0.17.1
  - @nxgt/meilisearch@0.4.1

## 0.3.1

### Patch Changes

- Updated dependencies [[`c065f43`](https://github.com/softistx/nxgt-data/commit/c065f430bdc41923fb8562cd348a27d396b11703), [`348c1f3`](https://github.com/softistx/nxgt-data/commit/348c1f3672f2a596abecaa1a7d08dcdf04a55696)]:
  - @nxgt/meilisearch@0.4.0

## 0.3.0

### Minor Changes

- [#91](https://github.com/softistx/nxgt-data/pull/91) [`e780c55`](https://github.com/softistx/nxgt-data/commit/e780c55369210697254b47043b92fc4efec25af4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A lease on each sync name, so two processes can no longer follow the same name side by side.
  
  `start()` takes it before anything else, and `reindex()` called on its own takes it for as long as it runs. It is one document in the state collection (`_id: { lease: <name> }`), timed by the server's clock, and renewed every third of the new `leaseMs` option (default `30000`). A second process gets `SearchSyncError` `RUNNING`, naming the holder and when its lease lapses. A process that dies leaves the name taken until then, and the next `start` takes it over. `close()` resolves once the lease is let go.
  
  A running sync whose renewal finds the lease someone else's stops, and `closed` rejects with the new code `LEASE_LOST`. A `reindex()` or a `start()` still reindexing rejects with it too, and checks the lease with the server before it removes documents or records a resume point, so it never undoes what the new holder did. A `switch` over `SearchSyncErrorCode` that is exhaustive gains a case to handle.
  
  No new privilege: the lease lives in the collection the resume point already uses.

### Patch Changes

- Updated dependencies [[`c4069fc`](https://github.com/softistx/nxgt-data/commit/c4069fcdddc6efb3e74ec352f42c094a7d285fb1)]:
  - @nxgt/meilisearch@0.3.0

## 0.2.0

### Minor Changes

- [#70](https://github.com/softistx/nxgt-data/pull/70) [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A transform that gives back something that is not a document has its own code.
  
  ```ts
  const error = await sync.reindex().catch((e: unknown) => e);
  // SearchSyncError: Search sync "articles:articles": transform gave a string
  //   for the document 6721…. It must give a document to index, or null to
  //   keep it out.
  //   code: 'NOT_A_DOCUMENT'
  ```
  
  `SearchSyncErrorCode` gains `NOT_A_DOCUMENT`. It used to be a bare
  `TypeError`, which `failed()` wrapped as `FAILED` — the code that means
  "anything else" — so a transform written wrong and a Meilisearch outage were
  the same code, and telling them apart meant reading the sentence. It now
  names the sync and the document, beside `ID_MISMATCH`, which already did.
  
  The message reports the **shape** of what came back, never its value: a
  transform is handed whole documents, and what it returns can hold anything
  they held.

### Patch Changes

- Updated dependencies [[`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893), [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893), [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893)]:
  - @nxgt/meilisearch@0.2.0
  - @nxgt/mongo@0.17.0

## 0.1.8

### Patch Changes

- Updated dependencies [[`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19)]:
  - @nxgt/mongo@0.16.0

## 0.1.7

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
- Updated dependencies [[`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6)]:
  - @nxgt/meilisearch@0.1.1
  - @nxgt/mongo@0.15.1

## 0.1.6

### Patch Changes

- Updated dependencies [[`b4f07aa`](https://github.com/softistx/nxgt-data/commit/b4f07aa4c497bec08297a0c4bd9cb0ea57ccc682)]:
  - @nxgt/mongo@0.15.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`a6cac9b`](https://github.com/softistx/nxgt-data/commit/a6cac9bf5f22c44c9b6e1b211ae8946e4658cad3)]:
  - @nxgt/mongo@0.14.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`9117fff`](https://github.com/softistx/nxgt-data/commit/9117fffc1897452d1503c814fc878dbd8082286e)]:
  - @nxgt/mongo@0.13.0

## 0.1.3

### Patch Changes

- [#54](https://github.com/softistx/nxgt-data/pull/54) [`6f08b69`](https://github.com/softistx/nxgt-data/commit/6f08b6905b7b73d29afbb99cd7e87b7054f3e3c5) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Four things these packages do that their documentation did not say, each one
  measured, and recorded rather than changed.
  
  - **`@nxgt/mongo`: a read is never checked against the schema.** `validate` is
    about writes, so a document written by `raw`, by a migration or before a
    field existed comes back typed as though the field were there. Parse what
    you read when it matters.
  - **`@nxgt/drizzle`: `findById` with a value the column's type refuses throws.**
    On a `uuid` primary key, `findById('nope')` is a `DataError` with
    `code: 'DATABASE'`, not an empty read.
  - **`@nxgt/mongo`: `$setOnInsert` does nothing.** No write this package makes
    is an upsert, so there is no insert for it to apply to.
  - **`@nxgt/mongo-meilisearch`: a reindex holds one id per live document in
    memory** and pages the whole index. It is a deployment step.
  
  `@nxgt/drizzle`'s "`paginate` counts, then reads" was also corrected: the two
  queries run together. Two queries are still not one snapshot.
- Updated dependencies [[`6f08b69`](https://github.com/softistx/nxgt-data/commit/6f08b6905b7b73d29afbb99cd7e87b7054f3e3c5)]:
  - @nxgt/mongo@0.12.1

## 0.1.2

### Patch Changes

- Updated dependencies [[`5012472`](https://github.com/softistx/nxgt-data/commit/5012472fdcbb374961b2d604303c9f732da69114)]:
  - @nxgt/mongo@0.12.0

## 0.1.1

### Patch Changes

- [#35](https://github.com/softistx/nxgt-data/pull/35) [`7d5e04c`](https://github.com/softistx/nxgt-data/commit/7d5e04cb3dfb62085d397e95f5e703269df3fa89) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Corrects the published peer range on `@nxgt/mongo`: 0.1.0 asked for `^0.10.0`, which has no `position` on a change subscription — the token this package records while a collection is quiet. It asks for `^0.11.0`, the version it is built against.

## 0.1.0

### Minor Changes

- [#33](https://github.com/softistx/nxgt-data/pull/33) [`21fbb04`](https://github.com/softistx/nxgt-data/commit/21fbb04e6a4b895027e9bd0e80ec2a5338a56619) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: `createSearchSync` keeps a Meilisearch index in step with a MongoDB collection — a transform typed by both definitions (`null` keeps a document out), `reindex`, and `start`, which follows the collection's changes in batches and resumes from a point recorded in MongoDB, reindexing when the server's history no longer reaches it. A quiet collection's resume point is kept fresh by recording where the stream is every `positionIntervalMs`. Errors are `SearchSyncError`, with the codes `HISTORY_LOST`, `ID_MISMATCH`, `RUNNING` and `FAILED`.
