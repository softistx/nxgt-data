# Troubleshooting

This package throws one error of its own, `S3Error`, with a `code` of
`WRONG_TYPE`, `TOO_LARGE` or `UNMEASURABLE`, and the object `key` it was
about — never the body. Every one of them is raised **before** anything is
sent. The service's own failures, and the checks Bun makes on an option's
value, come back as Bun raises them; the entries below say which is which.
The Bun messages were measured on Bun 1.4.2.

- **Install and import**
  - [`Cannot find package 'bun'`](#cannot-find-package-bun)
  - [`Cannot find module 'bun' or its corresponding type declarations.`](#cannot-find-module-bun-or-its-corresponding-type-declarations)
- **Configuration**
  - [`defineBucket: a bucket definition needs a bucket`](#definebucket-a-bucket-definition-needs-a-bucket)
  - [`defineBucket: "avatars" has a maxSize of 0; it is a number of bytes, and must be above zero`](#definebucket-avatars-has-a-maxsize-of-0-it-is-a-number-of-bytes-and-must-be-above-zero)
  - [`defineBucket: "avatars" accepts an empty list of content types, so nothing could ever be written. …`](#definebucket-avatars-accepts-an-empty-list-of-content-types-so-nothing-could-ever-be-written-)
- **Writes refused before they are sent**
  - [`"avatars" accepts image/png, image/jpeg, not application/pdf`](#avatars-accepts-imagepng-imagejpeg-not-applicationpdf)
  - [``"avatars" accepts image/png, image/jpeg, and this write names no content type. Pass `type` ``](#avatars-accepts-imagepng-imagejpeg-and-this-write-names-no-content-type-pass-type-)
  - [`"avatars" accepts 2097152 bytes at most, and this body is 5242880`](#avatars-accepts-2097152-bytes-at-most-and-this-body-is-5242880)
  - [`"avatars" has a maxSize, and this body's size cannot be known before sending it. …`](#avatars-has-a-maxsize-and-this-bodys-size-cannot-be-known-before-sending-it-)
  - [`storageClass must be one of "STANDARD", "STANDARD_IA", "INTELLIGENT_TIERING", …`](#storageclass-must-be-one-of-standard-standard_ia-intelligent_tiering-)
  - [`acl must be one of "private", "public-read", "public-read-write", …`](#acl-must-be-one-of-private-public-read-public-read-write-)
- **The service**
  - [`Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required`](#missing-s3-credentials-accesskeyid-secretaccesskey-bucket-and-endpoint-are-required)
  - [`The AWS Access Key Id you provided does not exist in our records.`](#the-aws-access-key-id-you-provided-does-not-exist-in-our-records)
  - [A presigned upload stored a body the bucket would have refused](#a-presigned-upload-stored-a-body-the-bucket-would-have-refused)
  - [A listing came back short with a cursor still set](#a-listing-came-back-short-with-a-cursor-still-set)

## Install and import

### `Cannot find package 'bun'`

**When:** importing `@nxgt/s3` under Node — the full line names the file it
was imported from.
**Why:** the client is Bun's own `S3Client`, which is why there is no AWS SDK
to install and why this package does not run on Node. Measured on Node 22.
**Fix:**

```sh
bun run ./src/index.ts   # Bun 1.4 or later
```

### `Cannot find module 'bun' or its corresponding type declarations.`

**When:** typechecking, on the first file that imports `@nxgt/s3`.
**Why:** the shipped declarations import `S3Client`, `S3File` and `S3Options`
from `bun`, so your project needs Bun's types. They are not a dependency of
this package.
**Fix:**

```sh
bun add -d @types/bun
```

## Configuration

### `defineBucket: a bucket definition needs a bucket`

**When:** at `defineBucket`, with an empty `bucket`.
**Why:** the bucket name is what every key is written under; an empty one
cannot be meant.
**Fix:**

```ts
export const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
});
```

### `defineBucket: "avatars" has a maxSize of 0; it is a number of bytes, and must be above zero`

**When:** at `defineBucket`.
**Why:** `maxSize` is a number of **bytes**, and it is inclusive: 1024 passes
and 1025 does not. A string body is measured in bytes, not in characters.
**Fix:**

```ts
defineBucket({ bucket: 'avatars', key, maxSize: 2 * 1024 * 1024 });
```

### `defineBucket: "avatars" accepts an empty list of content types, so nothing could ever be written. …`

**When:** at `defineBucket`, with `contentType: []`.
**Why:** an empty list refuses every write. The message ends with the way out,
``Leave `contentType` out to accept anything``: leaving the option out is what
accepts anything, and `[]` is never what was meant.
**Fix:**

```ts
defineBucket({ bucket: 'avatars', key, contentType: ['image/png', 'image/jpeg'] });
```

## Writes refused before they are sent

### `"avatars" accepts image/png, image/jpeg, not application/pdf`

**When:** `put` or `presignGet`, with a `type` the definition does not list.
**Why:** an `S3Error` with `code: 'WRONG_TYPE'`. Nothing was sent. The type
is compared on its **essence**: `text/csv` accepts `text/csv;charset=utf-8`
and `TEXT/CSV`, because that is what real bodies carry — parameters and case
are ignored, nothing else is.
**Fix:**

```ts
import { S3Error } from '@nxgt/s3';

try {
	await avatars.put({ userId }, body, { type: file.type });
} catch (error) {
	if (error instanceof S3Error && error.code === 'WRONG_TYPE') return badRequest();
	throw error;
}
```

### ``"avatars" accepts image/png, image/jpeg, and this write names no content type. Pass `type` ``

**When:** `put` on a bucket with `contentType`, for a body that carries no
type of its own — a string, a typed array, a stream.
**Why:** the guard cannot accept what it cannot read, so an unnamed type is
refused rather than guessed. `code: 'WRONG_TYPE'`.
**Fix:**

```ts
await avatars.put({ userId }, bytes, { type: 'image/png' });
```

`Bun.file(path)` carries its own type, and does not need the option.

### `"avatars" accepts 2097152 bytes at most, and this body is 5242880`

**When:** `put`, for a body whose size is known and above `maxSize`.
**Why:** an `S3Error` with `code: 'TOO_LARGE'`, raised before the request goes
out.
**Fix:**

```ts
if (error instanceof S3Error && error.code === 'TOO_LARGE') return payloadTooLarge();
```

### `"avatars" has a maxSize, and this body's size cannot be known before sending it. …`

**When:** `put` with `maxSize` set, for a `Response`, a `Request`, a stream or
another `S3File`.
**Why:** nothing can check a length it has not read — an `S3File` reports its
size as `NaN` until the service has been asked — so the write is refused
rather than streamed unchecked. `code: 'UNMEASURABLE'`. The message ends with
the two ways out, ``Read it into memory first, or drop `maxSize` and let the
service refuse it``.
**Fix:**

```ts
await avatars.put({ userId }, await response.bytes()); // read it in first
```

Or drop `maxSize` from the definition and let the service refuse an oversized
body.

### `storageClass must be one of "STANDARD", "STANDARD_IA", "INTELLIGENT_TIERING", …`

**When:** `put` or `presignPut` with a `storageClass` Bun does not know.
**Why:** an option's **value** is Bun's to check, and it throws **Bun's own
`TypeError`** — not an `S3Error`. `instanceof S3Error` is false, and
`error.code` is not one of this package's. Nothing is sent either way; it is
the class a handler catches that differs.
**Fix:**

```ts
import type { PutOptions } from '@nxgt/s3';

// the classes this application allows, proved against Bun's own list
const CLASSES = ['STANDARD', 'STANDARD_IA'] as const satisfies readonly NonNullable<
	PutOptions['storageClass']
>[];

function storageClassOf(value: string | undefined): PutOptions['storageClass'] {
	return CLASSES.find((known) => known === value); // undefined: the bucket's default
}

await avatars.put({ userId }, bytes, { storageClass: storageClassOf(body.storageClass) });
```

Catch `TypeError` beside `S3Error` where such a value can reach a call.

### `acl must be one of "private", "public-read", "public-read-write", …`

**When:** `put`, `presignGet` or `presignPut` with an `acl` Bun does not
know.
**Why:** the same as `storageClass`: Bun's own `TypeError`, before anything is
sent. `contentDisposition` and `contentEncoding`, by contrast, are plain
strings to Bun and accept anything.
**Fix:**

```ts
await avatars.put({ userId }, bytes, { acl: 'public-read' });
```

## The service

### `Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required`

**When:** the first call, when neither `bindBucket`'s options nor the
environment gave the client credentials. Bun's error, `code:
'ERR_S3_MISSING_CREDENTIALS'`.
**Why:** `bindBucket` creates the `S3Client` for you and passes your options
through; with none, Bun falls back to the environment, and to AWS's endpoint.
**Fix:**

```ts
export const avatars = bindBucket(avatarsDefinition, {
	endpoint: process.env.S3_ENDPOINT,
	accessKeyId: process.env.S3_KEY,
	secretAccessKey: process.env.S3_SECRET,
	virtualHostedStyle: false, // for a service that is not AWS
});
```

### `The AWS Access Key Id you provided does not exist in our records.`

**When:** the first call, with credentials the service refuses — or with no
`endpoint`, which sends the request to AWS whatever your service is.
**Why:** it is the **service's** answer, raised by Bun as an error whose
`name` is `S3Error` and whose `code` is the S3 code (`InvalidAccessKeyId`,
`SignatureDoesNotMatch`, `NoSuchBucket`, `AccessDenied`). It is **not** this
package's `S3Error` class: `instanceof S3Error` is false for it.
**Fix:**

```ts
try {
	await avatars.put({ userId }, bytes);
} catch (error) {
	if (error instanceof S3Error) return badRequest(error.code); // ours: the guards
	throw error; // the service's, or Bun's: log the code it carries
}
```

`bytes`, `text` and `stat` are the exception: they turn S3's own `NoSuchKey`
into `undefined`, so `undefined` means "no such object" and nothing else.
Every other failure comes back as the error it is.

### A presigned upload stored a body the bucket would have refused

**When:** after handing out a `presignPut` URL. No error anywhere.
**Why:** a presigned PUT constrains the key and the deadline, and nothing
else. Measured on Bun 1.4: `X-Amz-SignedHeaders` stays `host`, so the
uploader's `Content-Type` is never signed and the size is never checked —
which is why `presignPut` takes no `type` at all. The guards are `put`'s;
`file(params).writer()` and `client` are Bun's own and write whatever they
are given.
**Fix:**

```ts
const url = avatars.presignPut({ userId }, { expiresIn: 300 });
// after the upload, check what actually landed
const stat = await avatars.stat({ userId });
if (!stat || stat.size > maxSize) await avatars.delete({ userId });
```

Set the service's own bucket policy too where it matters.

### A listing came back short with a cursor still set

**When:** `list`, on an eventually consistent service.
**Why:** `limit` is a maximum, not a promise.
**Fix:**

```ts
let cursor: string | null = null;
do {
	const page = await avatars.list({ prefix, limit: 100, cursor });
	cursor = page.nextCursor;
} while (cursor !== null);
```

Page until `nextCursor` is `null`, never until a page is short.
