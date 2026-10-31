---
"@nxgt/mongo": patch
---

`Mongo<any>` is assignable again to a structural type with a typed `db` (fixes the 0.25.1 regression): `SoleScope<any>` is `any`, as before, so `tx as unknown as EventsMongo` is no longer needed. `Mongo<C>` stays covariant for every other config.
