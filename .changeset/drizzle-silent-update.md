---
'@nxgt/drizzle': minor
---

Add silent updates: `update(id, patch, { audit: false })` and `updateMany(where, patch, { audit: false })` leave `version`, `updatedAt` (an `$onUpdate` column included) and `updatedBy` as they were, while still running in the repository's transaction and keeping the table's checks. Same option name as `@nxgt/mongo` 0.24.
