---
"@nxgt/mongo-backup": patch
---

`mongoTarget({ replace: true })` now replaces a view standing where the backup holds a collection. The server renames over a collection but never over a view, so the restore used to reject with `EXISTS` and tell the caller to pass the `replace: true` they had already passed.
