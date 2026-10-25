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
  - [`a <size>px square at (<x>, <y>) does not fit a <w>x<h> image`](#a-sizepx-square-at-x-y-does-not-fit-a-wxh-image)
- **Storage (`@nxgt/image/s3`)**
  - [`size <n> is not one of the set's sizes (<sizes>)`](#size-n-is-not-one-of-the-sets-sizes-sizes)
  - [An S3 error from `replace`](#an-s3-error-from-replace)
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
**Why:** a call can hold about 4 bytes per pixel of the upload at its peak, when
the crop is small and no shrink takes place. The ceiling is about
`concurrency x 4 x maxPixels` bytes: 200 MB per call at the default `maxPixels`
(50 million pixels), 400 MB at the default `concurrency` of 2.
**Fix:** lower `maxPixels` to what your users really upload, and keep
`concurrency` low. The calls beyond it wait their turn, in order, after their
bytes are read:

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
intermediate PNG, read by this package's own decoder, is over `maxPixels`.
**Why:** the pipeline shrinks the image to an uncompressed PNG, then decodes
that itself, so `maxPixels` is checked twice. This second check is the
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
**Why:** `minSide` applies to the crop's own side when one is given, and is
checked before the shrink, so a crop that is too small is `TOO_SMALL`, not a
`RangeError`.
**Fix:** make the cropper's minimum equal to the set's `minSide`:

```ts
await avatars.process(blob, { crop: { x, y, size: Math.max(size, 256) } });
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

### `a <size>px square at (<x>, <y>) does not fit a <w>x<h> image`

`RangeError`.

**When:** never from a call that goes through `process`.
**Why:** an internal check on the pixels that the package crops, after the crop
has already been validated. Reaching it is a bug in this package.
**Fix:** report it at <https://github.com/softistx/nxgt-data/issues> with the
image's size and format, and the crop given.

## Storage

### `size <n> is not one of the set's sizes (<sizes>)`

`RangeError`, from `@nxgt/image/s3`.

**When:** `presignGet`, `bytes` or `keyFor` of a store, with a `size` the set
does not produce.
**Why:** the store's sizes are the set's sizes, and a key for another size would
point at nothing.
**Fix:** read the sizes off the set rather than writing numbers twice:

```ts
import { bindImageStore } from '@nxgt/image/s3';

const set = defineImageSet({ sizes: [256, 64] });
const store = bindImageStore(set, bindBucket(avatars));
await store.presignGet({ imageId }, set.sizes[0]);
```

Refusals of the upload (`TOO_LARGE`, `UNSUPPORTED_TYPE`, ...) happen in
`replace` before anything is written, so a refused upload stored nothing.

### An S3 error from `replace`

**When:** a put to the bucket fails inside `replace`: a bad credential, a
timeout, a missing bucket, a refused write.
**Why:** the store does not wrap the service's errors. Every put is awaited,
then a best-effort delete removes every size of those params, and the first
error is rethrown **unchanged**, so `@nxgt/s3`'s own handling and messages
apply. A put that timed out on the client may still land on the server after
the cleanup.
**Fix:** read the cause in [`@nxgt/s3`'s troubleshooting](https://github.com/softistx/nxgt-data/blob/develop/packages/s3/docs/troubleshooting.md)
and use a fresh id per upload, so that the cleanup never deletes an image that
is in use:

```ts
const imageId = crypto.randomUUID();
const { version } = await store.replace({ imageId }, await request.blob());
await store.remove({ imageId: former }); // only after the new one is stored
```

With fixed params, a failed `replace` removes the existing image too.

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
