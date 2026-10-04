---
"@nxgt/backup": minor
---

Backup rotation: `prune({ keep, from, dryRun })` applies a retention policy to one repository under the lock — `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `within` and `maxTotalSize` (never below the newest `last`, or the newest backup) — and removes the rest, with backups that never got a manifest once they are older than `incompleteAfter`. Every decision says which rules kept a backup or why it went; `dryRun` removes nothing. `hold(id)` puts a legal hold, in every repository that holds the backup, that `prune` always respects until `unhold(id)`, and `list` reports it. A kept backup keeps the backups it builds on. The `LOCKED` message now reads "another create, prune or hold has the lock". A local repository now removes the folders a delete leaves empty.
