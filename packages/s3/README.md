# @nxgt/s3

S3 on **Bun's own client** — no AWS SDK. A bucket is described once: which
bucket, how a key is built from the things that identify an object, and what
this application is willing to put there. Writes that break those rules are
refused **before anything is sent**, and presigned URLs come from the same
definition.

```ts
import { bindBucket, defineBucket } from '@nxgt/s3';

export const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 2 * 1024 * 1024,                   // bytes
});

const store = bindBucket(avatars, {
	endpoint: process.env.S3_ENDPOINT,
	accessKeyId: process.env.S3_KEY,
	secretAccessKey: process.env.S3_SECRET,
});

await store.put({ userId: 'u1' }, png, { type: 'image/png' });
const url = store.presignGet({ userId: 'u1' }, { expiresIn: 300 }); // seconds
```

`store.client` is Bun's `S3Client`, and `store.file(params)` its `S3File`:
everything this package does not wrap is still there.

> **0.x, on Bun's `S3Client`.** The API is still settling.

## Install

```sh
bun add @nxgt/s3 typescript @types/bun
```

- **Bun 1.4 or later, and Bun only.** `S3Client` is built into Bun, which is
  why there is no SDK to install — and why this package does not run on Node.
- `typescript` `^6.0.3`: required peer, the version every `@nxgt` package pins.
- `@types/bun`: required to typecheck. The shipped declarations name Bun's own
  `S3Client`, `S3File` and `S3Options`, so without Bun's types the first `tsc`
  fails with `Cannot find module 'bun'`.
- Tested against SeaweedFS 4.47's S3 gateway. Anything S3-compatible that Bun
  can sign for will do; a service that is not AWS wants
  `virtualHostedStyle: false`.

## What it does not do

- **No multipart upload.** A body goes in one `put`. Bun's own
  `file.writer()` is there for the rest, through `store.file(params)`.
- **No bucket administration.** Creating, deleting and configuring a bucket is
  not this package's, and Bun's client has no `createBucket` either.
- **No copy or move.** `store.client` is where those live when Bun grows them.
- **It adds no retry and no cache of its own.** A failed request comes back
  with S3's own error. Bun's client does retry — `retry`, three attempts by
  default — and that option is passed through to `bindBucket` like the rest;
  a `put` does not take it.

## API

### `defineBucket({ bucket, key, contentType, maxSize })`

Describes a bucket; it talks to nothing, so the definition is what a server
and a worker share. The key is a **function**, so nothing is spelled by hand
at a call site and a renamed parameter is a compile error.

| Field | |
| --- | --- |
| `bucket` | the bucket's name on the service |
| `key` | `(params) => string`, the object's key |
| `contentType` | a type, or a list of them, that this bucket accepts. Left out, anything goes |
| `maxSize` | the biggest body in **bytes**. Left out, anything goes |

### `bindBucket(definition, options?)`

`options` is Bun's own `S3Options` without `bucket`, passed through whole —
`endpoint`, `accessKeyId`, `secretAccessKey`, `region`, `sessionToken`,
`virtualHostedStyle`, and also `acl`, `storageClass`, `retry`, `partSize` and
`queueSize`. It is optional: given none, Bun reads its own `S3_*` / `AWS_*`
environment variables. Each bound bucket holds an `S3Client` of its own: S3 is
stateless HTTP, so there is no connection to share and nothing to close.

| `BoundBucket<P>` | |
| --- | --- |
| `client` | the `S3Client` this holds |
| `keyFor(params)` | the key it would use |
| `file(params)` | Bun's lazy `S3File`: `.stream()`, `.slice()`, `.writer()` |
| `put(params, body, options?)` | writes it, once the content type and size have accepted it. See `PutOptions` below |
| `bytes(params)` | the bytes, or `undefined` when there is no such object |
| `text(params)` | the body as text, or `undefined` |
| `exists(params)` | |
| `stat(params)` | Bun's `S3Stats` — `size`, `lastModified`, `etag`, `type` — or `undefined`. Note `etag`, lower case: that is Bun's field. A listing's `StoredObject` says `eTag` |
| `delete(params)` | |
| `list({ prefix, limit, cursor })` | one `ObjectPage` |
| `presignGet(params, { expiresIn, acl })` | a signed URL that reads it |
| `presignPut(params, { expiresIn, acl })` | a signed URL that writes it. It takes no `type` — see the Traps |
| `presignPost(params, { expiresIn, maxSize, minSize, type, acl })` | `{ url, fields }`, the form a browser posts to upload it. The **service** holds the upload to a size range and a content type — see below |

