# Roadmap

Where `@nxgt/drizzle` is going. A direction, not a commitment: the version an
item shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

- **A repository call inside a transaction is refused by name** — a repository
  built on the outer `db`, used inside `withTransaction`, is refused with an
  `ArgumentError` naming it and pointing at `.with(tx)`, instead of waiting
  forever on the connection the open transaction holds. `.with(db)` stays the
  explicit way to run work that should survive a rollback.

## Later

- **MySQL** — `createRepository`, pagination and `withTransaction` under
  `@nxgt/drizzle/mysql`, throwing the same error classes as
  `@nxgt/drizzle/pg`, so an `instanceof` works across dialects.
- **SQLite** — the same surface under `@nxgt/drizzle/sqlite`.

## Not planned

- **Drizzle 0.x** — this package is built on Drizzle 1.0's column types and
  relational queries, which 0.x does not have. The required peer is
  `drizzle-orm >=1.0.0-rc.4 <2`.
- **A driver of its own** — any Drizzle driver does (node-postgres,
  postgres-js, PGlite, Neon…), and a library that shipped one would give an
  app two copies of drizzle-orm and an `is()` that fails for one of them.
- **Reading the primary key off the table** — Drizzle 1.0's column types do
  not carry `.primaryKey()`, so nothing in the type says which column it is.
  The repository uses `id`, and `primaryKey` names another; a table whose key
  is elsewhere fails at the first call by id, with a message naming the option.
- **Signed cursors** — a cursor is encoded, not signed, deliberately: a forged
  one can still only ask for rows the query's own `where` allows, so signing
  would add a secret to configure and take nothing away.
- **Every SQLSTATE class 22 as an `InvalidValueError`** — the class is for a
  value a column's type refuses (`22P02`, `22001`, `22003`, `22007`, `22008`).
  Division by zero, `22012`, is the query rather than a value handed to it, and
  stays a `DataError`.
- **A `table` and a `column` on an invalid-value error** — measured on PGlite
  0.5.8, the database sends its sentence and nothing else for these codes, so
  `table` is `undefined` and `columns` is empty, unlike on a constraint
  violation. The database's own sentence is kept rather than rewritten into one
  that says less; it can hold the value that was refused, so log it rather than
  sending it to a client.
- **A page and its total in one query** — `paginate` sends the count and the
  read together, but two queries are still not one snapshot. Run it inside a
  `repeatable read` transaction when `total` has to be exact.

## Shipped

- **`InvalidValueError` for a value the column's type refuses** — SQLSTATE
  `22P02`, `22001`, `22003`, `22007` and `22008` come back with
  `code: 'INVALID_VALUE'` instead of `DATABASE`, so a handler mapping codes to
  statuses answers 400 for an id that arrived from a URL rather than the 500 a
  server that is down earns — 0.3.0.
- **A pagination or cursor refusal names the call and the table** — `paginate`
  and `paginateByCursor` take the same option names, and a refusal now says
  which of them refused it, and on which table; `decodeCursor`, `pageWindow`
  and `cursorLimit` take an optional argument that does the same for a listing
  of your own — 0.3.0.
- **`ArgumentError` for an argument refused before any SQL is built** —
  `code: 'INVALID_ARGUMENT'`, with the `argument` and the `key` at fault, so a
  handler answers 400 for a `where` or an `orderBy` that came from a
  query string without matching the sentence; it extends `TypeError`, which
  these were before, so a `catch` written against the old ones still catches
  them — 0.2.0.
- **Documentation that travels with the package** — a guide page for
  repositories, the schema helpers, pagination, transactions and the error
  classes, a troubleshooting page whose headings are the exact error text, and
  this roadmap, installed in `docs/` rather than left on GitHub — 0.1.2.
- **Behaviour that was measured and written down** — `findById` with a value
  the column's type refuses throws rather than reading nothing, and
  `paginate`'s two queries run together — 0.1.1.
- **First release** — typed repositories over a Drizzle table
  (`createRepository`), offset and cursor pagination, `withTransaction`,
  errors you can `instanceof` with `toDataError` mapping PostgreSQL's
  constraint violations, and the `id()`, `timestamps()` and `softDelete()`
  column helpers — 0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/drizzle/CHANGELOG.md) — it is not in
the published package, only in the repository.
