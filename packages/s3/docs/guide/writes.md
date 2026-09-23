# Writing

Storing an object, saying what it is and how it should be served back, and
getting a refusal **before** anything goes over the wire.

## The smallest thing that works

```ts
import { bindBucket, defineBucket } from '@nxgt/s3';

const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 2 * 1024 * 1024,
});

const store = bindBucket(avatars);

await store.put({ userId: 'u1' }, png, { type: 'image/png' });
await store.delete({ userId: 'u1' });
```

Describing the bucket is [Buckets](buckets.md). `put` resolves when the
object is stored, and gives back nothing: S3 has nothing to say beyond that.

## The signatures

```ts
import type { S3Client, S3Options } from 'bun';

/** A string, bytes, a Blob, a Bun.file, a stream, a Response… */
type PutBody = Parameters<S3Client['write']>[1];

type PutOptions = Pick<
	S3Options,
	'type' | 'acl' | 'storageClass' | 'contentDisposition' | 'contentEncoding'
>;

put(params: P, body: PutBody, options?: PutOptions): Promise<void>;
delete(params: P): Promise<void>;
```

## What a body may be

Anything Bun's own `write` takes:

```ts
await store.put({ userId: 'u1' }, 'a,b\n1,2\n', { type: 'text/csv' });
await store.put({ userId: 'u1' }, new Uint8Array([1, 2, 3]), { type: 'image/png' });
await store.put({ userId: 'u1' }, Bun.file('ada.png')); // the type comes from the file
await store.put({ userId: 'u1' }, await fetch(url));    // only without `maxSize`
```

A `Blob` — `Bun.file` included — carries its own content type, so a write
that names none is still checked against one. A string is measured in
**bytes**, not characters.

## What a write may say about the object

Every option here describes **the object being stored**. A write says nothing
about where it goes or how it gets there: the bucket, the endpoint, the
region and the credentials belong to the bound bucket.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `type` | `string` | the body's own, for a `Blob` | the content type. It is the one the guard checks **and** the one the service receives — they can never be two different answers |
| `acl` | `'private' \| 'public-read' \| 'public-read-write' \| 'aws-exec-read' \| 'authenticated-read' \| 'bucket-owner-read' \| 'bucket-owner-full-control' \| 'log-delivery-write'` | the client's, else the service's | who may read the object, where the service implements ACLs |
| `storageClass` | `'STANDARD' \| 'STANDARD_IA' \| 'ONEZONE_IA' \| 'INTELLIGENT_TIERING' \| 'GLACIER' \| 'GLACIER_IR' \| 'DEEP_ARCHIVE' \| 'REDUCED_REDUNDANCY' \| 'EXPRESS_ONEZONE' \| 'OUTPOSTS' \| 'SNOW'` | the client's, else `STANDARD` | what it costs to keep it; comes back as `x-amz-storage-class` |
| `contentDisposition` | `string` | none | how a reader should present it; comes back on a `GET` |
| `contentEncoding` | `string` | none | how the body is encoded; comes back on a `GET` |

```ts
await store.put({ userId: 'u1' }, png, {
	type: 'image/png',
	contentDisposition: 'attachment; filename="ada.png"',
	contentEncoding: 'identity',
	storageClass: 'STANDARD_IA',
	acl: 'public-read',
});
```

Measured against a real service: `contentDisposition` and `contentEncoding`
come back as the headers of the same name on a read, and `storageClass` as
`x-amz-storage-class`.

These are Bun's own names, picked out of its `S3Options`, so a Bun release
that changes one is a compile error here rather than a silent drift. Given
both here and to `bindBucket`, the one on the write wins: it is the last
thing handed to the client.

### An option's *value* is checked here too

`acl` and `storageClass` are unions, and the values listed above are the only
ones the service takes. A bag off a request body never met those types, so
the value is checked at run time as well — before anything is sent, with the
content type and the size, and as the same `S3Error`:

```ts
import { S3Error, type PutOptions } from '@nxgt/s3';

const bad = { type: 'text/plain', storageClass: 'CHEAP' } as unknown as PutOptions;

const error = (await store
	.put({ userId: 'u1' }, 'a,b\n', bad)
	.catch((reason: unknown) => reason)) as S3Error;

error instanceof S3Error; // true
error.code;               // 'WRONG_OPTION'
error.message;            // 'storageClass must be one of STANDARD, DEEP_ARCHIVE, …; got "CHEAP"'
error.key;                // 'u1.png' — the key, never the body
// Nothing was stored: `await store.exists({ userId: 'u1' })` is still false.
```

Bun checks both values as well, and refuses with a plain `TypeError`
(measured on bun 1.4.2). That left one `put` with two classes of refusal —
an `S3Error` with a code for the content type and the size, a `TypeError`
with only a sentence for these two. Checking here means one `put` has one
class of refusal, with a code to switch on. `contentDisposition` and `contentEncoding` are free strings
and are never refused, by this package or by Bun.