### What a write may say

```ts
await store.put({ userId: 'u1' }, Bun.file('ada.png'));   // the type comes from the file
await store.put({ userId: 'u1' }, png, {
	type: 'image/png',
	contentDisposition: 'attachment; filename="ada.png"',
	storageClass: 'STANDARD_IA',
});
```

| `PutOptions` | |
| --- | --- |
| `type` | the body's content type. A `Blob` — `Bun.file` included — is asked for its own when none is given, and *that* is the type the guard checks and the service receives |
| `contentDisposition` | how a reader should present it: measured, it comes back on a `GET` |
| `contentEncoding` | how the body is encoded, likewise returned on a read |
| `acl` | who may read it, where the service implements ACLs |
| `storageClass` | what it costs to keep, returned as `x-amz-storage-class` |

These are Bun's own names, picked out of its `S3Options`, so a Bun release
that changes one is a compile error here rather than a silent drift. Every
one of them describes the **object**; a write says nothing about where it
goes, or how it gets there — see the Traps.

Given both here and to `bindBucket`, the one on the write wins: it is the
last thing handed to the client.

### Uploading from a browser

`presignPost` signs an S3 **POST policy**: a form the browser posts straight to
the bucket, whose size and content type the service itself enforces. Use it
over `presignPut` whenever either matters.

```ts
// On the server: the bounds default to the bucket's own.
const form = store.presignPost(
	{ userId: 'u1' },
	{ type: 'image/png', expiresIn: 300 },     // maxSize: avatars' 2 MiB
);
return c.json(form);                           // { url, fields }
```

```ts
// In the browser: every field, then the file — last.
const { url, fields } = await (await fetch('/avatar-upload')).json();
const body = new FormData();
for (const [name, value] of Object.entries(fields)) body.append(name, value);
body.append('file', input.files[0]);
const response = await fetch(url, { method: 'POST', body });
// 204 when stored; 400 EntityTooLarge over maxSize; 403 AccessDenied otherwise
```

| `PresignPostOptions` | |
| --- | --- |
| `expiresIn` | seconds, 1 to 604 800, as for the other presigned calls. A day when left out |
| `maxSize` | the biggest body in bytes. Defaults to the bucket's `maxSize` and cannot be above it; a bucket without one **requires** it |
| `minSize` | the smallest body in bytes, `0` by default |
| `type` | the one content type the form carries, or `{ startsWith: 'image/' }`. Defaults to the bucket's `contentType` when that is a single type; a bucket that names several needs one of them. A prefix is only for a bucket that names none, and the browser then appends its own `Content-Type` field before the file |
| `acl` | fixed by the policy, from the same list as a write's |

The policy fixes the key with `eq`, the size with `content-length-range`, and
the content type with `eq` (or `starts-with`). Measured against SeaweedFS 4.47,
a body over the range is refused `400 EntityTooLarge`, under it
`400 EntityTooSmall`, and another type, another key or an expired form
`403 AccessDenied`. Bun's `S3Client` has no POST presigning, so this package
signs the policy itself (SigV4, `node:crypto`), for the same endpoint, region
and credentials Bun signs a `presignPut` for.

### Listing

```ts
let cursor: string | null = null;
do {
	const page = await store.list({ prefix: 'u1/', limit: 100, cursor });
	for (const object of page.items) console.log(object.key, object.size);
	cursor = page.nextCursor;
} while (cursor !== null);
```

`ObjectPage` is the same shape as the `CursorPage` of `@nxgt/drizzle` and
`@nxgt/mongo`, so a caller pages the same way everywhere: `items`, and a
`nextCursor` that is `null` on the last page. S3's `continuationToken` is what
it carries.

### Types

