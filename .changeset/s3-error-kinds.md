---
'@nxgt/s3': patch
---

The docs no longer say `S3Error` is the only error this package throws. The README, the troubleshooting page and `S3Error`'s own doc comment now call it the error class for refusals, and name the other kinds: a `TypeError` from `defineBucket` and from `presignPost` when its secret is not Bun's, and a plain `Error` when the URL Bun signed cannot be read. The presigned-URL guide now covers the deleted-secret `TypeError` and that plain `Error`, and links each one to its troubleshooting entry.
