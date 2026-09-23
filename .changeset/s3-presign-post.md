---
'@nxgt/s3': minor
---

`presignPost`, a presigned POST whose size and content type the service enforces.

`store.presignPost(params, options)` returns `{ url, fields }`, the form a browser posts straight to the bucket: every field, then the file. It signs an S3 POST policy (SigV4, with `node:crypto`, since Bun's `S3Client` has no POST presigning) that fixes the definition's key with `eq`, holds the body to `content-length-range`, and fixes the `Content-Type` with `eq`, or holds it to `{ startsWith }` on a bucket that names no type. Measured against SeaweedFS 4.47, the service refuses a body over the range with `400 EntityTooLarge`, one under it with `400 EntityTooSmall`, and another type, another key or an expired form with `403 AccessDenied`. A presigned PUT still constrains only the key and the deadline.

`maxSize` defaults to the bucket's own and cannot be above it, and a bucket without one requires it. `type` defaults to the bucket's `contentType` when that is a single type. `expiresIn` has the bounds the other presigned calls have (above 0, at most 604800 seconds) and defaults to a day, as Bun's does. Every refusal of an option is an `S3Error` with an existing code (`WRONG_OPTION` or `WRONG_TYPE`), raised before anything is signed. No new code was needed. Missing credentials are Bun's own `ERR_S3_MISSING_CREDENTIALS`, as for `presignPut`.

The form goes to the endpoint, region and access key that Bun signs a `presignPut` for, read off a URL Bun signs itself. The secret is the one given to `bindBucket`, or else `S3_SECRET_ACCESS_KEY` and then `AWS_SECRET_ACCESS_KEY`. It is kept beside the bucket's internal context, not on it, so printing the context, the bound bucket or the form never shows it.

**Refusal messages no longer quote the caller's value.** This affects code that matches message text. The codes are unchanged. The value can come off a request body, so a message now gives its shape:
- `put`: `"avatars" accepts image/png, image/jpeg, not the type given (put on "avatars")` (was `… not application/pdf`), and ``… and no content type was named. Pass `type` (put on "avatars")`` (was `… and this write names no content type. Pass `type``);
- `acl` and `storageClass`: `…; got another string (put on "avatars")` (was `…; got "everyone"`);
- `expiresIn`: `…; got a number above that`, `zero`, `NaN`… (was the value).

Every refusal now names the call and the bucket, in one of two forms. The refusals shared with `put` and the other presigned calls end with it, for example `(put on "avatars")` or `(presignPut on "avatars")`; that includes `TOO_LARGE` and `UNMEASURABLE` from `put`. `presignPost`'s own refusals, and the three errors below, lead with it: `presignPost on "avatars": …`.

Three errors from `presignPost` are not `S3Error`s, because none is a refusal of the caller's input:
- a plain `Error` when the URL Bun signed has no credential scope, or does not end in the probe key, so there is nowhere to post the form. Only a Bun that signs differently from 1.4.2 would do this, or an access key id holding a `%` that is not an escape. An id with a `=`, a `&`, a space or a non-ASCII character is not supported: Bun's own presigned URL is malformed for it;
- a `TypeError`, `the secret access key this package would sign with is not the one Bun signs with`, when the environment variable was changed after start-up;
- a `TypeError`, `no secret access key to sign with, while Bun has one`, when it was deleted after start-up.

For both `TypeError`s: Bun reads `S3_SECRET_ACCESS_KEY` and `AWS_SECRET_ACCESS_KEY` once, when the process starts, and this package reads them at `bindBucket`. If a variable is changed or deleted in between, the form would be signed with one secret while Bun signs with another, and the service would refuse it only when posted. `presignPost` recomputes the signature Bun put on a throwaway URL with its own secret, and refuses before signing when it has no secret or the two differ. Passing `secretAccessKey` to `bindBucket` avoids both.
