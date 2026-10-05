---
"@nxgt/redis-guard": minor
---

`@nxgt/redis-guard` is deprecated: its API moved into `@nxgt/redis`, and this package now only re-exports it, under the same names and with the same messages — `defineRateLimit`, `bindRateLimit`, `defineIdempotency`, `bindIdempotency`, `GuardError`, `GuardErrorCode` and the types, each marked `@deprecated`. `@nxgt/redis` is its one peer besides `typescript` (`zod` comes with it), and the docs are gone from the package — they live in `@nxgt/redis`. Nothing a caller wrote has to change but the import: `GuardError` from either package is one class, so an `instanceof` still holds across both. Move to `@nxgt/redis` when you can: `bun add @nxgt/redis`, then change the import.
