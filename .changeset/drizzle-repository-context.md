---
'@nxgt/drizzle': patch
---

The repository is a context plus modules by role, not one factory.

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
