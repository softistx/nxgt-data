# @nxgt/s3

## 0.4.0

### Minor Changes

- [#96](https://github.com/softistx/nxgt-data/pull/96) [`45be51d`](https://github.com/softistx/nxgt-data/commit/45be51d6afb4bfa427137b16875f533b970cb6ca) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `presignPost`, a presigned POST whose size and content type the service enforces.
  
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

## 0.3.0

### Minor Changes

- [#68](https://github.com/softistx/nxgt-data/pull/68) [`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A wrong `acl`, `storageClass` or `expiresIn` is refused here, before anything
  is sent or signed.
  
  ```ts
  await reports.put('q1', csv, { acl: 'public' as never });
  // S3Error: acl must be one of private, public-read, …; got "public"
  ```
  
  `S3ErrorCode` gains `WRONG_OPTION`, so every refusal of a write or a signed
  URL is one class with a code to switch on. Bun checks these values as well,
  and refuses with a plain `TypeError` — measured on bun 1.4.2 — so one `put`
  had two classes of refusal: an `S3Error` with a code for the content type and
  the size, a `TypeError` with only a sentence for the rest.
  
  **`presignGet` and `presignPut` are held to the same guard.** They forward
  `acl` too, and forwarded it unchecked, so one mistake was two classes
  depending on which call it reached.
  
  **`expiresIn` is bounded at both ends.** Bun refuses `0` and below itself;
  measured, it *signs* an `expiresIn` of `1e12` happily, and S3 caps a
  presigned URL at seven days — so this package used to hand back a URL the
  service would reject at use time, which is the one thing it exists not to do.
  It is now `WRONG_OPTION` above 604 800 seconds, at or below zero, and for
  anything that is not a finite number.
  
  The accepted values live with the other guards and are proved exhaustive at
  compile time, the way the forwarded option names already were: a value Bun
  adds or drops fails the build here rather than silently widening or narrowing
  what this package accepts. `test/types/s3.ts` carries the `@ts-expect-error`
  cases for the two unions.

## 0.2.1

### Patch Changes

- [#66](https://github.com/softistx/nxgt-data/pull/66) [`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every package now ships a `docs/` folder, linked from its npm page.
  
  The README stays the short version: what the package is, how to install it,
  and one copy-paste example per area. `docs/` is the long one — a guide page
  per area with the option tables, the defaults, what is returned and what is
  thrown; a `troubleshooting.md` whose headings are the exact error text you
  would paste into a search box, with the line that prevents each one; and a
  `roadmap.md` saying what is coming, and what is deliberately not.
  
  `docs` is named in each package's `files`, so it travels in the tarball
  rather than living only on GitHub.

## 0.2.0

### Minor Changes

- [#62](https://github.com/softistx/nxgt-data/pull/62) [`8e90c23`](https://github.com/softistx/nxgt-data/commit/8e90c23e0015700d0b575714c6b0bc77cf132a1e) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `put` takes what a write has to say about the object, not only its type.
  
  ```ts
  await reports.put('q1', csv, {
  	type: 'text/csv',
  	contentDisposition: 'attachment; filename="q1.csv"',
  	storageClass: 'STANDARD_IA',
  });
  ```
  
  `contentDisposition`, `contentEncoding`, `acl` and `storageClass` — Bun's
  own names, picked out of its `S3Options`, so a Bun release that changes one
  is a compile error here rather than a silent drift. `PutOptions` is exported.
  Each describes the **object**. A `put` is a single PUT, so it takes no
  upload tuning: measured against a 12 MiB body, `partSize` changes nothing —
  the same ETag, with none of the `-<parts>` suffix a multipart upload leaves.
  
  **An option that names where a write goes is refused** — `bucket`,
  `endpoint`, `region` and the credentials belong to the bound bucket. The
  types refuse them, and so does the run time, because a bag that arrives in a
  request body never met the types. Measured, spreading it through to Bun let
  a `bucket` key store the object in a **different bucket** and report
  success. `presignGet` and `presignPut` are filtered the same way, and were
  carrying the same hole: a bag redirected the signed URL to another bucket,
  and a credential in it signed one against another endpoint.
  
  Also pinned by a spec at last: the content type a source carries by itself.
  `put(params, Bun.file('q1.csv'))` with no `type` is guarded on `text/csv`,
  stored as `text/csv`, and a `.txt` file is refused by a bucket that accepts
  only CSV — none of it typed out by the caller.

## 0.1.0

### Minor Changes

- [#47](https://github.com/softistx/nxgt-data/pull/47) [`8f2d234`](https://github.com/softistx/nxgt-data/commit/8f2d234ca87f54dc1ab038cc1565f8a3f683ce97) Thanks [@SteveGT96](https://github.com/SteveGT96)! - S3 on Bun's own `S3Client`, with no AWS SDK: `defineBucket` names the bucket,
  the function that builds an object's key, the content types it accepts and the
  biggest body it takes; `bindBucket` gives `put`, `bytes`, `text`, `exists`,
  `stat`, `delete`, a `list` in this repository's cursor shape, and
  `presignGet` / `presignPut` from the same definition. The content type and the
  size are checked **before** the request goes out. Its one error is `S3Error`.
