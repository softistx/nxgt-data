---
'@nxgt/image': minor
---

Add `cropFromQuery(params)` and `uploadImage(store, owner, request)`. `cropFromQuery` (main entry) reads the optional square crop from `?x=&y=&size=`: `undefined` when none of the three is present, otherwise a crop where a missing, blank or non-numeric value is `NaN`, which the set refuses as `INVALID_CROP`. `uploadImage` (`@nxgt/image/s3`) checks the request is `image/*` (`UNSUPPORTED_TYPE` otherwise), streams the body into `store.replace` under a fresh `crypto.randomUUID()` id with the query's crop, and returns `{ id, version, variants }`; a body over the byte limit is the usual `TOO_LARGE` `ImageError`.
