---
'@nxgt/s3': minor
---

`put` takes what a write has to say about the object, not only its type.

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
