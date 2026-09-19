---
'@nxgt/mongo': minor
---

`@nxgt/mongo/gridfs`: files in MongoDB, with the shape the rest of the package
has — a bucket described once, metadata that is a schema, and a handle that is
typed.

```ts
import { defineBucket, getFiles } from '@nxgt/mongo/gridfs';

export const avatars = defineBucket({
	name: 'avatars',
	metadata: z.object({ userId: objectId(), width: z.int().optional() }),
});

const files = getFiles(db, avatars);
const saved = await files.put(Bun.file('ada.png'), {
	metadata: { userId: '68ca1f0f2b1c4d5e6f7a8b90' },
});
app.get('/files/:id', (c) => files.serve(c.req.raw, c.req.param('id')));
```

A write takes what Bun gives it — `Bun.file`, a `Blob`, a `File`, a
`Response`, a `ReadableStream`, bytes, a string, anything async-iterable — and
reads the type and the filename off the source when it knows them. A read is
a handle that has read nothing: the size, the type, the digest and the
metadata come from the one `files` document that finding it cost, and
`stream`, `bytes`, `text`, `blob` and `response` are what fetch.

`serve(request, id)` answers the whole file, the range the request asked for
as a `206`, `304` when the caller already has the bytes, `416` when the range
cannot be met, and `404` when there is no such file — with `Content-Type`,
`Content-Length`, `Accept-Ranges`, `Last-Modified`, an `ETag` built from the
digest and a `Content-Disposition` that carries a non-ASCII filename intact.
`putOnce` stores the same bytes once. `paginate` is this package's cursor
pagination, ordered on `uploadDate` **and** `_id`, filtering on the metadata
with the same string coercion as everywhere else.

It runs in a transaction, which the driver's own GridFS cannot: measured on
mongodb 7.6.0, **no** GridFS call takes a session — not the upload, not the
download, not `delete`, not `rename` — so a write through `GridFSBucket`
leaves the transaction it was asked to run in without a word. This package
writes and reads the chunk documents itself.

Also new: `CorruptFileError`, raised while reading a file whose chunks are
not all there, naming the chunk that is missing.