The same allowlist holds `acl` on a
[presigned URL](presigned-urls.md#options), so a wrong value is the same
`WRONG_OPTION` whichever call a consumer reached for.

### A write cannot change where it goes

`PutOptions` carries no `bucket`, `endpoint`, `region` or credential, and the
run time forwards only the five keys above — a key that is not in that list
is dropped, never sent.

```ts
// A bag off a request body never met the types.
const smuggled = {
	type: 'text/plain',
	bucket: 'somewhere-else',
	accessKeyId: 'someone-else',
} as PutOptions;

await store.put({ userId: 'u1' }, 'x', smuggled);
// Stored in `avatars`, with the credentials the bucket was bound with.
```

Measured before that filter existed, spreading the caller's options straight
through let a `bucket` key store the object in another bucket — and report
success.

### A `put` is one PUT

`partSize`, `queueSize` and `retry` are not `PutOptions`: they belong to
[`bindBucket`](buckets.md), where they are the client's own. Measured on bun
1.4.2 against a 12 MiB body, a `put` with `partSize` set and one without come
back with the **same** ETag, and neither carries the `-<parts>` suffix a
multipart upload leaves. For a body that wants parts, use
`store.file(params).writer()`.

## The guards

`contentType` and `maxSize` on the definition are checked in `put`, before
the request goes out. A refused body is never sent.

```ts
import { S3Error } from '@nxgt/s3';

try {
	await store.put({ userId: 'u1' }, pdf, { type: 'application/pdf' });
} catch (error) {
	if (error instanceof S3Error) {
		error.code; // 'WRONG_TYPE'
		error.key;  // 'u1.png' — the key, never the body
	}
}
```

| `S3ErrorCode` | When |
| --- | --- |
| `WRONG_TYPE` | the type is not one this bucket accepts — or the write named none and the body carries none, while the bucket names some |
| `TOO_LARGE` | the body is bigger than `maxSize`. The limit is inclusive: with `maxSize: 1024`, 1024 bytes passes and 1025 does not |
| `UNMEASURABLE` | `maxSize` is set and the body's size cannot be known before sending |
| `WRONG_OPTION` | the write's `acl` or `storageClass` is not a value the service accepts — see [above](#an-options-value-is-checked-here-too) |

A content type is compared on its **essence**: parameters and case are
ignored, and nothing else is. A bucket that accepts `text/csv` accepts
`text/csv;charset=utf-8` and `TEXT/CSV`, because that is what real bodies
carry — measured, `Bun.file` labels `.txt` as `text/plain;charset=utf-8` and
`.csv` as the bare `text/csv`.

```ts
const reports = defineBucket({
	bucket: 'reports',
	key: (id: string) => `${id}.csv`,
	contentType: 'text/csv',
});
const csv = bindBucket(reports);

await csv.put('q1', Bun.file('q1.csv'));  // stored
await csv.put('q1', Bun.file('note.txt')); // S3Error WRONG_TYPE, nothing sent
```

`UNMEASURABLE` is the one that surprises: with `maxSize` set, a `Response`, a
`Request`, a stream or another `S3File` is **refused, not streamed** —
nothing can check a length it has not read, and an `S3File` reports its size
as `NaN` until the service has been asked. Read it into memory first, or
leave `maxSize` out and let the service refuse an oversized body.

```ts
const answer = await fetch(url);
const body = new Uint8Array(await answer.arrayBuffer()); // now it has a length
await store.put({ userId: 'u1' }, body, { type: 'image/png' });
```

The guards are `put`'s, not the bucket's: `store.file(params).writer()`,
`store.client` and anyone holding a [presigned PUT](presigned-urls.md) write
whatever they are given. For a browser upload that must respect the size and
the type, hand out a
[presigned POST](presigned-urls.md#a-presigned-post-the-service-holds-the-size-and-the-type)
instead: its policy carries `maxSize` and `contentType` to the service, which
enforces them.

## Deleting

```ts
await store.delete({ userId: 'u1' });
```

S3 does not say whether anything was there, and nor does this. Call `exists`
first when it matters — see [Reading](reads.md).

## A real one: an upload route

```ts
import { Hono } from 'hono';
import { bindBucket, defineBucket, S3Error } from '@nxgt/s3';

const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 2 * 1024 * 1024,
});

const store = bindBucket(avatars);
const app = new Hono();

app.put('/users/:id/avatar', async (c) => {
	const userId = c.req.param('id');
	const body = await c.req.blob(); // a Blob: it carries its own type

	try {
		await store.put({ userId }, body, {
			contentDisposition: `inline; filename="${userId}.png"`,
		});
	} catch (error) {
		if (error instanceof S3Error && error.code === 'WRONG_TYPE') {
			return c.json({ error: 'Send a PNG or a JPEG' }, 415);
		}
		if (error instanceof S3Error && error.code === 'TOO_LARGE') {
			return c.json({ error: 'That file is too big' }, 413);
		}
		throw error;
	}

	return c.json({ key: store.keyFor({ userId }) }, 201);
});
```

Every `S3Error` is thrown before the request goes out, so a 413 costs no
bandwidth. Bun names **its own** S3 failures `S3Error` too, with S3's codes:
discriminate with `instanceof S3Error` on this package's class, never with
`error.name`.

## Next

- [Reading](reads.md) — reading back what was written.
- [Presigned URLs](presigned-urls.md) — letting a browser upload directly:
  what a presigned PUT does *not* constrain, and the presigned POST that
  does.
- [Troubleshooting](../troubleshooting.md) — each error with its fix.
