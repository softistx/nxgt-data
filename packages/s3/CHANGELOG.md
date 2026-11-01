# @nxgt/s3

## 0.9.0

### Minor Changes

- [#329](https://github.com/softistx/nxgt-data/pull/329) [`5684944`](https://github.com/softistx/nxgt-data/commit/5684944b6f7f0aaeb6cb45f5dfc415398e90f04d) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `bindBucket` takes `publicEndpoint`: the origin browsers reach the service at. `presignGet`, `presignPut` and `presignPost` are signed for it, while every other call keeps using `endpoint`, so a server behind a proxy no longer hairpins through it and no longer needs two bound buckets merged by hand. Left out, nothing changes. A value that is not an absolute URL is a `TypeError`. Fixes [#328](https://github.com/softistx/nxgt-data/issues/328).

## 0.8.0

### Minor Changes

- [#306](https://github.com/softistx/nxgt-data/pull/306) [`24cc8a7`](https://github.com/softistx/nxgt-data/commit/24cc8a7d1fdf2442a6d7a15d9752bbce3900553c) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `@nxgt/s3/testing`: `TestS3.reset(bucket, { timeoutMs })` and `createBucket(name, { timeoutMs })` take an optional deadline. A stuck test S3 server now fails fast with an `S3Error` coded `TIMEOUT` that names the bucket, instead of hanging a test hook until the runner's own timeout. Without `timeoutMs` nothing changes.

## 0.7.1

### Patch Changes

- [#279](https://github.com/softistx/nxgt-data/pull/279) [`2220970`](https://github.com/softistx/nxgt-data/commit/2220970eb99151f643bba59409569dc236991ed6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `startTestS3`: two servers started at the same time could be handed overlapping port blocks, so one died with `bind: address already in use` on a gRPC port. A block is now claimed before it is probed and given back on `stop()`.

## 0.7.0

### Minor Changes

- [#270](https://github.com/softistx/nxgt-data/pull/270) [`d660cb3`](https://github.com/softistx/nxgt-data/commit/d660cb357013b374bb5676f824f52498b61992b7) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Export `isBucketUnavailable(error)`: `true` for this package's `TIMEOUT`, for a Bun or Node network code (`ConnectionRefused`, `DNSResolveFailed`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, …) and for S3 service codes meaning the deployment cannot use the bucket (`AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `NoSuchBucket`, `ExpiredToken`, `InternalError`, `ServiceUnavailable`, `SlowDown`); `false` for the caller's refusals (`WRONG_TYPE`, `TOO_LARGE`, `UNMEASURABLE`, `WRONG_OPTION`) and per-request codes such as `NoSuchKey`. Reads the code only. Lets a route answer 503 when the bucket cannot be used.

- [#274](https://github.com/softistx/nxgt-data/pull/274) [`8387457`](https://github.com/softistx/nxgt-data/commit/8387457d014630b80ef287efed972dadf4a4499e) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add an optional `parseKey(key): P | undefined` to `defineBucket`'s definition and `parseKey(key)` to the bound bucket: the way back from a stored object key to the params `key` built it from, `undefined` when the key is not the bucket's (also when the parsed params do not rebuild the same key). Without a `parseKey` on the definition, the bound one throws a `TypeError`. Additive. Fixes [#273](https://github.com/softistx/nxgt-data/issues/273).

## 0.6.0

### Minor Changes

- [#259](https://github.com/softistx/nxgt-data/pull/259) [`cb2efa4`](https://github.com/softistx/nxgt-data/commit/cb2efa45c73f4be7bc7bcf655f5797aa90c837b4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `put` and `list` take a deadline, as `stat`, `exists`, `bytes`, `text` and `delete` do: `put(params, body, { type, timeoutMs })` and `list({ prefix, limit, cursor, timeoutMs })`, or the bucket's `timeoutMs` default. No answer in time rejects with `S3Error` `TIMEOUT` (`put on "avatars": no answer in 5000ms`) and the request is aborted, which Bun's own `write` and `list` cannot do. With a deadline a `put` goes over `fetch` on a URL Bun signs (the type, disposition and encoding as plain headers) and a `list` signs its own ListObjectsV2 GET; without one, nothing changes.
  
  **Behaviour change:** a bucket's `timeoutMs` now also bounds `put` and `list`. The deadline covers the whole upload, so a default sized for reads (say 5 s) can cut a large `put`: give a large `put` its own `timeoutMs`. Under a deadline a stream, a `Response` or an `S3File` body is read into memory first (a bucket with `maxSize` still refuses it before). A put under a deadline is one PUT: the bucket's `retry` does not apply, there is no multipart, and S3's 5 GiB single-PUT ceiling holds.
  
  Fixes [#258](https://github.com/softistx/nxgt-data/issues/258).

## 0.5.0

### Minor Changes

- [#206](https://github.com/softistx/nxgt-data/pull/206) [`c3fa09b`](https://github.com/softistx/nxgt-data/commit/c3fa09b7647e066057fc698e4753aa5ac92a537a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A signed download link can now save the object under a name you choose:
  `store.presignGet(params, { expiresIn: 300, contentDisposition: "attachment; filename*=UTF-8''report.pdf" })`
  signs `response-content-disposition`, so the service serves that link with
  the header, whatever the object was stored with. `presignPost` takes a
  `contentDisposition` too, pinned in the policy as a `Content-Disposition`
  field. `presignPut` takes none (its type refuses it), and `PresignGetOptions`
  is exported.
  
  The value must be a non-empty string of printable ASCII, with no line break
  or control character; anything else is an `S3Error` with `code:
  'WRONG_OPTION'` and nothing is signed. `put`'s `contentDisposition` is held
  to the same check now: a value that is empty, not a string, or holds a
  control or non-ASCII character is refused before the write, where it used to
  reach the service as it came. A non-ASCII filename is spelled
  `filename*=UTF-8''...`, percent-encoded.

- [#208](https://github.com/softistx/nxgt-data/pull/208) [`e429ad4`](https://github.com/softistx/nxgt-data/commit/e429ad476954e007850b6d6309593d941ae11af4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/s3/testing`: `startTestS3({ binary, cacheDir })` starts a real S3 API (SeaweedFS) on free ports for a suite, and resolves to `{ endpoint, accessKeyId, secretAccessKey, region, options, createBucket, reset, stop }`, `options` being ready for `bindBucket`. The `weed` binary comes from the `binary` option, `$WEED_BIN`, the cache (`node_modules/.cache/@nxgt/s3/seaweedfs`) or a download checked against a SHA-256 pinned per platform asset. `seaweedfsBinary` and `TEST_SEAWEEDFS_VERSION` are exported too.

- [#207](https://github.com/softistx/nxgt-data/pull/207) [`c438095`](https://github.com/softistx/nxgt-data/commit/c438095f0beab05dc8e81b1f52d3e356111837f0) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add a deadline to the calls that wait on the service. `stat`, `exists`, `bytes`, `text` and `delete` take `{ timeoutMs }`, and `bindBucket` takes a default `timeoutMs`; no answer in time rejects with `S3Error` coded `TIMEOUT` and aborts the request. Bun's own S3 calls ignore an `AbortSignal` and give up after 360 s, so a call with a deadline signs a URL with Bun and sends it with `fetch`; a call without one is unchanged. A bad per-call `timeoutMs` is a `WRONG_OPTION` before anything is sent; a bad default on `bindBucket` is a bare `TypeError`. A failure while the response is read, or a refused connection, rejects in the shape Bun gives without a deadline (`S3Error`, `code` `ConnectionRefused`, `ConnectionClosed` or `DNSResolveFailed`, `path` the key) and never carries the signed URL; a 404 with no S3 body reads as missing on a read and as `NoSuchKey` on `delete`, as Bun's own path does. `exists` and `delete` are now `async`, so a `key` function that throws makes them reject rather than throw synchronously, like the other calls. New exported types: `CallOptions` and `BindOptions`.
  
  `S3ErrorCode` gains `'TIMEOUT'`: an exhaustive `switch` over it now fails to compile until it handles the new member. `TIMEOUT` is the one code raised after a request was sent.

## 0.4.4

### Patch Changes

- [#199](https://github.com/softistx/nxgt-data/pull/199) [`8a288ae`](https://github.com/softistx/nxgt-data/commit/8a288ae71d014c5637cf2ddb8a83053a8a3b6292) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Accept TypeScript 7 as a peer: the `typescript` peer range is now `^6.0.3 || ^7.0.0`.

## 0.4.3

### Patch Changes

- [#197](https://github.com/softistx/nxgt-data/pull/197) [`0895cc1`](https://github.com/softistx/nxgt-data/commit/0895cc1735181ba6ee624534b052f794d801433a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The declaration files now import each other with a `.js` extension, so a project with `moduleResolution: "nodenext"` (or `node16`) sees every export. Before, a name re-exported through a relative module was missing there (TS2305), as `@nxgt/mongo`'s were.

## 0.4.2

### Patch Changes

- [#143](https://github.com/softistx/nxgt-data/pull/143) [`85573aa`](https://github.com/softistx/nxgt-data/commit/85573aa3af6ac1863bd87a68f0fc5fda90c000bb) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Build and type-check under a stricter `tsconfig` — `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals` and the rest — so the published declarations compile under any of them in an application. One thing the built JavaScript does differently: class fields are defined as JavaScript defines them (`useDefineForClassFields`), so an error's fields are its own properties from construction, listed in the order they are declared. Their values are unchanged, and `GuardError.retryAfter` is still absent when it was not given.

- [#143](https://github.com/softistx/nxgt-data/pull/143) [`85573aa`](https://github.com/softistx/nxgt-data/commit/85573aa3af6ac1863bd87a68f0fc5fda90c000bb) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Compile under `exactOptionalPropertyTypes` and the rest of the stricter `tsconfig` an application may hold. A bucket's `contentType` and a presigned URL's `expiresIn` take `undefined` as left out. Types only.

## 0.4.1

### Patch Changes

- [#108](https://github.com/softistx/nxgt-data/pull/108) [`433dea2`](https://github.com/softistx/nxgt-data/commit/433dea2c4bb24303e5656343e23288547998a531) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The docs no longer say `S3Error` is the only error this package throws. The README, the troubleshooting page and `S3Error`'s own doc comment now call it the error class for refusals, and name the other kinds: a `TypeError` from `defineBucket` and from `presignPost` when its secret is not Bun's, and a plain `Error` when the URL Bun signed cannot be read. The presigned-URL guide now covers the deleted-secret `TypeError` and that plain `Error`, and links each one to its troubleshooting entry.

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
