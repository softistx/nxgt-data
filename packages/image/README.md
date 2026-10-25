# @nxgt/image

Avatar and photo uploads on Bun's own `Bun.Image`: checked by magic bytes,
cropped square, resized to WebP with every metadata stripped. No dependency at
all, and Bun only (1.4.1 or later, where `Bun.Image` landed).

```sh
bun add @nxgt/image
```

This version holds the refusal type the package throws; the processing entry
points follow in the next releases.

```ts
import { ImageError } from '@nxgt/image';

try {
	// ...
} catch (error) {
	if (error instanceof ImageError && error.code === 'TOO_LARGE') {
		// error.reason is 'bytes' or 'pixels'
	}
}
```

## Errors

| `code` | `reason` | When |
| --- | --- | --- |
| `TOO_LARGE` | `bytes`, `pixels` | the upload is over the byte limit, or claims more pixels than the limit |
| `UNSUPPORTED_TYPE` | `format`, `heic-unavailable` | the first bytes are not a JPEG, PNG, WebP or HEIC, or a HEIC on a machine that cannot decode one (Linux) |
| `UNDECODABLE` | `decode` | the format is right and the content is damaged or unsupported |
| `TOO_SMALL` | `dimensions` | the image is under the smallest side asked for |
