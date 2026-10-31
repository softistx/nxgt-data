---
"@nxgt/s3": minor
---

`@nxgt/s3/testing`: `TestS3.reset(bucket, { timeoutMs })` and `createBucket(name, { timeoutMs })` take an optional deadline. A stuck test S3 server now fails fast with an `S3Error` coded `TIMEOUT` that names the bucket, instead of hanging a test hook until the runner's own timeout. Without `timeoutMs` nothing changes.
