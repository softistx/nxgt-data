---
"@nxgt/mongo": patch
---

Compile under `exactOptionalPropertyTypes` and the rest of the stricter `tsconfig` an application may hold. `page`, `pageSize`, `withDeleted`, a collection's and a bucket's `session`, `startAfter` and a file listing's `after` take `undefined` as left out, and so does a field of an update's patch, which is dropped as before — so a validated body whose optional fields are typed `T | undefined` is a patch there too. `_id: undefined` stays refused, now by the types as well under that setting. Types only.
