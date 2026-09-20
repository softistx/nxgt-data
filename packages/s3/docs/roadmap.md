# Roadmap

Where `@nxgt/s3` is going. A direction, not a commitment: the version an item
shipped in is the only number on this page.

## Now

_Nothing in progress._

## Next

_Nothing queued._

## Later

- **Copy and move** — once Bun's own `S3Client` has them. Until then
  `store.client` is where they live.

## Not planned

- **Running on Node** — the client is Bun's own `S3Client`, which is why this
  package installs no AWS SDK at all. There is nothing to swap for Node, and a
  build for it is not coming: it needs Bun 1.4 or later.
- **Multipart upload** — a body goes out in one `put`. For anything bigger,
  `store.file(params)` hands back Bun's own file handle and its `writer()`.
- **Bucket administration** — creating, deleting or configuring a bucket is
  not this package's, and Bun's client has no `createBucket` either.
- **Retries or a cache of its own** — Bun's client already retries (three
  attempts by default, and `retry` is passed through on `bindBucket`), and a
  failed request comes back with S3's own error, as `S3Error`.
- **Upload tuning on a `put`** — a `put` is a single PUT: measured against a
  12 MiB body, `partSize` changes nothing, right down to the ETag carrying no
  `-<parts>` suffix. `PutOptions` describes the object, not the transfer.
- **An option that says where a write goes** — `bucket`, `endpoint`, `region`
  and the credentials belong to the bound bucket, and are refused by the types
  and again at run time. Measured: passing them through let a bag store the
  object in a different bucket and report success, and redirected a signed URL
  the same way.

## Shipped

- **An option's own value is refused before anything is sent or signed** —
  `code: 'WRONG_OPTION'` for an `acl` or a `storageClass` a write names, for
  an `acl` on a presigned URL, and for an `expiresIn` outside the seven days
  S3 itself allows. Every refusal of a write or a signed URL is one class with
  a code to switch on, rather than an `S3Error` for the content type and the
  size and the client's own `TypeError` for the rest — 0.3.0.
- **Documentation that travels with the package** — a guide page for the
  bucket definition, writes, reads and presigned URLs, a troubleshooting page
  whose headings are the exact error text, and this roadmap, installed in
  `docs/` rather than left on GitHub — 0.2.1.
- **What a write may say about the object** — `contentDisposition`,
  `contentEncoding`, `acl` and `storageClass` on `put`, with Bun's own names;
  an option naming another bucket, endpoint, region or credential is refused,
  on `put` and on both `presign` calls — 0.2.0.
- **First release** — `defineBucket` naming the bucket, the key-building
  function, the content types it accepts and the biggest body it takes, and
  `bindBucket` giving `put`, `bytes`, `text`, `exists`, `stat`, `delete`, a
  cursor `list` and `presignGet` / `presignPut`; the content type and the size
  are checked before the request goes out, and its one error is `S3Error` —
  0.1.0.

Everything released is in [`CHANGELOG.md`](https://github.com/softistx/nxgt-data/blob/develop/packages/s3/CHANGELOG.md) — it is not in
the published package, only in the repository.
