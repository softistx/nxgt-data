---
"@nxgt/drizzle": patch
"@nxgt/drizzle-meilisearch": patch
"@nxgt/meilisearch": patch
"@nxgt/mongo": patch
"@nxgt/mongo-kit": patch
"@nxgt/mongo-meilisearch": patch
"@nxgt/mongo-search-kit": patch
"@nxgt/redis": patch
"@nxgt/redis-guard": patch
"@nxgt/redis-kit": patch
"@nxgt/s3": patch
---

Build and type-check under a stricter `tsconfig` — `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals` and the rest — so the published declarations compile under any of them in an application. One thing the built JavaScript does differently: class fields are defined as JavaScript defines them (`useDefineForClassFields`), so an error's fields are its own properties from construction, listed in the order they are declared. Their values are unchanged, and `GuardError.retryAfter` is still absent when it was not given.
