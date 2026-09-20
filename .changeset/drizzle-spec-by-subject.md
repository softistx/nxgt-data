---
---

Specs only: nothing is published by this change.

`@nxgt/drizzle`'s `create-repository.spec.ts` was 433 lines covering four
subjects, left whole on purpose when the code under it was split — touching
it there would have destroyed the only evidence that the refactor moved
nothing. It now follows the code, beside it:

- `operations/reads.spec.ts` — the reads, and the `where`/`orderBy` they are
  built from
- `operations/writes.spec.ts` — creating, updating, deleting, and what the
  database says back when a write breaks a constraint
- `create-repository.spec.ts` — what the factory itself decides: primary
  keys, and `with()`

**31 tests before, 31 after; no name lost, added or changed** — only the
`describe` grouping. The whole suite is 113 pass either way, with the same
329 `expect()` calls.

Measured before committing to it, because a spec file costs a database:
`createTestDb` takes 0.8–2.0 s, so two more files projected to +2.6 s. The
real cost is **+0.5 s** — 10.05 s to 10.58 s — because PGlite is cheaper on
a warm process than on the first boot. The projection was the pessimistic
one, and worth making anyway: `@nxgt/s3`'s suite was split no further for
exactly this reason, where the number came back at +13 s on a 5 s suite.

Also measured on the way, and not acted on: bun 1.4.2 runs every spec file
in **one process with module state shared between them**, so a single PGlite
could serve the whole package. It is not a free win —
`open-transaction.spec.ts` depends on its own `close()` to settle a call it
leaves hanging on purpose — so it is a design decision of its own, not a
change to slip into a spec move.
