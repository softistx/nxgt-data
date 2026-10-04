---
"@nxgt/mongo-backup": patch
---

Docs: a new guide, "Running it in production". It covers where each key lives, a scheduled job (a full backup weekly, incrementals in between, a full one on `HISTORY_LOST`, verify, rotation), the oplog and snapshot windows, alerting, restore drills, and what to run the day you need a backup back. It ships with the runnable example `examples/mongo-backup-job`.
