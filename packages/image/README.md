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
| `@nxgt/image` | `defineImageSet`, `ImageError`, and the types `ImageSet`, `ImageSetOptions`, `ProcessOptions`, `CropBox`, `ProcessedImage`, `ImageVariant`, `ImageErrorCode`, `ImageErrorReason` |
| `@nxgt/image/s3` | `bindImageStore`, and the types `ImageStore`, `StoredImage`, `StoredVariant` (needs `@nxgt/s3`) |

## Process an upload

`defineImageSet` fixes what to make of an upload; `process` does it. The input
is a `Uint8Array`, an `ArrayBuffer`, a `Blob` or a `ReadableStream<Uint8Array>`.

```ts
import { defineImageSet, ImageError } from '@nxgt/image';
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
			return c.json({ error: error.code, reason: error.reason }, 422);
		}
		throw error;
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
| `maxBytes` | `number` | 5 MiB | the upload's byte limit |
| `maxPixels` | `number` | `50_000_000` | the most pixels (width x height) an upload may claim; the default means up to about 225 MB per decoding call |
| `minSide` | `number` | the largest of `sizes` | the smallest side the upload, or its crop, may have, so nothing is enlarged |
| `quality` | `number` | `80` | the WebP quality, 1 to 100 |
| `concurrency` | `number` | `2` | how many uploads decode at once, 1 to 64; bounds memory: about 4.5 bytes per pixel per decoding call (150 MB for a 36 MP photo) |

```ts
import { defineImageSet } from '@nxgt/image';

const photos = defineImageSet({
	sizes: [1024, 256],
	maxBytes: 10 * 1024 * 1024,
	maxPixels: 40_000_000,
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

A crop that is not three whole numbers of 0 or more, or does not fit the image,
is a `RangeError`. A crop that fits but is under `minSide` is refused as `TOO_SMALL`.
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

## Errors

A refusal is an `ImageError` whose `code` and `reason` tell a caller which
check failed. Every one is thrown before anything is stored.

| `code` | `reason` | When |
| --- | --- | --- |
| `TOO_LARGE` | `bytes`, `pixels` | the upload is over `maxBytes`, or claims more than `maxPixels` |
| `UNSUPPORTED_TYPE` | `format`, `heic-unavailable` | the first bytes are not a JPEG, PNG, WebP or HEIC, a HEIC on a machine that cannot decode one (Linux), or a format this machine cannot decode |
| `UNDECODABLE` | `decode` | the format is right and the content is damaged or unsupported |
| `TOO_SMALL` | `dimensions` | the short side, or the crop, is under `minSide` |

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

Other errors (a bad crop, an S3 failure, an out-of-memory) are not turned into
an `ImageError`.

The exact messages of the other errors, each explained in
[troubleshooting](docs/troubleshooting.md):

- `TypeError`: [`image input must be a Uint8Array, an ArrayBuffer, a Blob or a ReadableStream of Uint8Array`](docs/troubleshooting.md#image-input-must-be-a-uint8array-an-arraybuffer-a-blob-or-a-readablestream-of-uint8array)
- `TypeError`: [`a stream chunk must be a Uint8Array`](docs/troubleshooting.md#a-stream-chunk-must-be-a-uint8array)
- `TypeError` from an option: [`<option> must be a whole number of <min> or more, got <value>`, `<option> must be a whole number of <min> to <max>, got <value>`, `sizes must be a non-empty array of whole numbers`, `sizes must be unique, got [<sizes>]`](docs/troubleshooting.md#input-and-options)
- `RangeError`: [`a crop is { x, y, size }, three whole numbers of 0 or more`](docs/troubleshooting.md#a-crop-is--x-y-size--three-whole-numbers-of-0-or-more)
- `RangeError`: [`a <size>px crop at (<x>, <y>) does not fit the <w>x<h> image`](docs/troubleshooting.md#a-sizepx-crop-at-x-y-does-not-fit-the-wxh-image)
- `RangeError`: [`<call>: size <n> is not one of the set's sizes (<sizes>)`](docs/troubleshooting.md#call-size-n-is-not-one-of-the-sets-sizes-sizes)
- `TypeError` on an old Bun: [`@nxgt/image needs Bun 1.4.1 or later, where Bun.Image exists`](docs/troubleshooting.md#nxgtimage-needs-bun-141-or-later-where-bunimage-exists)

## Documentation

- [docs/README.md](docs/README.md): the index of the guides.
- [Processing](docs/guide/processing.md): inputs, limits, the crop, memory, HEIC.
- [Storing](docs/guide/storing.md): bucket keys, the fresh-id recipe, serving.
- [docs/troubleshooting.md](docs/troubleshooting.md): the messages a consumer sees, and their fixes.
- [docs/roadmap.md](docs/roadmap.md): what is next.
