---
'@nxgt/s3': minor
---

`bindBucket` takes `publicEndpoint`: the origin browsers reach the service at. `presignGet`, `presignPut` and `presignPost` are signed for it, while every other call keeps using `endpoint`, so a server behind a proxy no longer hairpins through it and no longer needs two bound buckets merged by hand. Left out, nothing changes. A value that is not an absolute URL is a `TypeError`. Fixes #328.
