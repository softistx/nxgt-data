---
'@nxgt/s3': minor
---

Add `@nxgt/s3/testing`: `startTestS3({ binary, cacheDir })` starts a real S3 API (SeaweedFS) on free ports for a suite, and resolves to `{ endpoint, accessKeyId, secretAccessKey, region, options, createBucket, reset, stop }`, `options` being ready for `bindBucket`. The `weed` binary comes from the `binary` option, `$WEED_BIN`, the cache (`node_modules/.cache/@nxgt/s3/seaweedfs`) or a download checked against a SHA-256 pinned per platform asset. `seaweedfsBinary` and `TEST_SEAWEEDFS_VERSION` are exported too.
