# @nxgt/drizzle

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
