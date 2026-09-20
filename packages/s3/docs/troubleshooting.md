# Troubleshooting

This package throws one error of its own, `S3Error`, with a `code` of
`WRONG_TYPE`, `TOO_LARGE`, `UNMEASURABLE` or `WRONG_OPTION`, and the object
`key` it was about — never the body. Every one of them is raised **before**
anything is sent, so a refused write stored nothing. The service's own
failures come back as Bun raises them; the entries below say which is which.
A wrong `acl` is this package's own refusal on a `put` **and** on a
`presign`, so one class and one code cover both. Bun names its own *service*
failures `S3Error` as well, so it is `instanceof S3Error` against the class
this package exports that tells those apart — never `error.name`. (Bun's
refusal of a wrong argument is a different thing again: a plain `TypeError`,
named `"TypeError"`.) The Bun messages were measured on Bun 1.4.2.

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
  - [`storageClass must be one of STANDARD, DEEP_ARCHIVE, EXPRESS_ONEZONE, …; got "CHEAP"`](#storageclass-must-be-one-of-standard-deep_archive-express_onezone--got-cheap)
  - [`acl must be one of private, public-read, public-read-write, …; got "everyone"`](#acl-must-be-one-of-private-public-read-public-read-write--got-everyone)
  - [`expiresIn is seconds, and must be above 0 and at most 604800 …`](#expiresin-is-seconds-and-must-be-above-0-and-at-most-604800-seven-days-which-is-s3s-own-limit-got-1000000000000)
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

**When:** `put`, with a `type` the definition does not list. A presigned URL
is never checked against it — `PresignOptions` has no `type`, and a signed
PUT constrains the key and the deadline and nothing else.
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

### `storageClass must be one of STANDARD, DEEP_ARCHIVE, EXPRESS_ONEZONE, …; got "CHEAP"`

The whole line names every class the service takes, then the one it was
given:

```text
storageClass must be one of STANDARD, DEEP_ARCHIVE, EXPRESS_ONEZONE, GLACIER,
GLACIER_IR, INTELLIGENT_TIERING, ONEZONE_IA, OUTPOSTS, REDUCED_REDUNDANCY,
SNOW, STANDARD_IA; got "CHEAP"
```

**When:** `put` with a `storageClass` that is not one of those — usually a
value read off a request body or an environment variable, where the types
were not there to refuse it.
**Why:** an `S3Error` with `code: 'WRONG_OPTION'`, raised before the request
goes out, like the content type and the size. Since 0.3.0 this package
checks the two guarded options itself rather than letting the client refuse
them, so one `catch` covers every refusal of a `put`.
**Fix:** narrow the value against the option's own type before it reaches the
call:

```ts
import { S3Error, type PutOptions } from '@nxgt/s3';

// the classes this application allows, proved against the option's type
const CLASSES = ['STANDARD', 'STANDARD_IA'] as const satisfies readonly NonNullable<
	PutOptions['storageClass']
>[];

function storageClassOf(value: string | undefined): PutOptions['storageClass'] {
	return CLASSES.find((known) => known === value); // undefined: the bucket's default
}

try {
	await avatars.put({ userId }, bytes, { storageClass: storageClassOf(input) });
} catch (error) {
	if (error instanceof S3Error && error.code === 'WRONG_OPTION') return badRequest();
	throw error;
}
```

### `acl must be one of private, public-read, public-read-write, …; got "everyone"`

```text
acl must be one of private, public-read, public-read-write, aws-exec-read,
authenticated-read, bucket-owner-read, bucket-owner-full-control,
log-delivery-write; got "everyone"
```

**When:** `put`, `presignGet` or `presignPut` with an `acl` that is not one
of those. Both paths go through the same allowlist since 0.3.0; before it,
`presign` handed the value to the client, which refused it with a plain
`TypeError` that quoted **every accepted value** (`must be one of "private",
"public-read", …`). This one quotes only the value it was given, so a message
with the allowed values in quotes means the package is older than 0.3.0.
**Why:** the same `code: 'WRONG_OPTION'`, before anything is sent or signed.
The two guarded options are `acl` and `storageClass`; `contentDisposition`
and `contentEncoding` are plain strings to the service and accept anything.
`presign` takes no `storageClass` — nothing is stored by signing a URL.
**Fix:**

```ts
await avatars.put({ userId }, bytes, { acl: 'public-read' });
const url = avatars.presignPut({ userId }, { acl: 'private', expiresIn: 300 });
```

### `expiresIn is seconds, and must be above 0 and at most 604800 (seven days, which is S3's own limit); got 1000000000000`

**When:** `presignGet` or `presignPut` with an `expiresIn` that is not a
finite number of seconds inside S3's range.
**Why:** an `S3Error` with `code: 'WRONG_OPTION'`, raised before anything is
signed. Measured on bun 1.4.2, the client refuses `0` and below with a
`TypeError` of its own and **signs** `1e12` happily — a URL the service then
rejects when somebody uses it, long after this package reported success.
**Fix:** pass seconds, and no more than a week:

```ts
const url = avatars.presignPut({ userId }, { expiresIn: 300 }); // five minutes
```

Sign for the time the page actually needs: a day is a long life for a URL
anyone can forward.

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
