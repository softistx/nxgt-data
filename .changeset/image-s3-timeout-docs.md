---
"@nxgt/image": patch
---

Troubleshooting: since `@nxgt/s3` 0.6.0 a bucket's `timeoutMs` bounds each variant `put` that `replace` makes, so a default sized for reads can end a `replace` with `S3Error` `TIMEOUT`. Raise the bucket's default; `replace` takes no per-call deadline.
