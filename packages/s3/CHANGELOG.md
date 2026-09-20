# @nxgt/s3

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
