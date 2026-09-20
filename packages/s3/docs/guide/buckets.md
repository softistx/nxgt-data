# Buckets

Describing a bucket once — which bucket, how a key is built, and what this
application is willing to put there — then binding that description to
credentials.

## The smallest thing that works

```ts
import { bindBucket, defineBucket } from '@nxgt/s3';

export const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 2 * 1024 * 1024, // bytes
});

const store = bindBucket(avatars, {
	endpoint: process.env.S3_ENDPOINT,
	accessKeyId: process.env.S3_KEY,
	secretAccessKey: process.env.S3_SECRET,
});

store.keyFor({ userId: 'u1' }); // 'u1.png'
```

`defineBucket` talks to nothing, so the definition is what a server, a worker
and a test import; `bindBucket` is the half that needs credentials.
`S3Client` is built into Bun, which is why there is no SDK in `bun add` — and
why this package does not run on Node.

## The signatures

```ts
import type { S3Client, S3File, S3Options, S3Stats } from 'bun';

interface BucketDefinition<P> {
	readonly bucket: string;
	readonly key: (params: P) => string;
	readonly contentType?: string | readonly string[];
	readonly maxSize?: number;
}

function defineBucket<P>(definition: BucketDefinition<P>): BucketDefinition<P>;

function bindBucket<P>(
	definition: BucketDefinition<P>,
	options?: Omit<S3Options, 'bucket'>,
): BoundBucket<P>;

interface BoundBucket<P> {
	readonly client: S3Client;
	keyFor(params: P): string;
	file(params: P): S3File;
	put(params: P, body: PutBody, options?: PutOptions): Promise<void>;
	bytes(params: P): Promise<Uint8Array | undefined>;
	text(params: P): Promise<string | undefined>;
	exists(params: P): Promise<boolean>;
	stat(params: P): Promise<S3Stats | undefined>;
	delete(params: P): Promise<void>;
	list(options?: {
		prefix?: string;
		limit?: number;
		cursor?: string | null;
	}): Promise<ObjectPage>;
	presignGet(params: P, options?: PresignOptions): string;
	presignPut(params: P, options?: PresignOptions): string;
}
```

## The definition

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `bucket` | `string` | required | the bucket's name on the service |
| `key` | `(params: P) => string` | required | the object's key, from whatever identifies it |
| `contentType` | `string \| readonly string[]` | anything goes | the content types this bucket accepts; a write of anything else is refused **before it is sent** |
| `maxSize` | `number` | anything goes | the biggest body, in **bytes**, refused before it is sent |

The key is a **function**, not a template, so nothing is spelled by hand at a
call site and a renamed parameter is a compile error. `P` is whatever that
function takes:

```ts
const uploads = defineBucket({
	bucket: 'uploads',
	key: (p: { folder: string; name: string }) => `${p.folder}/${p.name}`,
});

bindBucket(uploads).keyFor({ folder: 'a', name: 'b.txt' }); // 'a/b.txt'
```

`keyFor` exists so a caller that needs the string gets *the* string. Building
one by hand somewhere else is how a bucket ends up with two spellings of the
same object.

What `contentType` and `maxSize` do is [Writing](writes.md); they are guards
on `put`, and nothing else on the object goes through them.

`defineBucket` refuses a definition that could never work, at import time:

```ts
defineBucket({ bucket: '', key: () => 'k' });
// TypeError: defineBucket: a bucket definition needs a bucket

defineBucket({ bucket: 'b', key: () => 'k', maxSize: 0 });
// TypeError: defineBucket: "b" has a maxSize of 0; it is a number of bytes…

defineBucket({ bucket: 'b', key: () => 'k', contentType: [] });
// TypeError: … accepts an empty list of content types, so nothing could ever
// be written. Leave `contentType` out to accept anything
```

The definition it gives back is frozen, so it cannot drift once it is shared.

## Binding it

`options` is Bun's own `S3Options` without `bucket` — the bucket comes from
the definition, and a call may never change it. It is optional: given none,
Bun reads its own `S3_*` / `AWS_*` environment variables.

```ts
const store = bindBucket(avatars); // credentials from the environment
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `endpoint` | `string` | AWS | the service's URL; anything S3-compatible Bun can sign for |
| `accessKeyId` / `secretAccessKey` | `string` | `$S3_*` / `$AWS_*` | the credentials |
| `sessionToken` | `string` | `$AWS_SESSION_TOKEN` | for temporary credentials |
| `region` | `string` | `$S3_REGION` / `$AWS_REGION` | the region to sign for |
| `virtualHostedStyle` | `boolean` | `false` | `bucket.host` URLs instead of `host/bucket`; a service that is not AWS usually wants it left off |
| `acl`, `storageClass` | see [Writing](writes.md) | — | a default for every object this client writes |
| `retry`, `partSize`, `queueSize` | `number` | Bun's | the client's own transfer tuning. A [`put`](writes.md) takes none of these: it is one PUT |

Each bound bucket holds an `S3Client` of its own. S3 is stateless HTTP —
there is no connection to share, and **nothing to close**.

## Everything this package does not wrap

```ts
store.client;               // Bun's S3Client
store.file({ userId: 'u1' }); // Bun's lazy S3File
```

`file(params)` is the handle for `.stream()`, `.slice()`, `.writer()` and the
rest, keyed by the definition rather than by a string you typed. It is also
the way to write a body in parts, which `put` does not do.

## Types a caller names

```ts
import type { BoundBucket, ParamsOf } from '@nxgt/s3';

type AvatarParams = ParamsOf<typeof avatars>; // { userId: string }

async function purge(bucket: BoundBucket<AvatarParams>, userId: string) {
	await bucket.delete({ userId });
}
```

`stat` gives back Bun's own `S3Stats`, which this package does not re-export:
import it from `bun` where you need to name it.

## Next

- [Writing](writes.md) — `put`, its options, and the guards.
- [Reading](reads.md) — `bytes`, `text`, `stat`, `exists` and `list`.
- [Presigned URLs](presigned-urls.md) — the same definition, signed.
