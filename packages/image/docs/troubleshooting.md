# Troubleshooting

Two kinds of failure come out of this package.

- **`ImageError`** is a refusal of the upload. It has a `code`
  (`TOO_LARGE`, `UNSUPPORTED_TYPE`, `UNDECODABLE` or `TOO_SMALL`) and a
  `reason` (`bytes`, `pixels`, `format`, `heic-unavailable`, `decode` or
  `dimensions`). It is raised before anything is stored, and its message never
  quotes the uploaded bytes. When Bun's own error caused it, that error is
  `error.cause`.
- **`TypeError` and `RangeError`** are for what the caller wrote: a bad option,
  a bad crop, an input of the wrong type, a size the set does not have. They
  are programming errors, not upload refusals.

Any other error is not this package's: it is rethrown untouched (see
[Errors that are not an `ImageError`](#errors-that-are-not-an-imageerror)).

- **Install and runtime**
  - [`@nxgt/image needs Bun 1.4.1 or later, where Bun.Image exists`](#nxgtimage-needs-bun-141-or-later-where-bunimage-exists)
  - [`this machine cannot decode HEIC (Linux cannot)`](#this-machine-cannot-decode-heic-linux-cannot)
  - [`this machine cannot decode <format>`](#this-machine-cannot-decode-format)
  - [Memory grows under large images](#memory-grows-under-large-images)
- **Upload refusals (`ImageError`)**
  - [`the upload is over <maxBytes> bytes`](#the-upload-is-over-maxbytes-bytes)
  - [`the image has too many pixels`](#the-image-has-too-many-pixels)
  - [`the PNG has <w>x<h> pixels, over the <maxPixels> limit`](#the-png-has-wxh-pixels-over-the-maxpixels-limit)
  - [`the upload is not a JPEG, PNG, WebP or HEIC`](#the-upload-is-not-a-jpeg-png-webp-or-heic)
  - [`the <format> image cannot be decoded`](#the-format-image-cannot-be-decoded)
  - [`the PNG cannot be read: <why>`](#the-png-cannot-be-read-why)
  - [`the image is <w>x<h>, under <minSide>px on its short side`](#the-image-is-wxh-under-minsidepx-on-its-short-side)
  - [`the crop is <size>px, under the <minSide>px minimum`](#the-crop-is-sizepx-under-the-minsidepx-minimum)
- **Input and options**
  - [`image input must be a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream of Uint8Array`](#image-input-must-be-a-uint8array-an-arraybuffer-a-blob-or-a-readablestream-of-uint8array)
  - [`a stream chunk must be a Uint8Array`](#a-stream-chunk-must-be-a-uint8array)
  - [`<option> must be a whole number of <range>, got <value>`](#option-must-be-a-whole-number-of-range-got-value)
  - [`sizes must be a non-empty array of whole numbers`](#sizes-must-be-a-non-empty-array-of-whole-numbers)
  - [`sizes must be unique, got [<sizes>]`](#sizes-must-be-unique-got-sizes)
- **Crops**
  - [`a crop is { x, y, size }, three whole numbers of 0 or more`](#a-crop-is--x-y-size--three-whole-numbers-of-0-or-more)
  - [`a <size>px crop at (<x>, <y>) does not fit the <w>x<h> image`](#a-sizepx-crop-at-x-y-does-not-fit-the-wxh-image)
  - [`a <w>x<h> region at (<x>, <y>) does not fit a <w>x<h> image`](#a-wxh-region-at-x-y-does-not-fit-a-wxh-image)
- **Storage (`@nxgt/image/s3`)**
  - [`<call>: size <n> is not one of the set's sizes (<sizes>)`](#call-size-n-is-not-one-of-the-sets-sizes-sizes)
  - [An S3 error from `replace`](#an-s3-error-from-replace)
  - [`remove` throws `NoSuchKey`, or the bytes stay after `remove`](#remove-throws-nosuchkey-or-the-bytes-stay-after-remove)
  - [The bucket is bound with a public `acl`](#the-bucket-is-bound-with-a-public-acl)
- **Errors that are not an `ImageError`**
  - [Errors that are not an `ImageError`](#errors-that-are-not-an-imageerror)

## Install and runtime

### `@nxgt/image needs Bun 1.4.1 or later, where Bun.Image exists`

`TypeError`, thrown by `defineImageSet` before it reads any option.

**When:** the set is defined on a runtime where `Bun` is missing or
`Bun.Image` is not a function: a Bun older than 1.4.1, or Node.
**Why:** the package decodes and resizes with Bun's own `Bun.Image`, which Bun
added in 1.4.1. The check runs when the set is defined, so the failure shows at
startup rather than on the first upload. It is not an `ImageError`: it is not
the upload's fault.
**Fix:**

```sh
bun --version          # must be 1.4.1 or newer
```

```sh
bun upgrade
```

Upgrade the runtime that runs the process, the Docker image and CI included,
not only your machine. The package runs on Bun only: Node has no `Bun.Image`.

### `this machine cannot decode HEIC (Linux cannot)`

`ImageError`, `code: 'UNSUPPORTED_TYPE'`, `reason: 'heic-unavailable'`.

**When:** `process` is given a HEIC photo, on a Linux host.
**Why:** Bun decodes HEIC only through the operating system's codec, which
macOS and Windows have and Linux does not. The upload is a valid HEIC; this
machine cannot read it, so no limit or option of this package changes that.
**Fix:** ask the browser for a format the server can read. A file input with
an `accept` list of JPEG, PNG and WebP makes iOS convert a HEIC photo to JPEG
before it uploads it:

```html
<input type="file" accept="image/jpeg,image/png,image/webp" />
```

And tell the user, rather than a generic failure, when it still arrives:

```ts
import { ImageError } from '@nxgt/image';

try {
	await avatars.process(await request.blob());
} catch (error) {
	if (error instanceof ImageError && error.reason === 'heic-unavailable') {
		return new Response('Please upload a JPEG, PNG or WebP photo', {
			status: 415,
		});
	}
	throw error;
}
```

Development on a Mac accepts HEIC, so the refusal can first show up in
production on Linux. Test the refusal, not only the happy path.

### `this machine cannot decode <format>`

`ImageError`, `code: 'UNSUPPORTED_TYPE'`, `reason: 'format'`. `<format>` is
`jpeg`, `png` or `webp`.

**When:** `process` on an upload whose first bytes say it is that format.
**Why:** Bun reported the format as unsupported on this build or machine. It is
rare for these three; check the Bun build before blaming the upload.
**Fix:**

```sh
bun --version
bun -e "console.log(typeof Bun.Image)"
```

Run the same bytes on a stock Bun 1.4.1 or newer. `error.cause` holds Bun's
error, with its `code` (`ERR_IMAGE_FORMAT_UNSUPPORTED`).

### Memory grows under large images

**When:** several large photos are processed at once, for example a burst of
36 MP uploads, and the process grows by hundreds of megabytes or is killed for
memory.
**Why:** Bun's own decode and PNG encode hold about 4 bytes per pixel (RGBA).
The crop is read out of the PNG as it inflates, so nothing else that size is
kept. Plan on 4.5 bytes per pixel: about 225 MB per call at the default
`maxPixels` (measured 150 MB at 36 MP, 200 MB at 49 MP), a ceiling of
`concurrency x 4.5 x maxPixels`, 450 MB at the defaults.
**Fix:** lower `maxPixels` to what your users really upload, and keep
`concurrency` low. The wait queue is unbounded and each waiting call holds its
bytes (up to `maxBytes`), so cap uploads before `process` (a body limit in your
server). The calls beyond `concurrency` wait their turn, in order:

```ts
import { defineImageSet } from '@nxgt/image';

const avatars = defineImageSet({
	maxPixels: 16_000_000, // a 16 MP photo is enough for a 256 px avatar
	concurrency: 1,
});
```

A photo over `maxPixels` is then refused as
[`the image has too many pixels`](#the-image-has-too-many-pixels), before it
is decoded. `maxBytes` bounds the bytes the upload may be, not the pixels it
claims: a small file can claim many pixels.

## Upload refusals

### `the upload is over <maxBytes> bytes`

`ImageError`, `code: 'TOO_LARGE'`, `reason: 'bytes'`.

**When:** `process` on an upload bigger than `maxBytes` (default 5 MiB). A
`Uint8Array`, an `ArrayBuffer` or a `Blob` is checked by its size before it is
read; a stream is cancelled at the chunk that crosses the limit.
**Why:** the limit is a cap on what the server will read, never on what it
stores.
**Fix:** raise `maxBytes` if the limit is too tight, or answer the user:

```ts
const avatars = defineImageSet({ maxBytes: 10 * 1024 * 1024 });
```

### `the image has too many pixels`

`ImageError`, `code: 'TOO_LARGE'`, `reason: 'pixels'`.

**When:** `process` on an image whose width times height is over `maxPixels`
(default 50 million, which covers a 48 MP phone).
**Why:** a small file can decode to a huge image, and the decoded pixels are
what take the memory. Bun refuses it before decoding, with
`ERR_IMAGE_TOO_MANY_PIXELS` as `error.cause.code`.
**Fix:** answer the user with a smaller photo, or raise `maxPixels` knowing the
cost in [memory](#memory-grows-under-large-images):

```ts
const avatars = defineImageSet({ maxPixels: 100_000_000 });
```

### `the PNG has <w>x<h> pixels, over the <maxPixels> limit`

`ImageError`, `code: 'TOO_LARGE'`, `reason: 'pixels'`.

**When:** `process` on an image that passed the first pixel check but whose
intermediate PNG, read by this package's own reader, is over `maxPixels`.
**Why:** the pipeline shrinks the image to a PNG, then reads it itself while it
inflates, so `maxPixels` is checked twice. This second check is the
safety net behind the first; it should not fire for a normal upload.
**Fix:** the same as for the first check. If you see it with an image the
first check lets through, report it with the image's size and format.

### `the upload is not a JPEG, PNG, WebP or HEIC`

`ImageError`, `code: 'UNSUPPORTED_TYPE'`, `reason: 'format'`.

**When:** `process` on bytes that start like none of the four formats: a GIF,
an AVIF, an SVG, a PDF, or a file renamed to `.jpg`.
**Why:** the type is judged from the first bytes, never from the file name or
the declared content type, so a lie in either changes nothing.
**Fix:** convert before uploading, or restrict the input and answer the user:

```html
<input type="file" accept="image/jpeg,image/png,image/webp" />
```

### `the <format> image cannot be decoded`

`ImageError`, `code: 'UNDECODABLE'`, `reason: 'decode'`. `<format>` is `jpeg`,
`png`, `webp` or `heic`.

**When:** `process` on a file that starts like that format but is truncated,
damaged or of a variant Bun does not read.
**Why:** the first bytes are right and the content is not. Bun's error, with
`ERR_IMAGE_DECODE_FAILED` or `ERR_IMAGE_UNKNOWN_FORMAT` as its `code`, is
`error.cause`.
**Fix:** ask the user for another file, and log the cause when the file looks
fine:

```ts
catch (error) {
	if (error instanceof ImageError && error.reason === 'decode') {
		console.warn('undecodable upload', error.cause);
	}
}
```

### `the PNG cannot be read: <why>`

`ImageError`, `code: 'UNDECODABLE'`, `reason: 'decode'`. `<why>` is one of
`no PNG signature`, `no IHDR chunk`, `the size is not valid`, `only 8-bit
samples are read`, `an interlaced PNG is not read`, `this colour type (a
palette, for one) is not read`, `no IDAT chunk`, and the other damage the
reader names.

**When:** `process`, in the step after the shrink, on the PNG that Bun
produced.
**Why:** this package reads that intermediate PNG with its own small decoder,
which accepts only what Bun's shrink writes. A refusal here means the
intermediate file was not what was expected, not that the upload was a bad
PNG: an uploaded interlaced or palette PNG is read by Bun first and re-encoded.
**Fix:** none on your side. Report it with the Bun version and the upload's
format and dimensions at <https://github.com/softistx/nxgt-data/issues>.

### `the image is <w>x<h>, under <minSide>px on its short side`

`ImageError`, `code: 'TOO_SMALL'`, `reason: 'dimensions'`.

**When:** `process` with no `crop`, on an image whose short side is under
`minSide`. `minSide` defaults to the largest of `sizes` (256 with the
defaults), so that no variant is enlarged.
**Why:** a variant is never produced larger than its source.
**Fix:** ask for a bigger photo, or lower `minSide` and accept that the
largest variant is upscaled from less, or drop the large size:

```ts
const avatars = defineImageSet({ sizes: [128, 64] }); // minSide becomes 128
```

### `the crop is <size>px, under the <minSide>px minimum`

`ImageError`, `code: 'TOO_SMALL'`, `reason: 'dimensions'`.

**When:** `process` with a `crop` whose `size` is under `minSide`.
**Why:** `minSide` applies to the crop's own side when one is given. The
crop's shape and fit are checked first: a crop that does not fit the image is a
`RangeError`, whatever its size. Only a crop that fits and is under `minSide`
is `TOO_SMALL`.
**Fix:** make the cropper UI enforce the same minimum as the `minSide` option,
so it never offers a smaller crop. Do not raise `size` in code: a larger crop
at the same `x` and `y` can reach outside the image.

```ts
const avatars = defineImageSet({ sizes: [256, 64] }); // minSide is 256
// cropper: minimum crop size 256, the same number as the set's minSide
```

## Input and options

### `image input must be a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream of Uint8Array`

`TypeError`.

**When:** `process` with anything else: a `string`, a `Buffer` from another
realm, a `File` wrapper, a `Response`, `undefined`.
**Why:** the input must be one of the four types.
**Fix:**

```ts
await avatars.process(await response.blob());
// or: await avatars.process(request.body!)  // a ReadableStream<Uint8Array>
```

### `a stream chunk must be a Uint8Array`

`TypeError`.

**When:** `process` on a `ReadableStream` that yields something other than
`Uint8Array`, a string for example.
**Why:** a stream is read chunk by chunk, and a text stream cannot be
concatenated into image bytes. The stream is cancelled.
**Fix:** pass a byte stream, not a text one:

```ts
const bytes: ReadableStream<Uint8Array> = (await fetch(url)).body!;
await avatars.process(bytes);
```

### `<option> must be a whole number of <range>, got <value>`

`TypeError`, thrown by `defineImageSet`, before any upload is read.

**When:** an option is a fraction, a string, `NaN` or out of its range.
`<option>` is `maxBytes`, `maxPixels`, `minSide`, `quality` (1 to 100),
`concurrency` (1 to 64) or `sizes[]` (1 to 4096).
**Why:** each is a count, and a wrong one would otherwise fail in the middle of
an upload.
**Fix:**

```ts
defineImageSet({ quality: 80, concurrency: 2, maxBytes: 5 * 1024 * 1024 });
```

Read `maxBytes` from an environment variable with `Number(...)` and check it
is whole.

### `sizes must be a non-empty array of whole numbers`

`TypeError`, thrown by `defineImageSet`.

**When:** `sizes` is not an array, or is empty.
**Why:** a set needs at least one variant.
**Fix:**

```ts
defineImageSet({ sizes: [256, 64] });
```

### `sizes must be unique, got [<sizes>]`

`TypeError`, thrown by `defineImageSet`.

**When:** `sizes` repeats a value, for example `[64, 64]`.
**Why:** two variants of one size would write the same key.
**Fix:**

```ts
defineImageSet({ sizes: [256, 64] });
```

## Crops

### `a crop is { x, y, size }, three whole numbers of 0 or more`

`RangeError`.

**When:** `process` with a `crop` whose `x`, `y` or `size` is a fraction, a
negative number or not a number.
**Why:** a crop is pixels in the oriented image, as the user sees it.
Cropper libraries often report fractions.
**Fix:**

```ts
const crop = {
	x: Math.round(area.x),
	y: Math.round(area.y),
	size: Math.round(area.width),
};
await avatars.process(blob, { crop });
```

### `a <size>px crop at (<x>, <y>) does not fit the <w>x<h> image`

`RangeError`.

**When:** `process` with a `crop` that reaches outside the image, or has
`size` 0.
**Why:** `x + size` is over the width or `y + size` over the height. The crop is
in the oriented frame, after the EXIF rotation, so a crop computed on the
unrotated pixels of a phone photo misses.
**Fix:** clamp to the oriented size that the cropper showed, or send no crop and
get a centred square:

```ts
await avatars.process(blob); // centred square of the short side
```

### `a <w>x<h> region at (<x>, <y>) does not fit a <w>x<h> image`

`RangeError`.

**When:** never from a call that goes through `process`.
**Why:** an internal check on the pixels that the package crops, after the crop
has already been validated. Reaching it is a bug in this package.
**Fix:** report it at <https://github.com/softistx/nxgt-data/issues> with the
image's size and format, and the crop given.

## Storage

### `<call>: size <n> is not one of the set's sizes (<sizes>)`

`RangeError`, from `@nxgt/image/s3`, for example
`presignGet: size 128 is not one of the set's sizes (256, 64)`. `<call>` is
`presignGet`, `bytes` or `keyFor` for a caller; `replace` and `remove` use the
same text internally.

**When:** `presignGet`, `bytes` or `keyFor` of a store, with a `size` the set
does not produce. It is the caller's bug, so it is a `RangeError`, not an
`ImageError`; a route that takes the size from a URL checks it against
`set.sizes` first and answers 404 (see [storing](guide/storing.md#serving)).
**Why:** the store's sizes are the set's sizes, and a key for another size would
point at nothing.
**Fix:** read the sizes off the set rather than writing numbers twice:

```ts
import { defineImageSet } from '@nxgt/image';
import { bindImageStore } from '@nxgt/image/s3';
import { bindBucket, defineBucket } from '@nxgt/s3';

const avatarBucket = defineBucket({
	bucket: 'avatars',
	key: (p: { imageId: string; size: number }) =>
		`avatars/${p.imageId}/${p.size}.webp`,
});

const set = defineImageSet({ sizes: [256, 64] });
const store = bindImageStore(
	set,
	bindBucket(avatarBucket, {
		endpoint: 'https://s3.example.com', // your own, from the environment
		accessKeyId: 'access-key',
		secretAccessKey: 'secret-key',
	}),
);
const imageId = crypto.randomUUID();
store.presignGet({ imageId }, set.sizes[0]);
```

Refusals of the upload (`TOO_LARGE`, `UNSUPPORTED_TYPE`, ...) happen in
`replace` before anything is written, so a refused upload stored nothing.

### An S3 error from `replace`

**When:** a put to the bucket fails inside `replace`: a bad credential, a
network error, a missing bucket, a refused write (a bucket that does not accept
`image/webp`, or whose `maxSize` is under the largest variant).
**Why:** the store does not wrap the service's errors. Every put is awaited,
then a best-effort delete removes the keys whose put succeeded (never the
refused one), and the first error is rethrown **unchanged**, so `@nxgt/s3`'s
own handling and messages apply. A put that failed after sending (a network
error) may still land on the server after the cleanup.
**Fix:** read the cause in [`@nxgt/s3`'s troubleshooting](https://github.com/softistx/nxgt-data/blob/develop/packages/s3/docs/troubleshooting.md)
and use a fresh id per upload, so that the cleanup never deletes an image that
is in use:

```ts
const imageId = crypto.randomUUID();
const { version } = await store.replace({ imageId }, await request.blob());
await store.remove({ imageId: former }); // only after the new one is stored
```

With fixed params, a failed `replace` leaves the object under the refused key
as it was, but the keys that were written by this call are removed, so the
image can end up with a mix of old and missing sizes: use a fresh id.

### `remove` throws `NoSuchKey`, or the bytes stay after `remove`

**When:** `remove` on a service that answers 404 to a delete of a missing object
(for example GCS), or on a versioned bucket.
**Why:** a 404 answer is thrown as `NoSuchKey`, not swallowed; and a versioned
bucket keeps the bytes behind delete markers.
**Fix:** save the new id first, then remove the former image, never inside a
transaction that may roll back; catch `NoSuchKey` where the service answers it,
and expire noncurrent versions with a lifecycle rule.

### The bucket is bound with a public `acl`

**When:** `bindBucket` was given `acl: 'public-read'` as a default.
**Why:** Bun sends it on every put, and the store promises objects that are
never public, but it does not pass an `acl` of its own, so the default wins;
on AWS a bucket with ACLs disabled refuses it.
**Fix:** bind the bucket without an `acl`. A bucket policy can still make
objects public if you want that.

## Errors that are not an `ImageError`

**When:** `process` throws something that is neither an `ImageError` nor one of
the `TypeError` or `RangeError` above: an out-of-memory or an unexpected Bun failure.
**Why:** only the Bun errors whose `code` means a refusal of the upload
(`ERR_IMAGE_TOO_MANY_PIXELS`, `ERR_IMAGE_FORMAT_UNSUPPORTED`,
`ERR_IMAGE_DECODE_FAILED`, `ERR_IMAGE_UNKNOWN_FORMAT`) are turned into an
`ImageError`, with Bun's error as `error.cause`. Any other error is rethrown
untouched, so a bug or an out-of-memory is never taken for a bad upload.
**Fix:** answer a 4xx only for an `ImageError`, and let the rest be a 5xx:

```ts
try {
	await avatars.process(blob);
} catch (error) {
	if (error instanceof ImageError) {
		return new Response(error.message, { status: 422 });
	}
	throw error; // a bug, or the runtime: log it, answer 500
}
```