| Type | |
| --- | --- |
| `BucketDefinition<P>` | what `defineBucket` takes and gives back |
| `BoundBucket<P>` | what `bindBucket` gives back |
| `ObjectPage` | `{ items: StoredObject[]; nextCursor: string \| null }` |
| `StoredObject` | `{ key: string; size: number \| undefined; lastModified: Date \| undefined; eTag: string \| undefined }` — S3 does not promise the last three, so they are optional here |
| `PresignOptions` | `{ expiresIn?: number; acl?: … }` |
| `PresignPostOptions` | `{ expiresIn?; maxSize?; minSize?; type?: string \| { startsWith: string }; acl? }` |
| `PresignedPost` | `{ url: string; fields: Record<string, string> }` — post `fields`, then the file |
| `ParamsOf<D>` | what a definition's `key` takes, for a caller writing its own helper |
| `PutBody` | everything Bun's `write` takes |
| `PutOptions` | what one write may say about the object — see above |

`stat` gives back Bun's own `S3Stats`, which this package does not re-export;
import it from `bun` where you need to name it.

## Errors

`S3Error` is what this package throws, and **every one of them is thrown
before anything is sent**. It carries a `code` and the object `key` — never
the body, never a credential.

```ts
if (error instanceof S3Error && error.code === 'TOO_LARGE') {
	return c.json({ error: 'That file is too big' }, 413);
}
```

| `S3ErrorCode` | |
| --- | --- |
| `WRONG_TYPE` | the body's content type is not one this bucket accepts — or the write named none and the bucket names some. From `presignPost` too, and for a `{ startsWith }` on a bucket that names its types |
| `TOO_LARGE` | the body is bigger than `maxSize` |
| `UNMEASURABLE` | `maxSize` is set and the body's size cannot be known before sending |
| `WRONG_OPTION` | an option's own value is not one the service accepts: `acl` or `storageClass` on a write, `acl` or `expiresIn` on a presigned URL. On `presignPost`, also a `maxSize` or `minSize` that is not a whole number of bytes, a `maxSize` above the bucket's own or missing on a bucket without one, a `minSize` above the `maxSize`, and a `type` that is neither a string nor `{ startsWith }` |

`defineBucket` throws a `TypeError` for a definition that could never work: an
empty `bucket`, a `maxSize` that is not a positive number, an empty list of
content types. S3's own failures come back as they are, from Bun's client —
and **Bun names those `S3Error` too**, with S3's codes (`NoSuchKey` and the
rest). Discriminate with `instanceof S3Error` on this package's class, never
with `error.name`.

## What does not compile

Each is a `@ts-expect-error` case in `test/types/s3.ts`.

- An object read, written, deleted or signed for with the wrong key
  parameters, and a `put` given a misspelt option.
- A `put` or a presigned URL naming a `bucket`, an `endpoint`, a `region` or
  a credential: a write says what the object is, never where it goes.
- A `put` given `partSize`, `queueSize` or `retry`: those are the client's,
  and a `put` is one PUT.
- A `presignPut` given a `type`: a presigned PUT constrains no content type,
  so it takes none.
- A `presignPost` without its params, naming a `bucket`, an `endpoint` or a
  `region`, with a `maxSize` that is not a number, a `type` that is neither a
  string nor `{ startsWith }`, or an `acl` the service does not have.
- A definition with no `bucket`, no `key`, a `key` that gives something other
  than a string, a `maxSize` that is not a number, or a misspelt option.
- A presigned URL asked for without the params that identify the object, or
  with an `expiresIn` that is not a number.
- A listing asked for by page number, or a page read for a `total` — it pages
  by cursor, and S3 does not count.

## Traps

- **The guards are `put`'s, not the bucket's.** `contentType` and `maxSize`
  are checked here, in `put`, before the request goes out. They cost nothing
  and they catch the honest mistake, but nothing else on the object goes
  through them: `store.file(params).writer()` and `store.client` are Bun's own
  and write whatever they are given, and **anyone holding a presigned PUT can
  ignore them entirely**. A presigned **POST** is the exception: its policy
  carries the size and the type to the service, which enforces them.
- **A presigned PUT constrains the key and the deadline, and nothing else.**
  Not the size, not the content type — measured on Bun 1.4: `presign`'s `type`
  only adds `response-content-type`, which is S3's override for what a
  *download* is labelled, and `X-Amz-SignedHeaders` stays `host`, so the
  uploader's `Content-Type` is never signed. A URL signed for a `text/csv`
  bucket stores a zip happily. That is why `presignPut` takes no `type` at
  all: it would read as a guarantee it cannot make. **When the size or the
  type matters, use `presignPost`**, whose policy the service enforces.
