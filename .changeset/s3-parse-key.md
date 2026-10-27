---
'@nxgt/s3': minor
---

Add an optional `parseKey(key): P | undefined` to `defineBucket`'s definition and `parseKey(key)` to the bound bucket: the way back from a stored object key to the params `key` built it from, `undefined` when the key is not the bucket's (also when the parsed params do not rebuild the same key). Without a `parseKey` on the definition, the bound one throws a `TypeError`. Additive. Fixes [#273](https://github.com/softistx/nxgt-data/issues/273).
