# Processing an upload

How `defineImageSet(...).process(input, { crop })` turns an upload into square
WebP variants, and what it refuses. For storing the result, see
[storing](storing.md).

```ts
import { defineImageSet } from '@nxgt/image';

const avatars = defineImageSet({ sizes: [256, 64] });
const { source, variants } = await avatars.process(await request.blob());

console.log(source); // { format: 'jpeg', width: 3024, height: 4032 }
for (const v of variants) console.log(v.size, v.contentType, v.bytes.byteLength);
```

```ts
type ImageInput =
	| Uint8Array
	| ArrayBuffer
	| Blob
	| ReadableStream<Uint8Array>;

type ImageSet = {
	readonly sizes: readonly number[];
	process(input: ImageInput, options?: ProcessOptions): Promise<ProcessedImage>;
};

type ProcessedImage = {
	source: { format: 'jpeg' | 'png' | 'webp' | 'heic'; width: number; height: number };
	variants: ImageVariant[]; // one per size, in the order of `sizes`
};
```

## Inputs

| Input | How its size is checked |
| --- | --- |
| `Uint8Array`, `ArrayBuffer`, `Blob` | against `maxBytes` before anything is read; a `Blob` is checked again once read, since its size is only a claim |
| `ReadableStream<Uint8Array>`, a `Blob` whose `size` is not a number (Bun's `S3File`) | chunk by chunk; the stream is cancelled at the chunk that crosses `maxBytes`, so no more than the limit plus one chunk is held |

```ts
const { variants } = await avatars.process(request.body as ReadableStream<Uint8Array>);
```

Anything else is a `TypeError`:
`image input must be a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream of Uint8Array`.
A stream chunk that is not a `Uint8Array` is a `TypeError` too
(`a stream chunk must be a Uint8Array`).

The format is judged by the **first bytes**, never by a file name or a declared
content type. JPEG, PNG, WebP and HEIC are accepted; anything else, AVIF
included, is `UNSUPPORTED_TYPE` with reason `format`. `format` also covers a
format this machine cannot decode, other than HEIC.

An AVIF file relabelled with HEIF brands (`mif1` and no `avif` brand) passes
the sniff as HEIC. Where the machine decodes it (macOS), it is re-encoded to
WebP like any other image; elsewhere it is `heic-unavailable`. Known and
harmless: nothing but the pixels leaves the pipeline.

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `sizes` | `readonly number[]` | `[256, 64]` | the square sides to produce, unique whole numbers from 1 to 4096 |
| `maxBytes` | `number` | `5 * 1024 * 1024` | byte limit; over it is `TOO_LARGE` (`bytes`) |
| `maxPixels` | `number` | `50_000_000` | width x height limit, which covers a 48 MP phone; over it is `TOO_LARGE` (`pixels`) |
| `minSide` | `number` | the largest of `sizes` | the smallest side of the image, or of the crop; under it is `TOO_SMALL` |
| `quality` | `number` | `80` | WebP quality, 1 to 100 |
| `concurrency` | `number` | `2` | uploads that decode at once, 1 to 64 |

A bad option throws a `TypeError` when the set is defined:

| Message |
| --- |
| `sizes must be a non-empty array of whole numbers` |
| `sizes[] must be a whole number of 1 to 4096, got <value>` |
| `sizes must be unique, got [<sizes>]` |
| `<option> must be a whole number of <min> or more, got <value>` (`maxBytes`, `maxPixels`, `minSide`) |
| `<option> must be a whole number of <min> to <max>, got <value>` (`quality`, `concurrency`) |

```ts
defineImageSet({ quality: 0 }); // TypeError: quality must be a whole number of 1 to 100, got 0
```

`minSide` applies to the short side of the image, or to `crop.size` when a crop
is given. It is checked **after** the crop's shape and fit: a crop that does
not fit the image is a `RangeError` whatever its size, and a crop that fits but
is under `minSide` is `TOO_SMALL`.

## The crop

Without a crop, the centred square of the short side is kept. With one, give
`{ x, y, size }` in pixels of the **oriented** picture: the one a person sees
after EXIF rotation. A phone photo stored sideways with an orientation tag is
cropped as the upright picture.

**Orientation is applied for a JPEG only** (measured on Bun 1.4.3): the
orientation of a PNG (`eXIf` chunk) or of a WebP (`EXIF` chunk) is ignored, so
for those the picture is cropped as stored.

```ts
const { source } = await avatars.process(bytes);            // oriented size
const side = Math.min(source.width, source.height);

await avatars.process(bytes, { crop: { x: 0, y: 0, size: side } });
```

```ts
type CropBox = { x: number; y: number; size: number };
```

| Crop | Result |
| --- | --- |
| not three whole numbers of 0 or more | `RangeError`: `a crop is { x, y, size }, three whole numbers of 0 or more` |
| outside the image | `RangeError`: `a <size>px crop at (<x>, <y>) does not fit the <w>x<h> image` |
| `size` under `minSide` | `ImageError` `TOO_SMALL`: `the crop is <size>px, under the <minSide>px minimum` |

A `RangeError` is the caller's mistake, not an upload refusal, so it is not an
`ImageError`.

## Refusals

```ts
import { defineImageSet, ImageError } from '@nxgt/image';

try {
	await avatars.process(bytes);
} catch (error) {
	if (!(error instanceof ImageError)) throw error;
	switch (error.reason) {
		case 'bytes':
		case 'pixels':
			return respond(413);
		case 'format':
		case 'heic-unavailable':
			return respond(415);
		case 'decode':
		case 'dimensions':
			return respond(422);
	}
}
```

| `code` | `reason` | Message |
| --- | --- | --- |
| `TOO_LARGE` | `bytes` | `the upload is over <maxBytes> bytes` |
| `TOO_LARGE` | `pixels` | `the image has too many pixels`, or `the PNG has <w>x<h> pixels, over the <maxPixels> limit` |
| `UNSUPPORTED_TYPE` | `format` | `the upload is not a JPEG, PNG, WebP or HEIC`, or `this machine cannot decode <format>` |
| `UNSUPPORTED_TYPE` | `heic-unavailable` | `this machine cannot decode HEIC (Linux cannot)` |
| `UNDECODABLE` | `decode` | `the <format> image cannot be decoded`, or `the PNG cannot be read: <why>` |
| `TOO_SMALL` | `dimensions` | `the image is <w>x<h>, under <minSide>px on its short side`, or the crop message above |

When Bun refuses the image, its own error is `error.cause`. An error that
Bun's refusal codes do not cover (a bug, an out-of-memory) is rethrown
untouched, never taken for a bad upload.

## HEIC

HEIC decodes where Bun's `Bun.Image` can decode it: **macOS and Windows**. On
Linux a HEIC is refused as `UNSUPPORTED_TYPE` with reason `heic-unavailable`.
If your server runs on Linux and users upload from iPhones, ask the client to
convert, or answer that refusal with a message that says so.

## The pipeline, and why `maxPixels` is checked twice

`Bun.Image` has no crop, so the package crops on pixels it decodes itself:

1. read the bytes (`maxBytes`) and sniff the format;
2. read the oriented size with `Bun.Image(...).metadata()` under `maxPixels`
   (first check, on what the upload **claims**);
3. check the crop and `minSide`;
4. shrink the image once, to a PNG at Bun's default level, only as far as the
   largest size needs;
5. read that PNG with the package's own reader **while it inflates**, which
   checks `maxPixels` again (second check, on what the PNG **holds**), keeps
   two rows at a time and copies only the square's columns, then stops after
   the square's last row;
6. resize the square to each size and encode it to WebP.

The second check exists because the reader in step 5 is ours, not Bun's: it
does not trust a header that step 4 produced. It also refuses inflated data
longer than the header promises, as far as it reads: it stops after the
square, so data past the last row it needs is never looked at.

The PNG of step 4 is **not** uncompressed. Level 0 is about 15 times faster, but
Bun 1.4.3 never gives the memory of a level 0 (or 1) `png()` back: a loop of
them grew the process by about 140 MB per call (7 GB after 60), where the
default level stays flat. A 36 MP call takes about 1.7 s for that encode.

## Memory and `concurrency`

A call holds about 4 bytes per pixel of the upload at its peak, and **all of it
is `Bun.Image`'s own decode and PNG encode** in step 4: our reader adds two rows
and the crop, nothing that grows with the image. Measured on Bun 1.4.3 (the
growth of the process's RSS, one JPEG at a time):

| Source | 1 call | 4 calls, `concurrency` 2 | 4 calls, `concurrency` 1 |
| --- | --- | --- | --- |
| 36 MP, 256 px crop | 150 MB | 300 MB | 150 MB |
| 49 MP, 256 px crop | 200 MB | n/a | n/a |

Plan on **4.5 bytes per pixel per decoding call**: about 225 MB at the default
`maxPixels`, and a ceiling of `concurrency x 4.5 x maxPixels` bytes, 450 MB at
the defaults. The limit is per set, so two sets double it.

`concurrency` is how many calls of one set decode at once; the others wait in
order after their bytes are read and sniffed. **The wait queue is not
bounded**, and each waiting call holds its upload's bytes (up to `maxBytes`):
a server that can receive more uploads than it decodes should cap them before
they reach `process`.

```ts
// a small server: one decode at a time, a lower pixel ceiling
const avatars = defineImageSet({ concurrency: 1, maxPixels: 25_000_000 });
```

## Metadata and colour

Every variant is a fresh WebP: ICC profile, EXIF (GPS included), XMP and every
other metadata are gone.

**The pixels are not converted to sRGB.** The ICC profile is dropped and this
package does not convert the pixels to sRGB, so a Display P3 or Adobe RGB photo
may look a little flatter. If colour accuracy matters, convert to
sRGB before the upload reaches this package.
