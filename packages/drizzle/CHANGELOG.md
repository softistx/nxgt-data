# @nxgt/drizzle

## 0.6.1

### Patch Changes

- [#127](https://github.com/softistx/nxgt-data/pull/127) [`3bf3ff2`](https://github.com/softistx/nxgt-data/commit/3bf3ff2e456676230d16299b2bd64d94a06239ac) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `update`, `updateMany` and `upsert` in `@nxgt/mongo` no longer send a patch that names `_id`. A patch that gives `_id` as a field, through any operator (`$set`, `$setOnInsert`, `$unset`, `$rename` onto it or away from it, `$currentDate`, `$min`, `$max`…), under a path such as `_id.x`, or even as `undefined` or through a cast, is refused before anything is sent and before any hook runs, with a bare `TypeError`: `update on "users": "_id" is immutable, and an update never writes it. Leave it out; a document that needs another _id is a new document`. `updateMany on …` is the same refusal, and `upsert on "users": "_id" is immutable, and an upsert never writes it. Name it in the filter, which is what an inserted document is seeded from` is the one for an upsert's values, where the `_id` an insert gets now goes in the filter. What a `before` hook returns is checked again. The message names the call and the collection, never the value.
  
  **A behaviour change, so a minor.** A new `_id` used to reach the server and come back as a plain `DataError` with `serverCode: 66` (`ImmutableField`) — on an upsert, in a message that quoted the value; the same `_id` went through as no change, and an `_id` in an upsert's values chose the id of an insert. Each of these throws now. `FixedOnUpdate` includes `'_id'`, so `Patch`, `ManyPatch`, `UpsertOf`, `WritableDocumentOf`, `WritableFieldOf`, `WritablePath` and `RemovablePath` leave it out: `update(id, { _id })`, `update(id, { $set: { _id } })` (`$set: { _id: undefined }` included) and `upsert(filter, { _id })` no longer compile, and neither does a whole document, as the schema types it, handed to `update` on a collection with no stamps. **One gap:** a top-level `_id: undefined` — `update(id, { _id: undefined, name })`, `upsert(filter, { _id: undefined, rank })`, or the idiom `update(id, { ...body, _id: undefined })` — still compiles, because `_id?: never` accepts `undefined` unless the consumer turns on `exactOptionalPropertyTypes`; it is refused at run time only. What newly breaks at run time is a whole document spread back into an update — `update(id, { ...doc, title })` where `doc` came from a `raw` or driver read, a client body with `id` taken off, or a collection whose schema declares its own `id`; a spread of this package's own `getById` result already threw in 0.17, on `id`. Take `_id` out of the patch.
  
  **Moving `_id` into an upsert's filter is not the same call.** The filter is also the match: `upsert({ title: 'a', _id: chosen }, …)` matches that title **and** that id, so where 0.17's `upsert({ title: 'a' }, { _id: chosen, … })` matched on the title alone, it now inserts a second document or fails with `ConflictError` on a unique index. An upsert keyed on a business field that also picks the id of its insert has no exact equivalent: derive `_id` from the key, or read first and `create` or `update`.
  
  The driver's own methods are untouched: `updateOne`, `findOneAndUpdate`, `replaceOne`, `bulkWrite` and `raw` check nothing, and the server refuses a changed `_id` there as before.
  
  `@nxgt/drizzle`: documentation only. The table in `docs/guide/stamps.md` of what differs from `@nxgt/mongo` now says that `_id` is refused there too, and lists the two differences that remain — a key given as `undefined`, and a key in an upsert's values. No code changed.

## 0.6.0

### Minor Changes

- [#104](https://github.com/softistx/nxgt-data/pull/104) [`ceeb8fa`](https://github.com/softistx/nxgt-data/commit/ceeb8fa1b6a5310fc059619fd627625041caa3ac) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `update` and `updateMany` no longer move a row's primary key. A patch that gives a value — SQL included — to a column of the primary key (the one column, every column of a composite key, or the column the `primaryKey` option names) is refused before anything is sent, with an `ArgumentError` (`argument: 'patch'`, `key` the column): `update on "users": "id" is a primary-key column, which an update never moves. Leave it out; a row that needs another key is a new row`. The message names the call, the table and the column, never the value. `UpdatePatch` and `ManyPatch` take a third parameter, `TKey`, defaulting to `PrimaryKeyOf<TTable>`, and leave that key out, so `update(id, { id: other })` no longer compiles. Only that one: the types leave out `TKey`: the column `primaryKey` names, else `id` when the table has one; every other primary-key column is refused at run time only, since Drizzle 1.0's PostgreSQL column types do not say which columns a key covers. An `id: undefined` is still dropped like any undefined value.
  
  **What stops compiling** is wider than moving an id: a patch typed `Partial<$inferInsert>` or `Patch<T>` no longer fits; type it `UpdatePatch<T, L, K>` or drop the key; pass the repository's `TKey` when naming `UpdatePatch` yourself. That covers the usual validated `PATCH` body, `repo.update(id, body)` with `body: Partial<typeof users.$inferInsert>` (drizzle-zod's `createUpdateSchema` included), a patch typed with this package's own `Patch<T>`, and `UpdatePatch<T, L>` left at its default key on a repository given another `primaryKey`.
  
  `upsert`'s update half, which already kept the addressed key, now keeps every column of a composite primary key too.
  
  **Why a minor.** Moving a row's key through `update` was never documented and contradicted what `upsert` already did, so the run-time refusal alone would be a fix. But code that compiled on 0.5.0 stops compiling, and a patch would reach every `^0.5.0` consumer on their next install; on 0.x a minor is how this repository ships a "what stops compiling" change, as `@nxgt/redis` 0.3.0 and `@nxgt/redis-kit` 0.2.0 did. `@nxgt/drizzle-meilisearch` gets its patch republish with the new peer range automatically. For code that did rely on moving a key: create the row under its new key and delete the old one, in one transaction.

## 0.5.0

### Minor Changes

- [#98](https://github.com/softistx/nxgt-data/pull/98) [`62c09e2`](https://github.com/softistx/nxgt-data/commit/62c09e23186a77d87fd2a6d051bd2640fdcfc929) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Upsert, optimistic locking and actor stamps, with the names and shapes `@nxgt/mongo` uses. `repository.upsert(where, values)` inserts the row the `where` identifies or updates the live one there, in one `INSERT … ON CONFLICT (<the where's columns>) DO UPDATE`; the update half stamps `updatedAt`, `updatedBy` and the version and never moves `createdAt` or `createdBy`, an upsert with empty `values` on a row that is there writes nothing (no stamps, no version), a lock column with no default gets 0 on the insert half, a soft-deleted row there is a `ConflictError`, and a `where` no unique constraint covers is a `DataError` naming the columns. A table with an integer `NOT NULL` `version` column now locks: every update raises it, and `update(id, { …, version })` writes only while the row is still at that version, throwing the new `OptimisticLockError` (`code: 'OPTIMISTIC_LOCK'`, with `id`, `expectedVersion`, `actualVersion`) when it moved; `optimisticLock: false` makes `version` an ordinary column. `repository.as(actor)` and the `actor` option stamp `createdBy`/`updatedBy` on insert, `updatedBy` on update and `deletedBy` on a soft delete, which `restore` clears. New column helpers `version()` and `actors()`, and new types `ActorOf`, `LockOf`, `UpdatePatch`, `ManyPatch`, `UpsertWhere`, `UpsertWhereOf`, `UpsertValues`; `Repository`, `BaseRepository` and `RepositoryOptions` take a fourth parameter, `TLock`, which defaults from the table.
  
  Two things change for an existing table. One with an integer `NOT NULL` column under the key `version` starts locking: an `update` that set `version` now checks it instead of writing it, and every update raises it — pass `optimisticLock: false` to keep the old behaviour. And `DataErrorCode` gains `'OPTIMISTIC_LOCK'`, so an exhaustive `Record<DataErrorCode, …>` needs the new key.

## 0.4.1

### Patch Changes

- [#75](https://github.com/softistx/nxgt-data/pull/75) [`7906e81`](https://github.com/softistx/nxgt-data/commit/7906e81d1b097f222f82db5de2e2b98d8054f72b) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The repository is a context plus modules by role, not one factory.
  
  Nothing a consumer can reach changed. `createRepository` takes the same
  arguments, returns the same shape, throws the same errors in the same order,
  and every `.d.ts` in the tarball is byte-identical to the one 0.4.0 shipped —
  only the bundled `pg/index.js` differs. The 113 tests were not touched, which
  is the point: an unchanged test count is the only evidence that a refactor
  moved nothing, and it is worth nothing if the tests moved too.
  
  `create-repository.ts` had reached 419 lines, and `build()` — the factory
  that closed over the database, the table, the resolved options and eleven
  inner functions — 353 of them. It is now 103 and 31.
  
  The resolved state is a `RepositoryContext` in `repository/context.ts`: five
  fields, data only, no closures, and no second copy of anything — the loosely
  typed handles Drizzle's per-table builders need are *read* from it by
  `builders(ctx)` rather than held on it, so there is no field that could drift
  from the database `run`'s transaction guard compares against.
  
  Every method is a plain function taking that context as its first argument:
  
  - `repository/filters.ts` — `byId`, `live`, `scoped`, `requireWhere`,
    `defaultOrder`
  - `repository/stamp-writes.ts` — the `updatedAt` policy
  - `repository/operations/reads.ts` — `findById`, `getById`, `findFirst`,
    `findMany`, `count`, `exists`
  - `repository/operations/writes.ts` — `create`, `update`, `delete`,
    `restore` and their bulk forms
  - `repository/operations/paginate.ts` — `paginate`, `paginateByCursor`
  
  `with(db)` no longer rebuilds from five positional arguments: it copies the
  context with the database replaced, which is also where `explicit` is set —
  the flag that tells the open-transaction refusal a caller named this database
  themselves.
  
  This is the seam `@nxgt/mongo`'s `collection/` has had since its own
  `build()` reached 487 lines, and the one `AGENTS.md` already told the next
  reader to cut here.
  
  The documentation audit that goes with it found one line the 0.4.0 revert had
  missed: the README's Traps section still called the held-database refusal an
  `ArgumentError`, while the same file says twice over that it is a bare
  `TypeError`. A consumer reading Traps would have written the 400 branch the
  whole design exists to avoid. Also corrected: `decodeCursor`'s fourth
  parameter, `table`, was missing from both signatures the docs publish; the
  README's "Writing" example now carries the `drizzle-orm` import its
  neighbours show; and `docs/troubleshooting.md` gains the entry for a
  `serializable` transaction refused with `sqlState: '40001'` — match on the
  field, not on a message PostgreSQL words differently per isolation level.

## 0.4.0

### Minor Changes

- [#72](https://github.com/softistx/nxgt-data/pull/72) [`1eb97c8`](https://github.com/softistx/nxgt-data/commit/1eb97c86b0f5f5a12e576c60eab5525b461a0bd3) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A repository call on the database an open transaction holds is refused, instead of never returning.
  
  ```ts
  const users = createRepository(db, usersTable);
  
  await withTransaction(db, async (tx) => {
    await users.create({ email: 'ada@example.com' });   // ← the mistake
  });
  ```
  
  That call asked the pool for a connection while the transaction was holding
  one, and nothing was going to hand one over until the transaction ended —
  which it could not do, because it was waiting for the call. Nothing threw and
  nothing timed out: the process simply stopped, and the only clue was a spec
  that ran out of time with no error to show for it.
  
  It now throws a `TypeError` naming the table and the two ways out:
  
  ```
  The repository for "users" is bound to the database withTransaction is holding
  open, so this call would wait for a connection that transaction will not
  release until it ends, and never return. Call .with(tx) to run it in the
  transaction, or .with(db) to say you mean the database itself.
  ```
  
  A **bare** `TypeError`, not an `ArgumentError`. That class is for a value
  that could have come from a request, so a handler answers it 400; no request
  can bind a repository to the wrong database. This one falls through to the
  500 branch on its own, and no handler needs an exception carved out of
  `argument`.
  
  `withTransaction` records the database it opened on in an `AsyncLocalStorage`
  for the length of the callback, and every repository call compares its own
  database against it. Five things follow, each covered by a test:
  
  - **`.with(tx)` is the fix**, and is never refused.
  - **`.with(db)` is never refused either.** Naming the database is how a caller
    says they mean it — work that should survive a rollback. Whether it then
    *runs* is the driver's business: with a pool it takes another connection;
    on a single-connection driver such as PGlite it deadlocks exactly as it did
    before. The refusal is for the repository nobody re-bound.
  - **A savepoint is not the mistake.** Only the outermost `withTransaction`
    records anything, so a repository bound to the outer transaction goes on
    working inside a nested one.
  - **Another database is left alone.** The comparison is against the database
    this transaction holds, not against "is a transaction open somewhere".
  - **It stops at the commit.** An async context outlives the call that made
    it, so a promise created inside the callback and awaited afterwards would
    otherwise still be refused, although the connection is back in the pool. A
    fire-and-forget one would be an unhandled rejection, which ends the process
    in Bun. The record is closed when the callback settles.
  
  The refusal is runtime-only: no type can tell which database a repository was
  built on. It compares by object identity and only `withTransaction` records
  anything, so three shapes still deadlock in silence and are now written down
  in the troubleshooting page: a repository on a second `drizzle()` handle over
  the same client, a transaction opened with Drizzle's own `db.transaction()`,
  and `withTransaction(db, …)` nested inside `withTransaction(db, …)`.

## 0.3.0

### Minor Changes

- [#70](https://github.com/softistx/nxgt-data/pull/70) [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A value the column's type refuses is an `InvalidValueError`, not a database
  error.
  
  ```ts
  await users.findById(c.req.param('id')); // 'nope', from a URL
  // InvalidValueError: invalid input syntax for type uuid: "nope"
  //   code: 'INVALID_VALUE', sqlState: '22P02'
  ```
  
  It used to come back as a plain `DataError` with `code: 'DATABASE'` — the
  same code as a server that is down — so a handler mapping codes to statuses
  answered 500 to what is a 400. `DataErrorCode` gains `INVALID_VALUE`, and
  `InvalidValueError` is exported beside the other classes.
  
  Its siblings are the same class: `22001` (longer than the column), `22003`
  (out of the type's range), `22007` and `22008` (a date or a time that is not
  one). A division by zero, `22012`, is deliberately **not** one of them — that
  is the query rather than a value handed to it, and it stays a `DataError`.
  
  Measured on PGlite 0.5.8, every one of these carries the database's sentence
  and nothing else: no `table`, no `column`, no `detail`. So `table` is
  `undefined` and `columns` is empty here, unlike on a constraint violation, and
  the database's own sentence is kept rather than rewritten into one that says
  less. That sentence can hold the value that was refused: log it, do not send
  it to a client.

- [#70](https://github.com/softistx/nxgt-data/pull/70) [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A pagination or cursor refusal names the call and the table.
  
  `paginate` and `paginateByCursor` both take numbers under the same names, and
  both used to refuse one with the same bare sentence:
  
  ```ts
  await posts.paginate({ page: 0 });
  // RangeError: paginate on "posts": page must be an integer of at least 1, not 0
  
  await posts.paginateByCursor({ after: cursorFromAnotherPage });
  // InvalidCursorError: Invalid cursor in paginateByCursor on "posts": it
  //                     holds 2 value(s) where the ordering id:asc needs 1 (id)
  ```
  
  The cursor messages keep `Invalid cursor` in front, because that is the part a
  consumer searches for; the call is named in the middle. `decodeCursor` takes
  an optional third argument to do the same for a caller paginating something
  this package knows nothing about, and `pageWindow` and `cursorLimit` take an
  optional trailing one. All are optional, so no existing call changes.
  
  `cursorLimit` is now exported, beside `pageWindow`, which `@nxgt/mongo`
  already did: a caller paginating something of their own could reach the
  offset half of this and not the cursor half, for no reason anybody wrote
  down.

## 0.2.0

### Minor Changes

- [#68](https://github.com/softistx/nxgt-data/pull/68) [`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19) Thanks [@SteveGT96](https://github.com/SteveGT96)! - An argument refused before any SQL is built is an `ArgumentError`.
  
  ```ts
  import { ArgumentError } from '@nxgt/drizzle';
  
  try {
  	await posts.findMany({ orderBy: { rank: 'sideways' } });
  } catch (error) {
  	if (error instanceof ArgumentError) {
  		// 400, not 500. `error.argument` is 'orderBy', `error.key` is 'rank'.
  	}
  }
  ```
  
  `DataError` and its subclasses are what the **database** said; this is what
  the *call* said, and the two are worth telling apart. A `where` or an
  `orderBy` assembled from a query string is user input, so a handler that
  wants to answer 400 rather than 500 needs to recognise it without matching
  the message. It carries `code: 'INVALID_ARGUMENT'`, the `argument` it is
  about, and the `key` inside that argument when one is at fault.
  
  **It extends `TypeError`**, which is what these five refusals already threw,
  so a `catch` written against the old ones still catches them.
  
  `updateMany`, `deleteMany` and `hardDeleteMany` refusing an empty `where` is
  an `ArgumentError` too, on the same argument: a `where` built from a request
  that comes out empty is the caller's input, and refusing to touch every row
  is a 400, not a 500. What a **definition** gets wrong — a table with no
  primary key, `restore` on a table with no soft delete — stays a bare
  `TypeError`: it cannot come from a request, and no handler should answer it.

## 0.1.2

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

## 0.1.1

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

## 0.1.0

### Minor Changes

- [#1](https://github.com/softistx/nxgt-data/pull/1) [`2323bbc`](https://github.com/softistx/nxgt-data/commit/2323bbc98ae2fe22b961bb76d8d866d605f6771e) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: typed repositories over a Drizzle table (`createRepository`), offset and cursor pagination, `withTransaction`, the package's own errors with `toDataError` mapping PostgreSQL's constraint violations, and the `id()`, `timestamps()` and `softDelete()` column helpers. PostgreSQL first, on drizzle-orm 1.0.
