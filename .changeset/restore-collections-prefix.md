---
"@nxgt/mongo-backup": patch
---

`restoreCollections`, called directly, now names itself in what the restore into its scratch database refuses: a `mongoTarget:` message reaches you as `restoreCollections: …`, with the same class and code, the original as `cause` — as `mongoBackups`'s `run`, `restore` and `drill` already did.
