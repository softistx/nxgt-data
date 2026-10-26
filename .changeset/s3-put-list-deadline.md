---
'@nxgt/s3': minor
---

`put` and `list` take a deadline, as `stat`, `exists`, `bytes`, `text` and `delete` do: `put(params, body, { type, timeoutMs })` and `list({ prefix, limit, cursor, timeoutMs })`, or the bucket's `timeoutMs` default. No answer in time rejects with `S3Error` `TIMEOUT` (`put on "avatars": no answer in 5000ms`) and the request is aborted, which Bun's own `write` and `list` cannot do. With a deadline a `put` goes over `fetch` on a URL Bun signs (the type, disposition and encoding as plain headers) and a `list` signs its own ListObjectsV2 GET; without one, nothing changes.

**Behaviour change:** a bucket's `timeoutMs` now also bounds `put` and `list`. The deadline covers the whole upload, so a default sized for reads (say 5 s) can cut a large `put`: give a large `put` its own `timeoutMs`. Under a deadline a stream, a `Response` or an `S3File` body is read into memory first (a bucket with `maxSize` still refuses it before). A put under a deadline is one PUT: the bucket's `retry` does not apply, there is no multipart, and S3's 5 GiB single-PUT ceiling holds.

Fixes #258.
