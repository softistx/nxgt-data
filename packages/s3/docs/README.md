# `@nxgt/s3` documentation

S3 on Bun's own `S3Client`. `S3Client` is built into Bun, so this package has
**no dependency at all** — no AWS SDK — and does not run on Node.

| Page | Read it when |
| --- | --- |
| [Buckets](guide/buckets.md) | you are describing a bucket, building its keys, or binding it to credentials |
| [Reading](guide/reads.md) | you want an object's bytes, its text, whether it is there, what the service knows about it, or a page of the bucket |
| [Writing](guide/writes.md) | you are storing an object, choosing what a write says about it, or handling a refusal |
| [Presigned URLs](guide/presigned-urls.md) | a browser or another service should read or write an object directly, without your credentials — and a presigned POST, when the service must hold the upload to a size and a type |
| [Troubleshooting](troubleshooting.md) | a call threw, an upload was refused, or a signed URL did not do what you expected |
| [Roadmap](roadmap.md) | you want to know what is coming, and what has been ruled out |

The [README](../README.md) is the short version: install, one example per
area, and the traps in one line each.
