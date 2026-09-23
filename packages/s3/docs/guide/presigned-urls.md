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
| `expiresIn` | `number` | Bun's, one day | **seconds** until the URL expires. Always pass one. Above 604 800 (seven days, S3's own limit), at or below zero, or anything that is not a finite number is an `S3Error` with `code: 'WRONG_OPTION'` |
| `acl` | `'private' \| 'public-read' \| …` | none | the ACL the URL is signed for, where the service honours it |

`acl` goes through the same allowlist a `put` is held to, so a value the
service does not accept is an `S3Error` with `code: 'WRONG_OPTION'` and no
URL is signed:

```ts
import { S3Error } from '@nxgt/s3';

try {
	store.presignPut({ userId: 'u1' }, { acl: 'everyone' as never });
} catch (error) {
	if (error instanceof S3Error && error.code === 'WRONG_OPTION') {
		error.key; // 'u1.png' — the object it was about
	}
}
```

`expiresIn` goes through the same check. Measured on bun 1.4.2, the client
refuses `0` and below itself, and **signs** an `expiresIn` of `1e12`
happily — a URL S3 then rejects at use time, which is the one thing this
package exists not to do. Both ends are refused here now, before anything is
signed.

Before 0.3.0 the values went straight to the client: the same mistake was two
different classes depending on whether it reached a `put` or a `presign`.
There is no `storageClass` here — signing a URL stores nothing, so there is
no class to name.

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

