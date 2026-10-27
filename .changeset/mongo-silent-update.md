---
'@nxgt/mongo': minor
---

Add silent updates: `update(id, patch, { audit: false })` and `updateMany(filter, patch, { audit: false })` leave `version`, `updatedAt` and `updatedBy` as they were and run no hook, while still running in the collection's session and coercing the patch. MongoDB's change stream still reports the write.
