# Troubleshooting

This package's error class for refusals is `S3Error`, with a `code` of
`WRONG_TYPE`, `TOO_LARGE`, `UNMEASURABLE` or `WRONG_OPTION`, and the object
`key` it was about — never the body. Every one of them is raised **before**
anything is sent, so a refused write stored nothing. It throws two other
kinds, for what is not the caller's input: a `TypeError` from `defineBucket`
for a definition that could never work, and from `presignPost` when its
secret is not the one Bun signs with (changed or deleted since the process
started); and a plain `Error` from `presignPost` when the URL Bun signed
cannot be read. Each has its entry below. The service's own
failures come back as Bun raises them; the entries below say which is which.
A wrong `acl` is this package's own refusal on a `put` **and** on the
presigned calls, so one class and one code cover them all. A message reports what was
wrong by its **shape** — `another string`, `a fraction`, `the type given` —
and never quotes the value, which can come off a request body. Every
refusal also names the call and the bucket it was on, so a log line says which
of an application's buckets and calls produced it, in one of two forms: the
refusals shared with `put` and the other presigned calls **end** with it —
`(put on "avatars")`, `(presignGet on "avatars")`, `(presignPut on …)`,
`(presignPost on …)` — while `presignPost`'s own refusals, and its two
`TypeError`s and its plain `Error`, **lead** with it:
`presignPost on "avatars": …`. Bun names its own *service*
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
  - [`"avatars" accepts image/png, image/jpeg, not the type given (put on "avatars")`](#avatars-accepts-imagepng-imagejpeg-not-the-type-given-put-on-avatars)
  - [``"avatars" accepts image/png, image/jpeg, and no content type was named. Pass `type` (put on "avatars")``](#avatars-accepts-imagepng-imagejpeg-and-no-content-type-was-named-pass-type-put-on-avatars)
  - [`"avatars" accepts 2097152 bytes at most, and this body is 5242880 (put on "avatars")`](#avatars-accepts-2097152-bytes-at-most-and-this-body-is-5242880-put-on-avatars)
  - [`"avatars" has a maxSize, and this body's size cannot be known before sending it. …`](#avatars-has-a-maxsize-and-this-bodys-size-cannot-be-known-before-sending-it-)
  - [`storageClass must be one of STANDARD, DEEP_ARCHIVE, EXPRESS_ONEZONE, …; got another string (put on "avatars")`](#storageclass-must-be-one-of-standard-deep_archive-express_onezone--got-another-string-put-on-avatars)
  - [`acl must be one of private, public-read, public-read-write, …; got another string (put on "avatars")`](#acl-must-be-one-of-private-public-read-public-read-write--got-another-string-put-on-avatars)
  - [`expiresIn is seconds, and must be above 0 and at most 604800 …; got a number above that (presignGet on "avatars")`](#expiresin-is-seconds-and-must-be-above-0-and-at-most-604800-seven-days-which-is-s3s-own-limit-got-a-number-above-that-presignget-on-avatars)
- **Presigned POSTs refused before they are signed**
  - [``presignPost on "uploads": this bucket has no maxSize, … Pass `maxSize`, in bytes``](#presignpost-on-uploads-this-bucket-has-no-maxsize-and-a-presigned-post-is-a-bound-on-what-a-browser-uploads-pass-maxsize-in-bytes)
  - [`presignPost on "avatars": maxSize cannot be above the bucket's own 2097152 bytes; got a larger number`](#presignpost-on-avatars-maxsize-cannot-be-above-the-buckets-own-2097152-bytes-got-a-larger-number)
  - [`presignPost on "avatars": maxSize is a whole number of bytes, at least 1; got a string`](#presignpost-on-avatars-maxsize-is-a-whole-number-of-bytes-at-least-1-got-a-string)
  - [`presignPost on "avatars": minSize is above maxSize, so no body could be posted`](#presignpost-on-avatars-minsize-is-above-maxsize-so-no-body-could-be-posted)
  - [``presignPost on "avatars": this bucket accepts image/png, image/jpeg, and a prefix would let another type through. …``](#presignpost-on-avatars-this-bucket-accepts-imagepng-imagejpeg-and-a-prefix-would-let-another-type-through-pass-one-of-them-as-type-)
  - [`presignPost on "uploads": type is a content type or { startsWith }; got a number`](#presignpost-on-uploads-type-is-a-content-type-or--startswith--got-a-number)
  - [`"avatars" accepts image/png, image/jpeg, not the type given (presignPost on "avatars")`](#avatars-accepts-imagepng-imagejpeg-not-the-type-given-presignpost-on-avatars)
  - [`presignPost on "avatars": the secret access key this package would sign with is not the one Bun signs with, so the service would refuse the form. …`](#presignpost-on-avatars-the-secret-access-key-this-package-would-sign-with-is-not-the-one-bun-signs-with-so-the-service-would-refuse-the-form-)
  - [`presignPost on "avatars": no secret access key to sign with, while Bun has one. …`](#presignpost-on-avatars-no-secret-access-key-to-sign-with-while-bun-has-one-)
  - [`presignPost on "avatars": the URL Bun signed has no credential scope, …`](#presignpost-on-avatars-the-url-bun-signed-has-no-credential-scope-or-not-the-key-at-the-end-of-its-path-so-there-is-nowhere-to-post-the-form-)
- **The service**
  - [`Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required`](#missing-s3-credentials-accesskeyid-secretaccesskey-bucket-and-endpoint-are-required)
  - [`The AWS Access Key Id you provided does not exist in our records.`](#the-aws-access-key-id-you-provided-does-not-exist-in-our-records)
  - [`Your proposed upload exceeds the maximum allowed object size.`](#your-proposed-upload-exceeds-the-maximum-allowed-object-size)
  - [`Your proposed upload is smaller than the minimum allowed object size.`](#your-proposed-upload-is-smaller-than-the-minimum-allowed-object-size)
  - [`Invalid according to Policy: Policy Condition failed`](#invalid-according-to-policy-policy-condition-failed)
  - [`Invalid according to Policy: Policy expired`](#invalid-according-to-policy-policy-expired)
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

### `"avatars" accepts image/png, image/jpeg, not the type given (put on "avatars")`

**When:** `put`, with a `type` the definition does not list. A presigned URL
is never checked against it — `PresignOptions` has no `type`, and a signed
PUT constrains the key and the deadline and nothing else.
**Why:** an `S3Error` with `code: 'WRONG_TYPE'`. Nothing was sent. The
message lists what the bucket accepts and never quotes the type it was given
— before 0.4.0 it ended `not application/pdf`. The type
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

### ``"avatars" accepts image/png, image/jpeg, and no content type was named. Pass `type` (put on "avatars")``

**When:** `put` on a bucket with `contentType`, for a body that carries no
type of its own — a string, a typed array, a stream.
**Why:** the guard cannot accept what it cannot read, so an unnamed type is
refused rather than guessed. `code: 'WRONG_TYPE'`. Before 0.4.0 it read
``… and this write names no content type. Pass `type` ``.
**Fix:**

```ts
await avatars.put({ userId }, bytes, { type: 'image/png' });
```

`Bun.file(path)` carries its own type, and does not need the option.

### `"avatars" accepts 2097152 bytes at most, and this body is 5242880 (put on "avatars")`

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

### `storageClass must be one of STANDARD, DEEP_ARCHIVE, EXPRESS_ONEZONE, …; got another string (put on "avatars")`

The whole line names every class the service takes, then the **shape** of
what it was given — `another string`, `a number`, `null` — never the value:

```text
storageClass must be one of STANDARD, DEEP_ARCHIVE, EXPRESS_ONEZONE, GLACIER,
GLACIER_IR, INTELLIGENT_TIERING, ONEZONE_IA, OUTPOSTS, REDUCED_REDUNDANCY,
SNOW, STANDARD_IA; got another string (put on "avatars")
```

Before 0.4.0 it quoted the value: `got "CHEAP"`.

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

### `acl must be one of private, public-read, public-read-write, …; got another string (put on "avatars")`

```text
acl must be one of private, public-read, public-read-write, aws-exec-read,
authenticated-read, bucket-owner-read, bucket-owner-full-control,
log-delivery-write; got another string (put on "avatars")
```

From a presigned call the line ends with that call instead: `…; got another
string (presignPut on "avatars")`.

**When:** `put`, `presignGet`, `presignPut` or `presignPost` with an `acl` that is not one
of those. Both paths go through the same allowlist since 0.3.0; before it,
`presign` handed the value to the client, which refused it with a plain
`TypeError` that quoted **every accepted value** (`must be one of "private",
"public-read", …`), so a message with the allowed values in quotes means the
package is older than 0.3.0. From 0.3.0 to 0.4.0 this one quoted the value it
was given (`got "everyone"`); it now gives only its shape.
**Why:** the same `code: 'WRONG_OPTION'`, before anything is sent or signed.
The two guarded options are `acl` and `storageClass`; `contentDisposition`
and `contentEncoding` are plain strings to the service and accept anything.
`presignGet`, `presignPut` and `presignPost` take no `storageClass` —
nothing is stored by signing a URL or a form.
**Fix:**

```ts
await avatars.put({ userId }, bytes, { acl: 'public-read' });
const url = avatars.presignPut({ userId }, { acl: 'private', expiresIn: 300 });
```

### `expiresIn is seconds, and must be above 0 and at most 604800 (seven days, which is S3's own limit); got a number above that (presignGet on "avatars")`

**When:** `presignGet`, `presignPut` or `presignPost` with an `expiresIn`
that is not a finite number of seconds inside S3's range. Only the
presigned calls take one, so the line always ends with the call —
`(presignGet on "avatars")`, `(presignPut on …)` or `(presignPost on …)` —
and `got` names the shape: `a number above that`,
`zero`, `a negative number`, `NaN`, `a string`. Before 0.4.0 it quoted the
value (`got 1000000000000`).
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

## Presigned POSTs refused before they are signed

Every entry here comes from `presignPost`, raised before anything is signed,
so no form was handed out. The refusals of an option or a type are
`S3Error`s; the option values usually come off a request body, so answer
`WRONG_OPTION` and `WRONG_TYPE` with a 400. The last three entries are not:
two `TypeError`s when this package's secret is not Bun's, and a plain `Error`
when the URL Bun signed cannot be read — none of them is the caller's input,
so answer them with a 500. Every
message reports the **shape** of what it was given — `a string`,
`a fraction`, `the type given` — never the value. An `acl` or an `expiresIn`
refused here is the entry above, ending with `(presignPost on "avatars")`.

### ``presignPost on "uploads": this bucket has no maxSize, and a presigned POST is a bound on what a browser uploads. Pass `maxSize`, in bytes``

**When:** `presignPost` on a bucket whose definition has no `maxSize`, with
no `maxSize` in the options. `code: 'WRONG_OPTION'`.
**Why:** the size range is what a POST has over a PUT. A form with no upper
bound would be a presigned PUT with extra steps, so this package will not sign
one.
**Fix:** pass one, or give the definition a `maxSize` for every upload:

```ts
const form = uploads.presignPost(params, { maxSize: 10 * 1024 * 1024 });
```

### `presignPost on "avatars": maxSize cannot be above the bucket's own 2097152 bytes; got a larger number`

**When:** a `maxSize` above the definition's. `code: 'WRONG_OPTION'`.
**Why:** an option can tighten the bucket's bound, never loosen it — a `put`
of the same body would be refused.
**Fix:** leave `maxSize` out to take the bucket's, or pass a smaller one.

### `presignPost on "avatars": maxSize is a whole number of bytes, at least 1; got a string`

**When:** a `maxSize` or a `minSize` that is not a whole number of bytes —
for `minSize` the same message says `at least 0`, and `got` names the shape:
`a string`, `zero`, `a fraction`, `a negative number`, `NaN`.
`code: 'WRONG_OPTION'`.
**Why:** `content-length-range` is a count of bytes, and a value off a request
body is not one until it has been checked.
**Fix:** check it is an integer before passing it, or keep sizes out of the
request and choose them on the server.

### `presignPost on "avatars": minSize is above maxSize, so no body could be posted`

**When:** `minSize` greater than `maxSize` (the one given, or the bucket's).
`code: 'WRONG_OPTION'`.
**Why:** the service would refuse every upload, so the form is not signed.
**Fix:** `minSize` at most `maxSize`; leave it out for `0`.

### ``presignPost on "avatars": this bucket accepts image/png, image/jpeg, and a prefix would let another type through. Pass one of them as `type` ``

**When:** `type: { startsWith }` on a bucket whose definition names its
content types. `code: 'WRONG_TYPE'`.
**Why:** `image/` would let `image/gif` through a bucket that accepts two
image types. A prefix is for a bucket that names none.
**Fix:** sign for the type the browser will send:

```ts
const form = avatars.presignPost({ userId }, { type: file.type });
```

### `presignPost on "uploads": type is a content type or { startsWith }; got a number`

**When:** a `type` that is neither a non-empty string nor an object with a
string `startsWith` — `got` names its shape. `code: 'WRONG_OPTION'`.
**Why:** it becomes a policy condition; anything else has no meaning there.
**Fix:** `type: 'image/png'`, or `type: { startsWith: 'image/' }` on a bucket
that names no type.

### `"avatars" accepts image/png, image/jpeg, not the type given (presignPost on "avatars")`

**When:** `presignPost` with a `type` the bucket does not accept — or, as
``… and no content type was named. Pass `type` (presignPost on "avatars")``, with no
`type` on a bucket that names **several**. `code: 'WRONG_TYPE'`: the same
refusal a `put` gives, with the call named at the end.
**Why:** the policy holds one type. With a single type in the definition it
is the default; with several, the caller says which one this upload is.
**Fix:**

```ts
const form = avatars.presignPost({ userId }, { type: 'image/jpeg' });
```

### `presignPost on "avatars": the secret access key this package would sign with is not the one Bun signs with, so the service would refuse the form. …`

The whole line:

```text
presignPost on "avatars": the secret access key this package would sign with
is not the one Bun signs with, so the service would refuse the form. Bun reads
S3_SECRET_ACCESS_KEY and AWS_SECRET_ACCESS_KEY when the process starts; one
changed since is not the one Bun uses. Pass `secretAccessKey` to bindBucket
```

**When:** `presignPost` on a bucket bound **without** a `secretAccessKey`
option, after `S3_SECRET_ACCESS_KEY` (or `AWS_SECRET_ACCESS_KEY`) was changed
while the process was running. A `TypeError`, not an `S3Error`: nothing a
request sent is wrong.
**Why:** Bun reads those variables **once, when the process starts**, and
keeps signing with what it read; this package reads them when the bucket is
bound. A form signed with the new secret would pass every check here and be
refused by the service only when a browser posts it. So `presignPost` checks
its secret against the signature Bun itself put on a throwaway URL, and
refuses before signing anything when they differ — measured in a process
started with the variable set, in
[`post-signer.spec.ts`](https://github.com/softistx/nxgt-data/blob/develop/packages/s3/src/bucket/operations/post-signer.spec.ts).
**Fix:** pass the secret to `bindBucket` rather than changing the environment
of a running process:

```ts
const store = bindBucket(avatars, {
	endpoint: process.env.S3_ENDPOINT,
	accessKeyId: process.env.S3_KEY,
	secretAccessKey: process.env.S3_SECRET,
});
```

### `presignPost on "avatars": no secret access key to sign with, while Bun has one. …`

**When:** as above, when the variable was **deleted** after the process
started: Bun still signs with the secret it read then, and this package has
none. A `TypeError`, measured the same way.
**Why:** a POST policy is signed with the secret, and Bun's client never hands
its own back. This package keeps it beside the bucket's context, never on
it, so printing the context, the bucket or the form never shows it —
measured with a marker secret, in
[`post-signer.spec.ts`](https://github.com/softistx/nxgt-data/blob/develop/packages/s3/src/bucket/operations/post-signer.spec.ts). With no secret anywhere,
Bun's own `ERR_S3_MISSING_CREDENTIALS` comes first (next section).
**Fix:** give `bindBucket` a `secretAccessKey`.

### `presignPost on "avatars": the URL Bun signed has no credential scope, or not the key at the end of its path, so there is nowhere to post the form. …`

**When:** only with a Bun that signs a presigned URL differently from the
1.4.2 this package was measured on, or with an access key id holding a `%`
that is not an escape (`AK%zz`): Bun writes the id into the URL unencoded, so
it cannot be read back. A plain `Error`, not an `S3Error`. An access key id
with a `=`, a `&`, a space or a non-ASCII character is not supported either:
Bun's own presigned URL is malformed for it.
**Why:** `presignPost` asks Bun where the bucket is by signing a throwaway
key (`nxgt-probe`) and reading the URL: the bucket's URL is the path before
that key, and the region and access key are in `X-Amz-Credential`. A URL
without either would post the form somewhere else, or sign it as nobody, so
it is refused rather than guessed.
**Fix:** use Bun 1.4.2, the version this package was measured on, and
[open an issue](https://github.com/softistx/nxgt-data/issues) naming the Bun version that produced it.

## The service

### `Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required`

**When:** the first call, when neither `bindBucket`'s options nor the
environment gave the client credentials. Bun's error, `code:
'ERR_S3_MISSING_CREDENTIALS'` — from `presignPost` too, which asks Bun where
the bucket is before it signs.
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

### `Your proposed upload exceeds the maximum allowed object size.`

**When:** a browser posted a `presignPost` form with a file over its
`maxSize`. The service answers `400`, `<Code>EntityTooLarge</Code>` —
measured on SeaweedFS 4.47 — and stores nothing.
**Why:** that is the policy's `content-length-range` doing its job. `maxSize`
is inclusive: exactly `maxSize` bytes is stored.
**Fix:** nothing to fix on the server. Check `file.size` in the browser
before posting to spare the user the round trip, and show the 400 as "too
big".

### `Your proposed upload is smaller than the minimum allowed object size.`

**When:** a posted file under the form's `minSize`. `400`,
`<Code>EntityTooSmall</Code>`, measured on SeaweedFS 4.47.
**Why:** `content-length-range`'s lower end.
**Fix:** leave `minSize` out (it is `0`), or check the size in the browser.

### `Invalid according to Policy: Policy Condition failed`

**When:** a posted form whose fields do not match the policy. `403`,
`<Code>AccessDenied</Code>`, measured on SeaweedFS 4.47 for each of: another
`Content-Type`, the same type in another case (`IMAGE/PNG`) or with a
parameter (`;charset=utf-8`), another `key`, another `acl`, and a
`Content-Type` field missing when the policy fixes one or holds it to a
prefix. A bucket that names no type, signed with no `type`, is the exception:
its form posts with no `Content-Type` field — measured, `204`, stored as
`application/octet-stream`.
**Why:** the policy compares each field **exactly**. The usual cause is code
that rebuilds the form instead of posting `fields` as given — or a
`{ startsWith }` form posted without the browser's own `Content-Type` field.
**Fix:**

```ts
const body = new FormData();
for (const [name, value] of Object.entries(form.fields)) body.append(name, value);
// with { startsWith }: body.append('Content-Type', file.type);
body.append('file', file); // last
```

A field the policy does not name is refused too, with its own message —
measured, `Invalid according to Policy: Extra input fields: X-Amz-Meta-Foo`.
Do not add fields to the form.

### `Invalid according to Policy: Policy expired`

**When:** a form posted after its `expiresIn`. `403`,
`<Code>AccessDenied</Code>`, measured on SeaweedFS 4.47.
**Why:** the policy's `expiration` is part of what was signed.
**Fix:** sign the form when the user starts the upload, not when the page
loads, and keep `expiresIn` close to how long an upload takes.

### A presigned upload stored a body the bucket would have refused

**When:** after handing out a `presignPut` URL. No error anywhere.
**Why:** a presigned PUT constrains the key and the deadline, and nothing
else. Measured on Bun 1.4: `X-Amz-SignedHeaders` stays `host`, so the
uploader's `Content-Type` is never signed and the size is never checked —
which is why `presignPut` takes no `type` at all. The guards are `put`'s;
`file(params).writer()` and `client` are Bun's own and write whatever they
are given.
**Fix:** use a presigned POST, whose policy the service enforces — a body
over `maxSize` or of another type is refused before it is stored:

```ts
const form = avatars.presignPost({ userId }, { type: 'image/png', expiresIn: 300 });
```

With a `presignPut` you are keeping, check what actually landed:

```ts
const stat = await avatars.stat({ userId });
if (!stat || stat.size > maxSize) await avatars.delete({ userId });
```

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