- use a [presigned POST](#a-presigned-post-the-service-holds-the-size-and-the-type)
  instead, whose policy the service enforces, or
- check with `stat` after the upload and delete what does not belong, or
- enforce it in the service's own bucket policy.

```ts
const found = await store.stat({ userId: 'u1' });
if (!found || !found.type.startsWith('image/')) {
	await store.delete({ userId: 'u1' });
}
```

## A presigned POST: the service holds the size and the type

`presignPost` signs an S3 **POST policy** — the form AWS calls a
browser-based upload. The browser posts a `multipart/form-data` form straight
to the bucket, and the **service** checks it against the policy before it
stores anything: the key, a size range and the content type.

```ts
presignPost(params: P, options?: PresignPostOptions): PresignedPost;

interface PresignPostOptions {
	expiresIn?: number;                         // seconds, above 0, at most 604800; a day by default
	maxSize?: number;                           // bytes; the bucket's maxSize by default
	minSize?: number;                           // bytes; 0 by default
	type?: string | { startsWith: string };     // the bucket's single type by default
	acl?: S3Options['acl'];
}

interface PresignedPost {
	url: string;                                // the bucket's own URL
	fields: Record<string, string>;             // post these, then the file
}
```

It is synchronous, like the other two: signing is arithmetic. The key comes
from the definition, as for every other call.

### On the server

```ts
const form = store.presignPost(
	{ userId: 'u1' },
	{ type: 'image/png', expiresIn: 300 },
);
// form.url    → 'https://…/avatars/'
// form.fields → { key: 'u1.png', 'Content-Type': 'image/png',
//                 'x-amz-algorithm', 'x-amz-credential', 'x-amz-date',
//                 policy, 'x-amz-signature' }
```

### In the browser

```ts
const body = new FormData();
for (const [name, value] of Object.entries(form.fields)) body.append(name, value);
body.append('file', file);                      // last: S3 ignores fields after it
const response = await fetch(form.url, { method: 'POST', body });
response.status;                                // 204 when stored
```

`fields` carries the access key id, in `x-amz-credential`, and a session
token when one is set, in `x-amz-security-token` — as a presigned URL carries
them in its query string. Never the secret: the policy is signed with it, and
the signature is all that travels.

On a bucket that names no type, with no `type` given, `fields` has no
`Content-Type`, and the form posts as written: measured, `204`. The object is
stored as `application/octet-stream` — SeaweedFS does not take the file part's
own type — so append `body.append('Content-Type', file.type)` before the file
when the type matters. With `{ startsWith }` that field is **required**:
measured, a form posted without it is refused `403 AccessDenied`.

### What each option becomes

| Option | Condition in the policy | Default |
| --- | --- | --- |
| the params | `["eq", "$key", "<the definition's key>"]` | — |
| `maxSize`, `minSize` | `["content-length-range", minSize, maxSize]` | the bucket's `maxSize`, and `0` |
| `type: 'image/png'` | `["eq", "$Content-Type", "image/png"]`, and the field in `fields` | the bucket's `contentType` when it is one type |
| `type: { startsWith: 'image/' }` | `["starts-with", "$Content-Type", "image/"]`, **no** field — the page's code appends `Content-Type` before the file; a browser adds none by itself | — |
| no `type`, on a bucket that names none | `["starts-with", "$Content-Type", ""]`: the browser may name any type | — |
| `acl` | `["eq", "$acl", "public-read"]`, and the field | none |
| `expiresIn` | the policy's `expiration` | a day, as Bun's for the other two |

The bounds can only tighten the definition, never loosen it:

- a bucket **without** a `maxSize` requires one here — the point of a POST is
  the bound, and a form with none would be a presigned PUT with extra steps;
- a `maxSize` above the bucket's own is refused, and so is a `minSize` above
  the `maxSize`;
- a `type` is checked against the bucket's `contentType` exactly as a `put`'s
  is, and a bucket that names **several** needs one of them: the policy holds
  one;
- a `{ startsWith }` prefix is refused on a bucket that names its types — a
  prefix would let another type through.

Each refusal is an `S3Error`, raised before anything is signed: `WRONG_OPTION`
for a size, a `type` of the wrong shape, an `expiresIn` or an `acl`, and
`WRONG_TYPE` for a type the bucket does not accept. See
[Troubleshooting](../troubleshooting.md).

### What the service answers

Measured against SeaweedFS 4.47's S3 gateway, each one pinned in
[`presign-post.spec.ts`](https://github.com/softistx/nxgt-data/blob/develop/packages/s3/src/bucket/operations/presign-post.spec.ts) in the repository:

| The upload | Status | `<Code>` | `<Message>` |
| --- | --- | --- | --- |
| within the policy | `204` | — | — |
| over `maxSize` | `400` | `EntityTooLarge` | `Your proposed upload exceeds the maximum allowed object size.` |
| under `minSize` | `400` | `EntityTooSmall` | `Your proposed upload is smaller than the minimum allowed object size.` |
| another `Content-Type` (another case, a `;charset`), none where the policy names one, another `key`, another `acl` | `403` | `AccessDenied` | `Invalid according to Policy: Policy Condition failed` |
| a field the policy does not name | `403` | `AccessDenied` | `Invalid according to Policy: Extra input fields: X-Amz-Meta-Foo` |
| after `expiresIn` | `403` | `AccessDenied` | `Invalid according to Policy: Policy expired` |

`maxSize` is inclusive: exactly `maxSize` bytes is stored. The type is
compared **exactly** — `IMAGE/PNG` is refused for `image/png`, and a charset
parameter makes another type — so post the `Content-Type` field as `fields`
gives it. `put`'s own guard, which compares on the essence, is the lenient
one.

### Where it is signed for

Bun's `S3Client` presigns a GET, a PUT, a HEAD and a DELETE, and has no POST
presigning at all, so this package signs the policy itself: SigV4, HMAC-SHA256
from `node:crypto`. The endpoint, the region and the access key are read off
a URL Bun itself signs, so a presigned POST goes exactly where a presigned PUT
would — Bun signs for region `auto` at an endpoint that is not AWS's, and puts
the bucket in the host with `virtualHostedStyle`. The secret is the one
`bindBucket` was given, or Bun's own environment variables
(`S3_SECRET_ACCESS_KEY`, then `AWS_SECRET_ACCESS_KEY`), and a `sessionToken`
travels as `x-amz-security-token`.

Bun reads those variables **once, when the process starts**, and this package
reads them when the bucket is bound, so a variable changed or deleted in
between would leave the two with different secrets. Before signing, then,
`presignPost` recomputes the signature Bun put on its throwaway URL with its
own secret, and refuses with a `TypeError` when they differ — a form the
service would refuse is never handed out. Passing `secretAccessKey` to
`bindBucket` keeps the environment out of it.

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

`presignPost` reads only the options it knows, so the same bag is harmless
there too: `form.url` is still the bound bucket's.

## A real one: upload from the browser, read it back

```ts
import { Hono } from 'hono';
import { bindBucket, defineBucket, S3Error } from '@nxgt/s3';

const avatars = defineBucket({
	bucket: 'avatars',
	key: (p: { userId: string }) => `${p.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 2 * 1024 * 1024,
});

const store = bindBucket(avatars);
const app = new Hono();

// The browser posts the file straight to the service: no body through here,
// and the service refuses anything over 2 MiB or of another type.
app.post('/users/:id/avatar/upload-form', async (c) => {
	const userId = c.req.param('id');
	const { type } = await c.req.json<{ type: string }>();
	try {
		return c.json(store.presignPost({ userId }, { type, expiresIn: 120 }));
	} catch (error) {
		// A type off the request body the bucket does not accept.
		if (error instanceof S3Error) return c.json({ error: error.code }, 400);
		throw error;
	}
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

The upload route authorises the *user*; the form it hands back authorises
nothing else. `type` comes off the request body, so a type the bucket does not
accept is an `S3Error` with `code: 'WRONG_TYPE'` — answer it with a 400. Keep
`expiresIn` close to how long an upload should take.

## Next

- [Writing](writes.md) — the guards a presigned PUT bypasses, and a POST
  hands to the service.
- [Reading](reads.md) — `stat` and `exists`, for checking what was uploaded.
- [Troubleshooting](../troubleshooting.md) — a URL that 403s or expired.
