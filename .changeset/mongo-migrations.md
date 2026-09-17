---
"@nxgt/mongo": minor
---

Add migrations in code, under `@nxgt/mongo/migrations`.

- `defineMigration({ id, up, down?, transaction? })` declares one. `migrate(db, list, { to?, dryRun? })` applies the pending ones in order, each in a transaction together with its record. `transaction: false` is for index builds and `collMod`.
- `rollback(db, list, { to?, dryRun? })` undoes the last applied migration, or every one after `to`. It refuses before undoing anything if one of them has no `down`.
- `migrationStatus(db, list)` reports each migration as `applied`, `pending` or `missing`.
- The list may only grow at its end: an id listed twice, an applied migration no longer listed, or a pending one before an applied one is refused before anything runs.
- A renewed lock in `<collection>_lock` keeps two runs from migrating at once. A second run fails with `MigrationLockedError`, and a run that loses its lock stops before its next migration.
- New error codes: `MIGRATION` (`MigrationError`, which names the migration) and `MIGRATION_LOCKED`.
