---
"@nxgt/backup": minor
---

A single-writer lock: `create` now takes a lock in every repository it writes to, renewed while it runs, so two runs of the same backup never write to one repository at once. A repository whose lock is held elsewhere fails with the new code `LOCKED`; one whose lease could not be renewed in time starts no further write there and fails with the new code `LEASE_LOST`. The other repositories go on. `bindBackup` takes `lock: { lease }` (5 minutes by default). `list` no longer fails when a backup disappears between its listing and its read.
