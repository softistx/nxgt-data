---
'@nxgt/s3': minor
---

`presignPost`, a presigned POST whose size and content type the service enforces.

`store.presignPost(params, options)` returns `{ url, fields }`, the form a browser posts straight to the bucket: every field, then the file. It signs an S3 POST policy (SigV4, with `node:crypto`, since Bun's `S3Client` has no POST presigning) that fixes the definition's key with `eq`, holds the body to `content-length-range`, and fixes the `Content-Type` with `eq`, or holds it to `{ startsWith }` on a bucket that names no type. Measured against SeaweedFS 4.47, the service refuses a body over the range with `400 EntityTooLarge`, one under it with `400 EntityTooSmall`, and another type, another key or an expired form with `403 AccessDenied`. A presigned PUT still constrains only the key and the deadline.

`maxSize` defaults to the bucket's own and cannot be above it, and a bucket without one requires it. `type` defaults to the bucket's `contentType` when that is a single type. `expiresIn` has the bounds the other presigned calls have (above 0, at most 604800 seconds) and defaults to a day, as Bun's does. Every refusal of an option is an `S3Error` with an existing code (`WRONG_OPTION` or `WRONG_TYPE`), raised before anything is signed. No new code was needed. Missing credentials are Bun's own `ERR_S3_MISSING_CREDENTIALS`, as for `presignPut`.

The form goes to the endpoint, region and access key that Bun signs a `presignPut` for, read off a URL Bun signs itself. The secret is the one given to `bindBucket`, or else `S3_SECRET_ACCESS_KEY` and then `AWS_SECRET_ACCESS_KEY`. It is kept beside the bucket's internal context, not on it, so printing the context, the bound bucket or the form never shows it.

**Refusal messages no longer quote the caller's value.** This affects code that matches message text. The codes are unchanged. The value can come off a request body, so a message now gives its shape:
- `put`: `"avatars" accepts image/png, image/jpeg, not the type given` (was `not application/pdf`), and ``… and no content type was named. Pass `type` `` (was `… and this write names no content type …`);
- `acl` and `storageClass`: `…; got another string` (was `got "everyone"`);
- `expiresIn`: `…; got a number above that`, `zero`, `NaN`… (was the value).

A refusal from `presignGet`, `presignPut` or `presignPost` also ends with the call, for example `(presignPut)`.
