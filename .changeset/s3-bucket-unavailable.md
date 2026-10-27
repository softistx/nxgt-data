---
'@nxgt/s3': minor
---

Export `isBucketUnavailable(error)`: `true` for an `S3Error` and for an `Error` whose `code` is a Bun or Node network failure (`ConnectionRefused`, `DNSResolveFailed`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, …), reading the code only, never the message. Lets a route answer 503 when the bucket cannot be reached.
