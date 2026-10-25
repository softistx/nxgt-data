# Storing the variants

`bindImageStore` from `@nxgt/image/s3` processes an upload and puts every size
into a `@nxgt/s3` bucket in one call. It needs the optional peer: `bun add
@nxgt/s3`. For the processing itself, see [processing](processing.md).

```ts
import { randomUUID } from 'node:crypto';
import { defineImageSet } from '@nxgt/image';
import { bindImageStore } from '@nxgt/image/s3';
import { bindBucket, defineBucket } from '@nxgt/s3';

const bucket = defineBucket({
	bucket: 'avatars',
	key: (p: { imageId: string; size: number }) =>
		`avatars/${p.imageId}/${p.size}.webp`,
});

const avatars = bindImageStore(
	defineImageSet({ sizes: [256, 64] }),
	bindBucket(bucket, {
		endpoint: 'https://s3.example.com', // your own, from the environment
		accessKeyId: 'access-key',
		secretAccessKey: 'secret-key',
	}),
);

const imageId = randomUUID();
const stored = await avatars.replace({ imageId }, await request.blob());
// { version: '3f9c2a41b7d0e856', variants: [{ size: 256, key, width, height, contentType, byteLength }, ...] }
```

## The key takes a `size`

The bucket's key function must take a `size: number` beside its other params,
and use it: two sizes under one key would overwrite each other. The store's
params are the bucket's **minus `size`**; it adds the size itself.

```ts
bindImageStore<P extends { size: number }>(
	set: ImageSet,
	bucket: BoundBucket<P>,
): ImageStore<Omit<P, 'size'>>;
```

## The store

```ts
type ImageStore<P> = {
	replace(params: P, input: ImageInput, options?: ProcessOptions): Promise<StoredImage>;
	remove(params: P): Promise<void>;
	presignGet(params: P, size: number, options?: PresignGetOptions): string;
	bytes(params: P, size: number): Promise<Uint8Array | undefined>;
	keyFor(params: P, size: number): string;
};

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

| Method | Does |
| --- | --- |
| `replace(params, input, { crop })` | processes the upload, then puts every size as `image/webp`; returns `{ version, variants }` |
| `remove(params)` | deletes every size; a missing object is not an error |
| `presignGet(params, size, options)` | a signed URL for one size |
| `bytes(params, size)` | the bytes of one size, `undefined` when missing |
| `keyFor(params, size)` | the key of one size |

A `size` outside the set's `sizes` is a `RangeError`:
`size 128 is not one of the set's sizes (256, 64)`. `ImageSet.sizes` is public,
so a caller can list them.

A refused upload (`ImageError`, or a `RangeError` from a bad crop) comes out
**before anything is written**. S3 errors are rethrown unchanged.

## Use a fresh id per upload

Put an id that changes on every upload in the key, store it, and remove the
former id's images afterwards:

```ts
const imageId = randomUUID();
const { version } = await avatars.replace({ imageId }, await request.blob());

const former = user.avatar?.imageId;
user.avatar = { imageId, version };
await user.save();

if (former) await avatars.remove({ imageId: former });
```

Why not a fixed key such as `{ userId }`? Because the replacing upload would
land on the same keys as the image it replaces, and the cleanup that follows
("remove the former image") would then delete the **new** one. A fixed key
also has a failure mode of its own: a failed put cleans up every size of those
params, which removes the existing image too. With a fresh id, a failed
`replace` touches only objects nobody references yet.

If the process dies between `replace` and `remove`, the former image stays as
an unreferenced object: sweep for those with a lifecycle rule or a job.

## A failed put

`replace` puts every size at once. If one put fails, it deletes every size of
those params (best effort) and rethrows the first put error, first meaning
first in the order of `sizes`, not first in time. A put that rejected on a
client timeout may still land on the server after the delete; under a fresh id
that leaves at worst one unreferenced object.

## Serving

Objects are **never public**: the store passes no `acl`. Serve them through a
signed URL or through your own route.

```ts
// a signed URL, valid for 5 minutes
const url = avatars.presignGet({ imageId }, 64, { expiresIn: 300 });

// or stream it from a route
app.get('/avatars/:imageId/:size', async (c) => {
	const bytes = await avatars.bytes(
		{ imageId: c.req.param('imageId') },
		Number(c.req.param('size')),
	);
	if (!bytes) return c.notFound();
	return c.body(bytes, 200, {
		'Content-Type': 'image/webp',
		'Cache-Control': 'private, max-age=86400',
	});
});
```

A size that is not in the set throws a `RangeError` before any request is
made, so a route that takes the size from a URL should catch it and answer 404.

## `version`

`version` is 16 hex characters of the SHA-256 over the variants' bytes, in the
order of `sizes`. The same picture processed again gives the same version, so
it works as a cache-busting query or an ETag:

```ts
const etag = `"${stored.version}"`;
const src = `/avatars/${imageId}/256?v=${stored.version}`;
```

Store it beside the id: it changes whenever the image does.
