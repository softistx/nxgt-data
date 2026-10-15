---
"@nxgt/s3": minor
---

Add a deadline to the calls that wait on the service. `stat`, `exists`, `bytes`, `text` and `delete` take `{ timeoutMs }`, and `bindBucket` takes a default `timeoutMs`; no answer in time rejects with `S3Error` coded `TIMEOUT` and aborts the request. Bun's own S3 calls ignore an `AbortSignal` and give up after 360 s, so a call with a deadline signs a URL with Bun and sends it with `fetch`; a call without one is unchanged. A bad per-call `timeoutMs` is a `WRONG_OPTION` before anything is sent; a bad default on `bindBucket` is a bare `TypeError`. A failure while the response is read, or a refused connection, rejects in the shape Bun gives without a deadline (`S3Error`, `code` `ConnectionRefused` or `ConnectionClosed`, `path` the key) and never carries the signed URL. `exists` and `delete` are now `async`, so a `key` function that throws makes them reject rather than throw synchronously, like the other calls. New exported types: `CallOptions` and `BindOptions`.

`S3ErrorCode` gains `'TIMEOUT'`: an exhaustive `switch` over it now fails to compile until it handles the new member. `TIMEOUT` is the one code raised after a request was sent.
