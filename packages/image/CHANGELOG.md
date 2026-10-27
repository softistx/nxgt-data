# @nxgt/image

## 0.2.0

### Minor Changes

- [#271](https://github.com/softistx/nxgt-data/pull/271) [`34b6b00`](https://github.com/softistx/nxgt-data/commit/34b6b00582ffcedfdaa5cbc498b5b47247199d4b) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `cropFromQuery(params)` and `uploadImage(store, owner, request)`. `cropFromQuery` (main entry) reads the optional square crop from `?x=&y=&size=`: `undefined` when none of the three is present, otherwise a crop where a missing, blank or non-numeric value is `NaN`, which the set refuses as `INVALID_CROP`. `uploadImage` (`@nxgt/image/s3`) checks the request is `image/*` (`UNSUPPORTED_TYPE` otherwise), streams the body into `store.replace` under a fresh `crypto.randomUUID()` id with the query's crop, and returns `{ id, version, variants }`; a body over the byte limit is the usual `TOO_LARGE` `ImageError`.

### Patch Changes

- Updated dependencies [[`d660cb3`](https://github.com/softistx/nxgt-data/commit/d660cb357013b374bb5676f824f52498b61992b7), [`8387457`](https://github.com/softistx/nxgt-data/commit/8387457d014630b80ef287efed972dadf4a4499e)]:
  - @nxgt/s3@0.7.0

## 0.1.1

### Patch Changes

- [#259](https://github.com/softistx/nxgt-data/pull/259) [`ec54cbb`](https://github.com/softistx/nxgt-data/commit/ec54cbbf2ade7a181a6331ecc875e99da6991c00) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Troubleshooting: since `@nxgt/s3` 0.6.0 a bucket's `timeoutMs` bounds each variant `put` that `replace` makes, so a default sized for reads can end a `replace` with `S3Error` `TIMEOUT`. Raise the bucket's default; `replace` takes no per-call deadline.
- Updated dependencies [[`cb2efa4`](https://github.com/softistx/nxgt-data/commit/cb2efa45c73f4be7bc7bcf655f5797aa90c837b4)]:
  - @nxgt/s3@0.6.0

## 0.1.0

### Minor Changes

- [#254](https://github.com/softistx/nxgt-data/pull/254) [`0af54d1`](https://github.com/softistx/nxgt-data/commit/0af54d183a22ab4b338dfbe43d086a30409e87bb) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First version of `@nxgt/image`, for avatar and photo uploads on Bun's own `Bun.Image`, with no required dependency (`@nxgt/s3` is an optional peer, for `@nxgt/image/s3`). It needs Bun 1.4.1 or later: `defineImageSet` throws a `TypeError` on an older Bun, where `Bun.Image` does not exist.
  
  `defineImageSet(options)` returns an image set, which exposes its `sizes`, whose `process(input, { crop })` turns an upload (bytes, a buffer, a `Blob` or a stream) into square WebP variants. `sizes` (default `[256, 64]`), `maxBytes` (5 MiB), `maxPixels` (25 million, a 24 MP phone; the default 5 MiB `maxBytes` refuses most 48 MP JPEGs, which are about 11 MB, so raise both for those), `minSide` (the largest size), `quality` (80) and `concurrency` (2: how many uploads decode at once; the queue behind it is unbounded) are checked when the set is defined, a bad one throwing a `TypeError` that names it. A call peaks at about Bun's decode of the source (4 bytes per pixel) plus the intermediate PNG and the crop square, the crop being read as the PNG streams: a centred crop with the default sizes grows the process by about 17 MB, a 256 px crop on a 25 MP photo by about 150 MB (36 MP: 210 MB, 49 MP: 280 MB), and `sizes: [4096]` on 49 MP by about 0.9 to 1.3 GB (measured on Bun 1.4.3, photo-like JPEGs). Bun 1.4.3 holds each PNG it encodes until a later collection, so `concurrency` is not a hard memory ceiling: 70 sequential small-crop calls climbed to about 720 MB at 25 MP and past 1.6 GB at 36 MP. The crop PNG is encoded off the main thread. A `Blob` of unknown size (Bun's `S3File`) is read through the byte cap.
  
  An upload is refused before anything is stored, with an `ImageError` whose `code` is `TOO_LARGE`, `UNSUPPORTED_TYPE`, `UNDECODABLE`, `TOO_SMALL` or `INVALID_CROP` and whose `reason` (`bytes`, `pixels`, `format`, `heic-unavailable`, `decode`, `dimensions` or `crop`) tells which limit or check refused it: too many bytes or pixels, a format that is not a JPEG, PNG, WebP or HEIC (judged by its first bytes), a HEIC or another format this machine cannot decode, damaged content, a short side under `minSide`. The crop is the centred square unless `crop: { x, y, size }` gives one, in the picture as a person sees it; orientation applies to a JPEG only. A crop that is not whole numbers or does not fit the image is an `ImageError` with the code `INVALID_CROP`, so a handler answers a 4xx. The result is `{ source, variants }`, one `image/webp` square per size in the order of `sizes`, with the ICC profile, EXIF (GPS included) and every other metadata removed.
  
  The subpath `@nxgt/image/s3`: `bindImageStore(set, bucket)` stores the variants in a `@nxgt/s3` bucket whose key takes a `size` beside its other params. `replace(params, input, { crop })` processes the upload, puts every size as `image/webp` and returns `{ version, variants }`, `version` being 16 hex characters of the SHA-256 over the variants' bytes. `remove(params)` deletes every size (a missing object is fine); `presignGet`, `bytes` and `keyFor` take a size, and a size outside the set is a `RangeError` that names the call (`presignGet: size 128 is not one of the set's sizes (256, 64)`). Objects are never public: no `acl` is passed, so bind the bucket without a public default one. A refused upload writes nothing; a failed put deletes only the keys whose put succeeded, never the refused one, and rethrows the first error. Use a fresh id per upload (`crypto.randomUUID()`): replace under the new id, store it, then remove the former id's set.
