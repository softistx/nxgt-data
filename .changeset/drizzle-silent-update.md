---
'@nxgt/drizzle': minor
---

Add silent updates: `update(id, patch, { audit: false })` and `updateMany(where, patch, { audit: false })` leave `version`, `updatedAt` and `updatedBy` as they were, and every column declared with `$onUpdate` keeps its stored value, while still running in the repository's transaction and keeping the table's checks. An option other than a boolean `audit` is an `ArgumentError`. Same option name as `@nxgt/mongo` 0.24.
