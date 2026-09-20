# Reading

Getting an object back — its bytes, its text, whether it is there, what the
service knows about it — and walking a bucket page by page.

## The smallest thing that works

```ts
import { bindBucket, defineBucket } from '@nxgt/s3';

const reports = defineBucket({
	bucket: 'reports',
	key: (id: string) => `${id}.csv`,
	contentType: 'text/csv',
});

const store = bindBucket(reports);

const csv = await store.text('q1'); // string, or undefined
if (csv === undefined) throw new Error('no such report'); // nothing stored
```

Describing and binding a bucket is [Buckets](buckets.md).

## The signatures

```ts
import type { S3File, S3Stats } from 'bun';

bytes(params: P): Promise<Uint8Array | undefined>;
text(params: P): Promise<string | undefined>;
stat(params: P): Promise<S3Stats | undefined>;
exists(params: P): Promise<boolean>;
file(params: P): S3File;

list(options?: {
	prefix?: string;
	limit?: number;
	cursor?: string | null;
}): Promise<ObjectPage>;

interface ObjectPage {
	items: StoredObject[];
	nextCursor: string | null;
}

interface StoredObject {
	key: string;
	size: number | undefined;
	lastModified: Date | undefined;
	eTag: string | undefined;
}
```

## `undefined` means "no such object", and nothing else

```ts
await store.bytes('nobody'); // undefined
await store.text('nobody');  // undefined
await store.stat('nobody');  // undefined
await store.exists('nobody'); // false
```

Each read goes straight at the object and turns S3's own `NoSuchKey` into
`undefined`: one round trip, and no window in which an object deleted between
a check and a read turns a promised `undefined` into a throw. **Every other
failure comes back as the error it is** — a wrong secret, a refused request,
a service that is down. A missing object and a missing permission must not
read the same way.

```ts
const wrong = bindBucket(reports, { secretAccessKey: 'wrong-secret' });
await wrong.text('q1'); // throws Bun's own S3Error, not undefined
```

## What the service knows

```ts
const found = await store.stat('q1');
if (found) {
	found.size;         // bytes
	found.type;         // 'text/csv'
	found.lastModified;
	found.etag;         // note: lower case — that is Bun's field
}
```

`stat` is Bun's own `S3Stats`, which this package does not re-export; import
it from `bun` where you need to name it. A listing's `StoredObject` says
`eTag`, because that is what S3 calls it there.

## Big bodies, and everything else

```ts
const stream = store.file('q1').stream();
const head = await store.file('q1').slice(0, 1024).text();
```

`file(params)` is Bun's lazy `S3File`, keyed by the definition. Use it to
stream a body rather than hold it in memory, and to reach anything this
package does not wrap.

## Listing a bucket

```ts
let cursor: string | null = null;

do {
	const page = await store.list({ prefix: 'q1/', limit: 100, cursor });
	for (const object of page.items) console.log(object.key, object.size);
	cursor = page.nextCursor;
} while (cursor !== null);
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `prefix` | `string` | the whole bucket | only keys that start with it |
| `limit` | `number` | the service's | the **maximum** number of objects in a page, not a promise |
| `cursor` | `string \| null` | `null` | the `nextCursor` of the previous page |

`ObjectPage` is the same shape as the `CursorPage` of `@nxgt/drizzle` and
`@nxgt/mongo`, so a caller pages the same way everywhere. S3's
`continuationToken` is what `nextCursor` carries, and it is `null` on the
last page.

Page **until `nextCursor` is `null`**, never until a page is short: a listing
is eventually consistent on some services, and a page may come back with
fewer items than `limit` while there is still more to read. A prefix with
nothing under it gives an empty page rather than nothing:

```ts
await store.list({ prefix: 'nothing-here/' }); // { items: [], nextCursor: null }
```

`list` is the bucket's, not an object's, so it takes no key parameters — and
it does not count: S3 does not say how many objects there are, so there is no
`total` and no page number.

## A real one: a download route

```ts
import { Hono } from 'hono';
import { bindBucket, defineBucket } from '@nxgt/s3';

const reports = defineBucket({
	bucket: 'reports',
	key: (id: string) => `${id}.csv`,
	contentType: 'text/csv',
});

const store = bindBucket(reports);
const app = new Hono();

app.get('/reports/:id', async (c) => {
	const id = c.req.param('id');
	const found = await store.stat(id);
	if (!found) return c.json({ error: 'No such report' }, 404);

	return new Response(store.file(id).stream(), {
		headers: {
			'content-type': found.type,
			'content-length': String(found.size),
			'content-disposition': `attachment; filename="${id}.csv"`,
		},
	});
});

app.get('/reports', async (c) => {
	const page = await store.list({
		limit: 50,
		cursor: c.req.query('cursor') ?? null,
	});
	return c.json(page);
});
```

`stat` is a HEAD, so this costs one round trip before the body is streamed —
and it is what turns a missing object into a 404 rather than a broken stream.

## Next

- [Writing](writes.md) — `put`, its options and the guards.
- [Presigned URLs](presigned-urls.md) — handing the download to the client
  instead of streaming it through your server.
- [Troubleshooting](../troubleshooting.md) — a read that threw instead of
  answering `undefined`.
