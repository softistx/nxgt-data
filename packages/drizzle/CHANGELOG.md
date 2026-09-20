# @nxgt/drizzle

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
