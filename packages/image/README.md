# @nxgt/image

Avatar and photo uploads on **Bun's own `Bun.Image`**: an upload is checked by
its first bytes, cropped to a square, resized and re-encoded to WebP, with
every piece of metadata stripped. Refusals are thrown before anything is
stored, and `@nxgt/image/s3` stores the result in a `@nxgt/s3` bucket.

```ts
import { defineImageSet } from '@nxgt/image';

const avatars = defineImageSet();
const { variants } = await avatars.process(await request.blob());
// variants: a 256 px and a 64 px square, as image/webp
```

> **0.x.** The API is still settling.

## Install

```sh
bun add @nxgt/image typescript @types/bun@^1.4.1
bun add @nxgt/s3   # optional: only for @nxgt/image/s3
```

- **Bun 1.4.1 or later, and Bun only.** `Bun.Image` landed in 1.4.1; this
  package does not run on Node. It has no required dependency: the image
  work is Bun's own. HEIC decodes on macOS and Windows and is refused on Linux.
- `typescript` `^6.0.3 || ^7.0.0`: required peer.
- `@types/bun` `^1.4.1`: needed to typecheck the shipped declarations.
- `@nxgt/s3`: **optional** peer, needed only for the `/s3` subpath. The root
  entry never imports it.

## Subpaths

| Subpath | Exports |
| --- | --- |
| `@nxgt/image` | `defineImageSet`, `ImageError`, and the types `ImageSet`, `ImageSetOptions`, `ProcessOptions`, `CropBox`, `ProcessedImage`, `ImageVariant`, `ImageInput`, `ImageErrorCode`, `ImageErrorReason` |
| `@nxgt/image/s3` | `bindImageStore`, and the types `ImageStore`, `StoredImage`, `StoredVariant` (needs `@nxgt/s3`) |

## Process an upload

`defineImageSet` fixes what to make of an upload; `process` does it. The input
is a `Uint8Array`, an `ArrayBuffer`, a `Blob` or a `ReadableStream<Uint8Array>`.

```ts
import { defineImageSet, ImageError, type ImageErrorCode } from '@nxgt/image';
import { Hono } from 'hono'; // hono is only the example router

const avatars = defineImageSet({ sizes: [256, 64] });
const app = new Hono();

app.post('/avatar', async (c) => {
	const form = await c.req.formData();
	const file = form.get('file');
	if (!(file instanceof Blob)) return c.json({ error: 'no file' }, 400);
	try {
		const { source, variants } = await avatars.process(file);
		return c.json({
			format: source.format,
			sizes: variants.map((v) => [v.size, v.bytes.byteLength]),
		});
	} catch (error) {
		if (error instanceof ImageError) {
			// a 4xx for every refusal: the upload or the crop is the caller's
			const statuses = {
				TOO_LARGE: 413,
				UNSUPPORTED_TYPE: 415,
				UNDECODABLE: 422,
				TOO_SMALL: 422,
				INVALID_CROP: 400,
			} as const satisfies Record<ImageErrorCode, number>;
			return c.json(
				{ error: error.code, reason: error.reason },
				statuses[error.code],
			);
		}
		throw error; // anything else is a 500
	}
});
```

The result is `{ source, variants }`: `source` is the upload's format
(`'jpeg' | 'png' | 'webp' | 'heic'`) and its size after EXIF rotation, and
`variants` holds one `image/webp` square per size, in the order of `sizes`, each
with `size`, `width`, `height`, `contentType` and `bytes`.

Any other input type is a `TypeError`.

## Store the variants

`bindImageStore` stores every size in a `@nxgt/s3` bucket whose key takes a
`size` beside its other params. Put a **fresh id per upload** in the key.

```ts
import { randomUUID } from 'node:crypto';
import { defineImageSet } from '@nxgt/image';
import { bindImageStore } from '@nxgt/image/s3';
import { bindBucket, defineBucket } from '@nxgt/s3';

const avatarBucket = defineBucket({
	bucket: 'avatars',
	key: (p: { imageId: string; size: number }) =>
		`avatars/${p.imageId}/${p.size}.webp`,
});

const avatars = bindImageStore(
	defineImageSet(),
	bindBucket(avatarBucket, {
		endpoint: 'https://s3.example.com', // your own, from the environment
		accessKeyId: 'access-key',
		secretAccessKey: 'secret-key',
	}),
);

const imageId = randomUUID();
const { version } = await avatars.replace({ imageId }, await request.blob());
// save imageId and version on the user, then remove the former image:
// await avatars.remove({ imageId: formerImageId });
const url = avatars.presignGet({ imageId }, 64, { expiresIn: 300 });
```

