---
'@nxgt/mongo': patch
---

`Mongo<C>` is covariant in its config again, as in 0.24.1 (fixes the 0.25.0 regression). 0.25.0 made `SoleScope<C>` (the type of `mongo.db`) a conditional on `IsSole<DbName<C>>`, which TypeScript measured as invariant: a `Mongo<A>` no longer converted to `Mongo<never>` or `Mongo<unknown>` with a plain `as`, and a Mongo opened from a config without `autoSync` was no longer assignable to `MongoOf` of the same config with `autoSync`. `database()` is unchanged: it still requires `from` once several databases are wired.
