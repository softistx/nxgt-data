---
'@nxgt/drizzle': minor
---

A repository call on the database an open transaction holds is refused, instead of never returning.

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