Objects are never public. The bucket must accept `image/webp` and a `maxSize` of at
least the largest variant, and must be bound **without a public default `acl`**
(Bun would send it on every put). See [storing](docs/guide/storing.md) for why the key
carries a fresh id, how to serve images, and what a failed put leaves behind.

## Options

Every option is optional. A bad one throws a `TypeError` naming it when the
set is defined.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `sizes` | `number[]` | `[256, 64]` | the square sides to produce: unique whole numbers, 1 to 4096 |
| `maxBytes` | `number` | 5 MiB | the upload's byte limit. Most 12 MP photos fit; a 48 MP phone JPEG is about 11 MB and is refused unless you raise it |
| `maxPixels` | `number` | `25_000_000` | the most pixels (width x height) an upload may claim; covers 24 MP phone output. Raising it raises the worst-case memory (see [Traps](#traps)) |
| `minSide` | `number` | the largest of `sizes` | the smallest side the upload, or its crop, may have, so nothing is enlarged |
| `quality` | `number` | `80` | the WebP quality, 1 to 100 |
| `concurrency` | `number` | `2` | how many uploads decode at once, 1 to 64. Not a hard memory ceiling: Bun keeps each PNG it encodes until a later collection (see [Traps](#traps)) |

```ts
import { defineImageSet } from '@nxgt/image';

const photos = defineImageSet({
	sizes: [1024, 256],
	maxBytes: 10 * 1024 * 1024,
	maxPixels: 40_000_000, // 36 MP and 40 MP phones: about 4 B/px at the peak
	quality: 85,
	concurrency: 1,
});
```

## Crop

The default is the centred square of the short side. Pass `crop: { x, y, size }`
to keep another one, in pixels of the picture **as a person sees it, after EXIF
rotation**: `(x, y)` is its top-left corner.

```ts
import { defineImageSet } from '@nxgt/image';

const avatars = defineImageSet();
const { variants } = await avatars.process(await request.blob(), {
	crop: { x: 120, y: 40, size: 600 },
});
```

A crop that is not three whole numbers of 0 or more, or is not an object, or does not fit the image,
is an `ImageError` with the code `INVALID_CROP`, so a handler answers a 4xx. A crop that fits but is under `minSide` is refused as `TOO_SMALL`.
Orientation is applied for a JPEG only; a PNG or WebP orientation tag is ignored.

## Output and metadata

Every variant is a WebP square. The ICC profile, EXIF (GPS included), XMP and
every other metadata are removed, so a photo's location never reaches a stored
file.

```ts
import { defineImageSet } from '@nxgt/image';

const [large, small] = (await defineImageSet().process(bytes)).variants;
await Bun.write('avatar-256.webp', large.bytes);
await Bun.write('avatar-64.webp', small.bytes);
```

**Colour is not converted.** The ICC profile is dropped and this package does
not convert the pixels to sRGB, so a Display P3 or Adobe RGB photo may look a
little flatter.

## API

### `defineImageSet(options?)`

`(options?: ImageSetOptions) => ImageSet`. Fixes what to make of an upload and
checks the options once, when it is defined (see [Options](#options)). It
touches nothing and holds no connection.

### `ImageSet`

| Member | |
| --- | --- |
| `sizes` | `readonly number[]`, the sides it produces, in the order of the variants |
| `process(input, { crop }?)` | `Promise<ProcessedImage>`: checks, crops, resizes and re-encodes `input` to WebP, every metadata stripped |

```ts
type ImageInput = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
type CropBox = { x: number; y: number; size: number };
type ProcessOptions = { crop?: CropBox };

type ProcessedImage = {
	source: { format: 'jpeg' | 'png' | 'webp' | 'heic'; width: number; height: number };
	variants: ImageVariant[]; // one per size, in the order of `sizes`
};
type ImageVariant = {
	size: number;
	width: number;
	height: number;
	contentType: 'image/webp';
	bytes: Uint8Array;
};
```

### `ImageError`

`class ImageError extends Error`, with `code: ImageErrorCode` and
`reason: ImageErrorReason` (see [Errors](#errors)). `extends Error`, not
`TypeError`, so a handler's `TypeError` branch never catches it.

```ts
type ImageErrorCode =
	| 'TOO_LARGE'
	| 'UNSUPPORTED_TYPE'
	| 'UNDECODABLE'
	| 'TOO_SMALL'
	| 'INVALID_CROP';
type ImageErrorReason =
	| 'bytes'
	| 'pixels'
	| 'format'
	| 'heic-unavailable'
	| 'decode'
	| 'dimensions'
	| 'crop';
```

### `cropFromQuery(params)`

`(params: URLSearchParams) => CropBox | undefined`. Reads the optional square
crop of an upload route from `?x=&y=&size=`: `undefined` when none of the three
is present, otherwise a crop where a missing, blank or non-numeric value is
`NaN`. Nothing is validated here: the set refuses it as `INVALID_CROP`.

```ts
import { cropFromQuery } from '@nxgt/image';

const crop = cropFromQuery(new URL(request.url).searchParams);
const processed = await set.process(await request.blob(), { crop });
```

### `uploadImage(store, owner, request)` (`@nxgt/image/s3`)

`<P extends { imageId: string }>(store, owner: Omit<P, 'imageId'>, request: Request) => Promise<{ id, version, variants }>`.
Refuses a request whose `content-type` is not `image/*` with
`UNSUPPORTED_TYPE`, then streams the body into `store.replace` under a fresh
`crypto.randomUUID()` id, with the crop of `cropFromQuery`. A body over the
byte limit is `TOO_LARGE`; a bad crop is `INVALID_CROP`. Save `id` and
`version`, then remove the former image.

```ts
import { uploadImage } from '@nxgt/image/s3';

// PUT /images/item?x=0&y=0&size=300
const { id, version } = await uploadImage(avatars, {}, request);
```

### `bindImageStore(set, bucket)` (`@nxgt/image/s3`)

`<P extends { size: number }>(set: ImageSet, bucket: BoundBucket<P>) => ImageStore<Omit<P, 'size'>>`.
The bucket's key takes a `size` number beside its other params; the store's
methods take the params without it.

| `ImageStore<P>` | |
| --- | --- |
| `replace(params, input, { crop }?)` | `Promise<StoredImage>`: processes the upload, puts every size as `image/webp`, returns `{ version, variants }`. A refused upload writes nothing; a failed put deletes only the keys whose put succeeded |
| `remove(params)` | `Promise<void>`: deletes every size; a missing object is fine |
| `presignGet(params, size, options?)` | a signed URL for one size (`options` is `@nxgt/s3`'s `PresignGetOptions`). A `size` outside the set is a `RangeError` |
| `bytes(params, size)` | `Promise<Uint8Array \| undefined>` |
| `keyFor(params, size)` | the key of one size. A `size` outside the set is a `RangeError` |

```ts
type StoredImage = { version: string; variants: StoredVariant[] };
type StoredVariant = {
	size: number;
	key: string;
	width: number;
	height: number;
	contentType: 'image/webp';
	byteLength: number;
};
```

`version` is 16 hex characters of the SHA-256 over the variants' bytes: the
same picture processed again gives the same version, so it can be a
cache-busting query.

## Errors

A refusal is an `ImageError` whose `code` and `reason` tell a caller which
check failed. Every one is thrown before anything is stored.

| `code` | `reason` | When |
| --- | --- | --- |
| `TOO_LARGE` | `bytes`, `pixels` | the upload is over `maxBytes`, or claims more than `maxPixels` |
| `UNSUPPORTED_TYPE` | `format`, `heic-unavailable` | the first bytes are not a JPEG, PNG, WebP or HEIC, a HEIC on a machine that cannot decode one (Linux), or a format this machine cannot decode |
| `UNDECODABLE` | `decode` | the format is right and the content is damaged or unsupported |
| `TOO_SMALL` | `dimensions` | the short side, or the crop, is under `minSide` |
| `INVALID_CROP` | `crop` | the `crop` is not three whole numbers of 0 or more, or does not fit the image |

```ts
import { defineImageSet, ImageError } from '@nxgt/image';

try {
	await defineImageSet().process(bytes);
} catch (error) {
	if (error instanceof ImageError) {
		console.log(error.code, error.reason, error.cause); // cause: Bun's error, when there is one
	}
}
```

Other errors (an S3 failure, an out-of-memory) are not turned into an
`ImageError`. A bad **option** or a wrong **input type** is a `TypeError`, and a
`size` the store does not have is a `RangeError`: all three are the caller's
code, not the upload.

The exact messages of the other errors, each explained in
[troubleshooting](docs/troubleshooting.md):

- `TypeError`: [`image input must be a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream of Uint8Array`](docs/troubleshooting.md#image-input-must-be-a-uint8array-an-arraybuffer-a-blob-or-a-readablestream-of-uint8array)
- `TypeError`: [`a stream chunk must be a Uint8Array`](docs/troubleshooting.md#a-stream-chunk-must-be-a-uint8array)
- `TypeError` from an option: [`<option> must be a whole number of <min> or more, got <value>`, `<option> must be a whole number of <min> to <max>, got <value>`, `sizes must be a non-empty array of whole numbers`, `sizes must be unique, got [<sizes>]`](docs/troubleshooting.md#input-and-options)
- `ImageError` `INVALID_CROP`: [`a crop is { x, y, size }, three whole numbers of 0 or more`](docs/troubleshooting.md#a-crop-is--x-y-size--three-whole-numbers-of-0-or-more)
- `ImageError` `INVALID_CROP`: [`a <size>px crop at (<x>, <y>) does not fit the <w>x<h> image`](docs/troubleshooting.md#a-sizepx-crop-at-x-y-does-not-fit-the-wxh-image)
- `RangeError`: [`<call>: size <n> is not one of the set's sizes (<sizes>)`](docs/troubleshooting.md#call-size-n-is-not-one-of-the-sets-sizes-sizes)
- `TypeError` on an old Bun: [`@nxgt/image needs Bun 1.4.1 or later, where Bun.Image exists`](docs/troubleshooting.md#nxgtimage-needs-bun-141-or-later-where-bunimage-exists)

## What does not compile

Each is a `@ts-expect-error` case in `test/types/process.ts` or
`test/types/s3.ts`.

- An input that is a string (a path) or a number, and a `crop` without `x`,
  `y` and `size` or given as a width and a height.
- `sizes` that is a number or a list of strings, an option the set does not
  have, and a `process` option other than `crop`.
- An `ImageError` built with a `code` or a `reason` that is not in the lists.
- A bucket whose key has no `size`, a `size` that is a string or optional, or
  that is passed inside the params.
- Params missing `imageId` (or whatever the key names) on `replace`, `remove`
  or `keyFor`, a `replace` of a number, and a `remove` with a non-string id.

## Traps

- **Bun 1.4.3 holds on to every `png()` output.** The pipeline encodes one PNG
  per call (the shrunk image), and Bun keeps it until a later collection, about
  its size per call, giving memory back only in bursts. Measured on photo-like
  JPEGs: 70 sequential calls with a 256 px crop climbed to about 720 MB at
  25 MP and past 1.6 GB at 36 MP, then fell back. A centred crop with the
  default sizes stays flat (about 17 MB). The expensive path is a small `crop`
  on a huge image, or large `sizes`: one call peaks at about Bun's decode of the
  source (4 bytes per pixel) + the intermediate PNG + the crop square
  (about `4 x (2 x the largest size)^2` bytes). `concurrency` limits the calls
  in flight, **not** this retention, so it is not a hard memory ceiling; lower
  `maxPixels` to shrink both. See [processing](docs/guide/processing.md#memory-and-concurrency).
- **The default `maxBytes` refuses large phone photos.** `maxPixels` (25 MP)
  admits a 24 MP photo, but 5 MiB refuses many JPEGs above about 12 MP, and a 48 MP one
  (about 11 MB) always. Raise `maxBytes` with `maxPixels`.
- **There is no `acl` option, and a public default `acl` applies.** The store
  passes only `type` on a put, so an `acl` given to `bindBucket` is sent on
  every object. Bind the bucket without one.
- **HEIC is refused on Linux** (`UNSUPPORTED_TYPE`, `heic-unavailable`); it
  decodes on macOS and Windows only.
- **Fixed params plus `remove(former)` delete the new image.** With a key that
  does not change, `replace` writes under the same keys the former image used,
  so removing "the former" removes what you just stored. Use a fresh id per
  upload and remove the former id's set afterwards.
- **Orientation is applied for a JPEG only.** The orientation tag of a PNG or a
  WebP is ignored, so a `crop` is in the stored frame for those.
- **The wait queue behind `concurrency` is unbounded**, and each waiting call
  holds its upload's bytes (up to `maxBytes`). Cap uploads before `process`.
- **A bad `crop` is an `ImageError`** (`INVALID_CROP`), not a `RangeError`:
  answer it with a 4xx like the other refusals.

## Documentation

- [docs/README.md](docs/README.md): the index of the guides.
- [Processing](docs/guide/processing.md): inputs, limits, the crop, memory, HEIC.
- [Storing](docs/guide/storing.md): bucket keys, the fresh-id recipe, serving.
- [docs/troubleshooting.md](docs/troubleshooting.md): the messages a consumer sees, and their fixes.
- [docs/roadmap.md](docs/roadmap.md): what is next.
