# @nxgt/meilisearch

## 0.5.0

### Minor Changes

- [#112](https://github.com/softistx/nxgt-data/pull/112) [`a359770`](https://github.com/softistx/nxgt-data/commit/a359770dfd1046b5d9f1e8a449c207ceccd97ed7) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `tenantToken` fails closed. `expiresAt` is required, and so is a rule in `searchRules` for **every** index the token is given: `{ filter }`, or an explicit `null` meaning "this index, no filter". Before, both were optional, and a token that left out both — one forgotten line, or a filter that came back `undefined` — was a permanent, unfiltered credential: it lived as long as its key and read every document of the index, and nothing said so.
  
  Both are refused in the types and at run time, before anything is signed:
  
  - a missing `expiresAt` — `undefined` or `null` — is a `SearchIndexError` with the existing code `INVALID_EXPIRES_AT`, like every other `expiresAt` it refuses, since it is the same option and can come from a request just as well: `tenantToken for "movies": expiresAt is missing; it takes a Date, or whole seconds since the epoch`;
  - an index with no rule — its key left out, set to `undefined`, or `searchRules` left out altogether — is a bare `TypeError`, like the other `searchRules` refusals: `tenantToken for "movies", "people": searchRules has no rule for "people"; give each index { filter: … }, or null to search it with no filter`. The message names the call and the uids, never a rule or a key;
  - an **empty** rule — a rule object with no `filter`, or one that is `undefined`, `null`, a blank string (blank as the server reads it: Rust's `White_Space`, which is JavaScript's `\s` plus U+0085 (NEL), measured on v1.53.2; `trim()` keeps U+0085, and U+FEFF, which `\s` holds, is refused too), an empty array or an array of those — is a bare `TypeError` too, since it would sign the same unfiltered token: `tenantToken for "movies", "people": searchRules has an empty rule for "people"; give it { filter: … }, or null to search it with no filter`. "No filter" is spelled only `null`. An empty filter is a bare `TypeError` rather than a coded error: a tenant filter is built by the server from the caller's identity, not taken from a request;
  - a rule that is not `null` or a plain `{ filter }` is a bare `TypeError`: `tenantToken for "movies": searchRules has a rule for "movies" that is not a plain object; give it { filter: … }, or null to search it with no filter`, and siblings ending `that is an array`, `that is a string`, `that is a number`, `that is a getter`, `that is not enumerable`, `that has a toJSON`, `that has a key other than filter`, `whose filter is a getter`, `whose filter is not enumerable`, `whose filter has a toJSON`, `whose filter is a number` (or a function, a symbol), `whose filter is an object`, `whose filter is a boolean` and `whose filter holds …`. Each rule is now read **once**, into a plain copy, and that copy is what is checked and signed: the SDK signs `JSON.stringify` of its rules, and — measured on v1.53.2 — a class whose `filter` is a getter, an inherited or non-enumerable `filter`, a `NaN` filter, a `toJSON` returning `null` and a getter changing between reads each signed an unfiltered token. An array given as a rule (`['']`) is refused too; its `filter` was `Array.prototype.filter`.
  
  `expiresAt` is read **once** too: a `Date` with the intrinsic `Date.prototype.getTime`, into the whole seconds that are checked and passed to the SDK, never the caller's object, which the SDK would read again. Measured on v1.53.2, a `Date` subclass whose `getTime` changed between calls, or an object given `Date.prototype`, signed an `exp` of `null` or 10^17 — no expiry. Such an object is now refused (`expiresAt is neither a Date nor a finite number`), a real `Date` whose own `getTime` lies signs its real time, and a `Date` past the year 5138 is refused like a number of milliseconds: `tenantToken for "movies": expiresAt is a Date past the year 5138; was it built from milliseconds times 1000?`.
  
  An index whose uid is not a Meilisearch index uid — anything but letters, digits, `-` and `_`, or empty — is a bare `TypeError` naming no uid: `tenantToken: an index uid is not a valid Meilisearch uid (letters, digits, - and _ only), and a * in it would widen the token to other indexes`. Meilisearch reads a token's rule keys as index patterns: measured on v1.53.2, an index bound as `*` with a `null` rule signed a token that searched every other index, and a uid built from a request, `docs_${tenant}`, can hold a `*`. A rule keyed by a pattern beside valid indexes was, and is, an unmatched key.
  
  An index given twice is one uid: the messages name it once.
  
  `TenantTokenRules<Indexes>` now requires one key per literal uid of `Indexes`, and a new `TenantTokenRule` names one rule, `(Omit<TokenIndexRules, 'filter'> & { filter: Filter }) | null` — the SDK's rule with its other keys kept (in meilisearch-js 0.62.0 it has none, and any other key is refused at run time) and `filter` required where the SDK leaves it optional. An empty `''` or `[]` still compiles — the SDK's `Filter` is any string or array — and is refused at run time only. An index whose uid is typed only `string` — a rebuild's next index — or a union of literals — `cond ? movieIndex : peopleIndex` — adds a `string` index signature, so its rule is keyed by its `uid` and checked at run time only; an index with one literal uid beside it still needs its rule in the types. What already worked is unchanged: a key that is none of the indexes' uids and a `searchRules` that is not a plain object are refused, and `force` is passed through.
  
  **What stops compiling:** a `tenantToken` call with no `expiresAt`, no `searchRules`, or a `searchRules` that leaves out one of its indexes' uids — `Property 'expiresAt' is missing…`, `Property 'people' is missing…`. Add `expiresAt: new Date(Date.now() + 60 * 60 * 1000)` (or whole seconds), and a rule per index, writing `people: null` where an index was deliberately unfiltered. An annotation `TenantTokenRules<typeof indexes>` given an object missing a uid stops compiling the same way. A rule written `{}`, `{ filter: undefined }` or `{ filter: null }` stops compiling too (`Property 'filter' is missing…`). Where a rule came from a variable that may be `undefined`, decide: a filter, or `null`.
  
  **Why a minor.** Code that compiled and ran on 0.4.x stops compiling, and a call that signed a token now throws; on 0.x a minor is how this repository ships a "what stops compiling" change, as `@nxgt/redis` 0.3.0 and `@nxgt/drizzle` 0.6.0 did. `@nxgt/mongo-meilisearch`, `@nxgt/drizzle-meilisearch` and `@nxgt/mongo-search-kit`, which peer on it, get their patch republish with the new peer range automatically; none of them calls `tenantToken`.

### Patch Changes

- [#112](https://github.com/softistx/nxgt-data/pull/112) [`bfd860d`](https://github.com/softistx/nxgt-data/commit/bfd860df7786793e6b3e7aabbbdefbcf202f37e3) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `rebuild` no longer says the next index "could not be deleted" when there was none to delete. When creating `movies_next` was the refused step — a key without `indexes.create` — the deletion that follows fails `index_not_found`, which now counts as gone: the `REBUILD_FAILED` message reads `"movies_next" was deleted, and "movies" is as it was`, as it does for every other stop while creating. A spec pins it with such a key.
  
  `tenantToken`'s refusal of a `searchRules` that is not a plain object now reads `tenantToken for "movies": searchRules must be a plain object`. It used to add `, not one that inherits its rules`, which was wrong for a class instance, refused by the same check. An object with a `null` prototype is plain, and accepted, as before; a spec now pins both.
  
  Not in 0.4.0's notes, and unchanged: `rebuild(fill, { nextUid })` with `nextUid` equal to the index's own uid throws a bare `TypeError` before anything is sent — `rebuild on "movies": nextUid must differ from the index's own uid`.
  
  The docs follow: the README and `errors.md` list what is not wrapped in a `REBUILD_FAILED` (the lookup of a leftover `_next` included) and `tenantToken`'s `TypeError`s; the troubleshooting page has an entry for a rebuild stopped while `swapping`; and the roadmap says a failure deletes the next index or says it could not, and deletes nothing when the swap's outcome is unknown.

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
