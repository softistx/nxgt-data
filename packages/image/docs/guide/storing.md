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

const avatarSet = defineImageSet({ sizes: [256, 64] });
const avatars = bindImageStore(
	avatarSet,
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

A `size` outside the set's `sizes` is a `RangeError` that names the call:
`presignGet: size 128 is not one of the set's sizes (256, 64)`. `ImageSet.sizes` is public,
so a caller can list them.

A refused upload (an `ImageError`, a bad crop included) comes out
**before anything is written**. S3 errors are rethrown unchanged.

## What the bucket must accept

`replace` puts `image/webp`, so the bucket's `contentType` (if the definition
names one) must include it, and its `maxSize` must be at least the largest
variant. Otherwise every put is refused before it is sent and `replace` throws
that refusal; nothing is deleted, since nothing was written.

Bind the bucket **without a public default `acl`**: the store passes none, so
Bun would send the bucket's on every put. Some services (AWS buckets with ACLs
disabled, the default) refuse an ACL header outright. A bucket policy can still
make objects public if you want that.

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

In an HTTP route, `uploadImage(store, owner, request)` does the first step for
you: it checks the request is `image/*` (`UNSUPPORTED_TYPE` otherwise),
generates the fresh id, reads the optional `?x=&y=&size=` crop with
`cropFromQuery`, streams the body into `replace` (so the byte limit is
`TOO_LARGE` mid-stream) and returns `{ id, version, variants }`:

```ts
import { uploadImage } from '@nxgt/image/s3';

const { id, version } = await uploadImage(avatars, { userId }, request);
```

`owner` is the store's params without `imageId`, so the key must take an
`imageId` string. A blank or non-numeric crop value is refused as
`INVALID_CROP`, an error to answer with a 4xx.

Why not a fixed key such as `{ userId }`? Because the replacing upload would
land on the same keys as the image it replaces, and the cleanup that follows
("remove the former image") would then delete the **new** one. A fixed key
also has a failure mode of its own: a failed `replace` may have overwritten
some sizes before another failed, and the cleanup removes those. With a fresh
id, a failed `replace` touches only objects nobody references yet.

Keep this order: save the id, then remove the former image, and never inside a
transaction that may roll back (the bytes would be gone while the row points at
them). `remove` on a service that answers 404 to a delete of a missing object
(for example GCS) throws `NoSuchKey`; a versioned bucket keeps the bytes behind
delete markers, so expire old versions with a lifecycle rule.

If the process dies between `replace` and `remove`, the former image stays as
an unreferenced object: sweep for those with a lifecycle rule or a job.

## A failed put

`replace` puts every size at once. If one put fails, it deletes the keys whose
put succeeded (best effort), never the key whose put was refused, and rethrows
the first put error, first meaning first in the order of `sizes`, not first in
time. A put that failed after sending (a network error) may still land on the
server after the delete; under a fresh id that leaves at worst one unreferenced
object.

## Serving

Objects are **never public**: the store passes no `acl` (bind the bucket without
a public one). Serve them through a signed URL or through your own route.

```ts
// a signed URL, valid for 5 minutes
const url = avatars.presignGet({ imageId }, 64, { expiresIn: 300 });

// or stream it from a route
app.get('/avatars/:imageId/:size', async (c) => {
	const size = Number(c.req.param('size'));
	if (!avatarSet.sizes.includes(size)) return c.notFound();
	const bytes = await avatars.bytes({ imageId: c.req.param('imageId') }, size);
	if (!bytes) return c.notFound();
	return c.body(bytes, 200, {
		'Content-Type': 'image/webp',
		'Cache-Control': 'private, max-age=86400',
	});
});
```

A size that is not in the set throws a `RangeError` before any request is
made: it is the caller's bug, so the route checks the URL parameter against
`set.sizes` first and answers 404, as above (`avatarSet` is the set passed to
`bindImageStore`).

## `version`

`version` is 16 hex characters of the SHA-256 over the variants' bytes, in the
order of `sizes`. The same picture processed again gives the same version, so
it works as a cache-busting query or an ETag:

```ts
const etag = `"${stored.version}"`;
const src = `/avatars/${imageId}/256?v=${stored.version}`;
```

Store it beside the id: it changes whenever the image does.
