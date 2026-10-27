---
'@nxgt/s3': minor
---

Export `isBucketUnavailable(error)`: `true` for this package's `TIMEOUT`, for a Bun or Node network code (`ConnectionRefused`, `DNSResolveFailed`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, …) and for S3 service codes meaning the deployment cannot use the bucket (`AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `NoSuchBucket`, `ExpiredToken`, `InternalError`, `ServiceUnavailable`, `SlowDown`); `false` for the caller's refusals (`WRONG_TYPE`, `TOO_LARGE`, `UNMEASURABLE`, `WRONG_OPTION`) and per-request codes such as `NoSuchKey`. Reads the code only. Lets a route answer 503 when the bucket cannot be used.
