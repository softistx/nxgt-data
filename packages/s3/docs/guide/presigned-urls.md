# Presigned URLs

Handing a browser or another service a URL that reads or writes one object,
for a while, without ever handing over a credential.

## The smallest thing that works

```ts
import { bindBucket, defineBucket } from '@nxgt/s3';

const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 2 * 1024 * 1024,
});

const store = bindBucket(avatars);

const download = store.presignGet({ userId: 'u1' }, { expiresIn: 300 }); // seconds
const upload = store.presignPut({ userId: 'u1' }, { expiresIn: 300 });
```

Both are synchronous: signing is arithmetic, not a request. The key comes
from the definition, so a signed URL and a `put` can never disagree about
which object they mean — see [Buckets](buckets.md).

## The signatures

```ts
import type { S3Options } from 'bun';

presignGet(params: P, options?: PresignOptions): string;
presignPut(params: P, options?: PresignOptions): string;

interface PresignOptions {
	expiresIn?: number;
	acl?: S3Options['acl'];
}
```

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `expiresIn` | `number` | Bun's, one day | **seconds** until the URL expires. Always pass one |
| `acl` | `'private' \| 'public-read' \| …` | none | the ACL the URL is signed for, where the service honours it |

A day is a long time for a URL that anyone can forward. Sign for the time the
page actually needs:

```ts
const url = store.presignGet({ userId: 'u1' }, { expiresIn: 60 });
const answer = await fetch(url);
answer.status; // 200 — it really reads the object
```

## A presigned PUT constrains the key and the deadline, and nothing else

Not the size. Not the content type.

```ts
const url = store.presignPut({ userId: 'u1' }, { expiresIn: 60 });

await fetch(url, {
	method: 'PUT',
	body: Bun.file('archive.zip'),
	headers: { 'content-type': 'application/zip' },
});
// 200 — stored, in a bucket whose definition says image/png only
```

That is why `presignPut` takes no `type`: it would read as a guarantee it
cannot make. Measured on bun 1.4.2, `presign`'s `type` only adds
`response-content-type` — S3's override for what a *download* is labelled —
and `X-Amz-SignedHeaders` stays `host`, so the uploader's `Content-Type` is
never signed.

The bucket's `contentType` and `maxSize` are [`put`'s guards](writes.md),
and whoever holds a signed URL is not going through `put`. Where it matters:

- check with `stat` after the upload and delete what does not belong, or
- enforce it in the service's own bucket policy.

```ts
const found = await store.stat({ userId: 'u1' });
if (!found || !found.type.startsWith('image/')) {
	await store.delete({ userId: 'u1' });
}
```

## A URL is signed for the bound bucket, whatever the options say

`PresignOptions` carries no `bucket`, `endpoint`, `region` or credential, and
the run time signs with only the two keys above — anything else is dropped.

```ts
import type { PresignOptions } from '@nxgt/s3';

// A bag off a request body never met the types.
const bag = { expiresIn: 60, bucket: 'somewhere-else' } as PresignOptions;

store.presignGet({ userId: 'u1' }, bag); // …/avatars/u1.png, on this endpoint
```

Measured before that filter existed, such a bag redirected the URL: a
`bucket` key signed it for another bucket, and a credential key signed it
against another endpoint entirely.

## A real one: upload from the browser, read it back

```ts
import { Hono } from 'hono';
import { bindBucket, defineBucket } from '@nxgt/s3';

const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 2 * 1024 * 1024,
});

const store = bindBucket(avatars);
const app = new Hono();

// The browser PUTs the file straight to the service: no body through here.
app.post('/users/:id/avatar/upload-url', (c) => {
	const userId = c.req.param('id');
	return c.json({
		url: store.presignPut({ userId }, { expiresIn: 120 }),
		key: store.keyFor({ userId }),
	});
});

// …and the browser is told, later, where to read it.
app.get('/users/:id/avatar', async (c) => {
	const userId = c.req.param('id');
	if (!(await store.exists({ userId }))) {
		return c.json({ error: 'No avatar' }, 404);
	}
	return c.redirect(store.presignGet({ userId }, { expiresIn: 300 }));
});
```

The upload route authorises the *user*; the URL it hands back authorises
nothing else. Keep `expiresIn` close to how long an upload should take, and
verify the object afterwards if the bucket's own policy does not.

## Next

- [Writing](writes.md) — the guards a presigned PUT bypasses.
- [Reading](reads.md) — `stat` and `exists`, for checking what was uploaded.
- [Troubleshooting](../troubleshooting.md) — a URL that 403s or expired.
