---
'@nxgt/drizzle': patch
---

`toDataError` reads the SQLSTATE from `errno` when `code` is not one, as Bun's `SQL` sends it (`code: 'ERR_POSTGRES_SERVER_ERROR'`, `errno: '23505'`). Over `drizzle-orm/bun-sql`, a unique violation is now a `ConflictError`, and every other database error a `DataError` with its `sqlState`, instead of Drizzle's `DrizzleQueryError` returned as it was. A field that is not a string is no longer read: on Bun every `Error` has a numeric `column`, the stack frame's, so a NOT NULL violation through postgres.js on Bun now names its column from `column_name` instead of reading `Column "15"`.