- **A presigned POST's type is compared exactly, not on its essence.** The
  service matches the form's `Content-Type` field against the policy byte for
  byte — measured, `IMAGE/PNG` is refused for `image/png`, and
  `text/plain;charset=utf-8` for `text/plain`. The field is in `fields`, so post it as given; do not let the
  browser rewrite it. `put`'s own guard is the lenient one.
- **Post the file last.** S3 documents that a field after the file is
  ignored, so `fields` go first and `file` after them.
- **A body whose size cannot be known is refused, not streamed.** With
  `maxSize` set, a `Response`, a `Request` or another `S3File` throws
  `UNMEASURABLE`: nothing can check a length it has not read — an `S3File`
  reports its size as `NaN` until the service has been asked. Read it into
  memory first, or leave `maxSize` out and let the service refuse it.
- **A content type is compared on its essence.** `text/csv` accepts
  `text/csv;charset=utf-8` and `TEXT/CSV`, because that is what real bodies
  carry. Measured on bun 1.4.2, `Bun.file` puts a charset on some types and
  not others — `.txt` is `text/plain;charset=utf-8` and `.json` is
  `application/json;charset=utf-8`, while `.csv` is the bare `text/csv` — so
  a definition that named either form would refuse half the files it exists
  for. Parameters and case are ignored; nothing else is.
- **A write names the object, never where it goes.** `PutOptions` and
  `PresignOptions` carry no `bucket`, `endpoint`, `region` or credential, and
  the run time forwards only the keys they list. The types are not enough on
  their own: a bag that arrives in a request body never met them. Measured,
  spreading it straight through let a `bucket` key store the object in
  **another bucket** and report success, and sign a URL for that bucket —
  a credential key signed one against another endpoint entirely.
- **A `put` is one PUT, so it takes no upload tuning.** `partSize`,
  `queueSize` and `retry` belong to `bindBucket`, where they are the client's
  own. Measured on bun 1.4.2 against a 12 MiB body: a `put` with `partSize`
  set and one without come back with the **same** ETag, and neither carries
  the `-<parts>` suffix a multipart upload leaves. Use `file(params).writer()`
  for a body that wants parts.
- **A wrong `acl` or `storageClass` is `WRONG_OPTION`, not Bun's `TypeError`.**
  Both values are checked here, with the content type and the size — and an
  `acl` on a presigned URL against the same list — so one `catch` takes every
  refusal:
  `if (error instanceof S3Error) return c.json({ error: error.code }, 400);`.
  `contentDisposition` and `contentEncoding` are free strings and are never
  refused. `presignGet` and `presignPut` forward `acl` too, and go through the
  same allowlist. The accepted values are listed in
  [docs/guide/writes.md](docs/guide/writes.md).
- **A string body is measured in bytes, not in characters**, and `maxSize` is
  inclusive: 1024 passes, 1025 does not.
- **`expiresIn` is seconds, and Bun's default is a day.** Always pass one. An
  `S3Error` with `code: 'WRONG_OPTION'` refuses it above 604 800 seconds —
  seven days, S3's own cap on a presigned URL — at or below zero, and for
  anything that is not a finite number, so a signed URL this package hands
  back is one the service will accept.
- **A key is built, never guessed.** `keyFor` is there so a caller that needs
  the string gets *the* string; building one by hand somewhere else is how a
  bucket ends up with two spellings of the same object.
- **`delete` does not say whether anything was there.** S3 answers the same
  either way, and this package does not pretend otherwise. Call `exists`
  first when it matters.
- **A listing is eventually consistent on some services**, and `limit` is a
  maximum, not a promise: a page may come back shorter with a `nextCursor`
  still set. Page until `nextCursor` is `null`, never until a page is short.
- **`undefined` means "no such object", and nothing else.** `bytes`, `text`
  and `stat` read in one round trip and turn S3's own `NoSuchKey` into
  `undefined`; every other failure — a wrong secret, a refused request, a
  service that is down — comes back as the error it is.

## Documentation

- [docs/README.md](docs/README.md) — the guide index: buckets, reading,
  writing and presigned URLs, each with its options and a worked example.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT
