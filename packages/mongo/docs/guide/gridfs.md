# Files (GridFS)

`@nxgt/mongo/gridfs` stores files in MongoDB itself, with the shape the rest
of this package has: a bucket is described once, its metadata is a schema,
what comes back is typed — and every call takes a session, which the driver's
own `GridFSBucket` cannot.

```ts
import { objectId } from '@nxgt/mongo';
import { defineBucket, getFiles } from '@nxgt/mongo/gridfs';
import { z } from 'zod';

export const avatars = defineBucket({
	name: 'avatars',
	metadata: z.object({ userId: objectId(), width: z.int().optional() }),
});

const files = getFiles(db, avatars);

const saved = await files.put(Bun.file('ada.png'), {
	metadata: { userId: '68ca1f0f2b1c4d5e6f7a8b90' },   // read as an ObjectId
});
saved.id;       // '6aae…', 24 hex characters
saved.type;     // 'image/png', from the file itself
saved.size;     // in bytes
saved.sha256;   // the digest of the bytes
```

## Describing a bucket

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `name` | `string` | — | the bucket's name: `<name>.files` and `<name>.chunks`. Non-empty, no `.`, no `$` — each a `TypeError` where the bucket is defined |
| `metadata` | `z.ZodObject` | — | this bucket's metadata. It may not declare `contentType` or `sha256` |
| `chunkSize` | `number` | `261_120` (255 KiB) | bytes per chunk; a whole number of at least 1 |

GridFS stores no content type — the field was dropped in the
specification's first revision, and the driver drops the option with it — so
this package keeps the type and the digest in `metadata.contentType` and
`metadata.sha256`. That is why a schema may not claim those two names, and
why writing either through `put({ metadata })` is a `TypeError`. Pass the
type as `type`, and let the digest be taken.

## Binding it

| Option of `getFiles` | Type | Default | Effect |
| --- | --- | --- | --- |
| `validate` | `'parse' \| 'off'` | `'parse'` | checks the metadata against the schema; `'off'` sends it as given |
| `coerce` | `boolean` | `true` | reads the strings that arrive from outside as ids and dates |
| `hash` | `boolean` | `true` | hashes every upload and stores the digest. With it off there is no `ETag`, so no `304`, and `putOnce` is a `TypeError` |
| `autoSync` | `boolean` | `false` | creates the bucket's indexes before the first call that needs them |
| `session` | `ClientSession` | — | the session every call runs in; `withSession` is the same thing, later |

## Writing

**A write takes what Bun gives it**: `Bun.file(path)`, a `Blob`, a `File`, a
`Response`, a `ReadableStream`, an `ArrayBuffer`, a typed array, a string, or
anything async-iterable over bytes.

```ts
await files.put(await request.blob(), { filename: 'ada.png' });
await files.put(new Uint8Array([1, 2, 3]), { type: 'application/octet-stream' });
await files.put('hello', { filename: 'hello.txt', type: 'text/plain' });
```

| Option of `put` | Type | Default | Effect |
| --- | --- | --- | --- |
| `filename` | `string` | the source's own, else `''` | the name to store |
| `type` | `string` | the one the source carries | the content type |
| `metadata` | `MetadataAsGiven<Def>` | — | this file's metadata, as the schema describes it |
| `id` | `ObjectId \| string` | generated | the `_id` to give it. `ConflictError` when the bucket already has that file, `InvalidIdError` when it is no id |
| `chunkSize` | `number` | the bucket's | overrides it for this file alone |

The content type and the filename come from the source when it knows them —
`Bun.file('a/b/ada.png')` gives `image/png` and `ada.png`, never the path —
and `type` and `filename` override both.

The chunks go first and the `files` document last, which is the order the
GridFS specification asks for: a reader that arrives in between finds no file
at all, rather than a file whose bytes are still arriving.

## Reading

**A read has read nothing.** `get` answers a handle built from the one
`files` document it cost: the size, the type, the digest and the metadata are
there before a single byte is fetched.

```ts
const file = await files.get(id);   // NotFoundError if it is not there

file.id;          // 24 hex characters; `file._id` is the ObjectId
file.filename;
file.size;        // `file.length` is the same number, GridFS's own name for it
file.type;        // undefined when the source carried none
file.sha256;      // undefined on a bucket bound with `hash: false`
file.uploadDate;
file.chunkSize;
file.metadata;    // typed by the bucket's schema
file.stored;      // the `files` document itself, for whatever this does not cover

await file.text();
await file.bytes({ start: 0, end: 1024 });   // end exclusive, as everywhere here
await file.json<{ rows: number[] }>();
file.stream();                               // a web ReadableStream
await file.blob();                           // carrying the stored type
file.response({ download: true });           // a whole HTTP answer
```

An id that could not name a file — anything that is not 24 hex characters —
finds nothing rather than throwing, exactly as on a collection: `find`
answers `undefined`, `exists` answers `false`, and `get`, `delete` and
`rename` raise `NotFoundError`. A junk path parameter is a `404`, never a
`500`.

The rest: `find`, `exists`, `delete`, `rename`, and `drop`, which removes
both of the bucket's collections — a bucket that was never written to is not
an error, anything the server refuses is.

## Serving one

```ts
app.get('/files/:id', (c) => files.serve(c.req.raw, c.req.param('id')));

app.get('/files/:id/download', async (c) =>
	(await files.get(c.req.param('id'))).response({ download: true }),
);

app.get('/avatars/:id', (c) =>
	files.serve(c.req.raw, c.req.param('id'), {
		headers: { 'cache-control': 'public, max-age=31536000, immutable' },
	}),
);
```

`serve` answers the whole file, the range the request asked for, `304` when
the caller already has the bytes, `416` when the range cannot be met, and
`404` when there is no such file.

| Option of `serve` and `response` | Type | Default | Effect |
| --- | --- | --- | --- |
| `download` | `boolean \| string` | `false` | `Content-Disposition`: `true` uses the stored filename, a string uses that name |
| `headers` | `HeadersInit` | — | added to **every** answer — the `304`, the `416` and the `404` too — and never allowed to overwrite the body's own |
| `status` | `number` | `200` | honoured on the answers that carry bytes; the other three have a status of their own |
| `range` | `{ start?, end? }` | — | `response` only: `end` exclusive |

A `206` reads only the chunks the range spans. The conditional request is
`If-None-Match` only — `If-Modified-Since` is not read — and a bucket bound
`hash: false` stores no digest, so it has no `ETag` and can never answer
`304`.

For a handler that serves bytes itself, `parseRange` is the header reader:

```ts
import { parseRange } from '@nxgt/mongo/gridfs';

const range = parseRange(request.headers.get('range'), file.size);
// { start, end } with `end` exclusive — or undefined
```

Only a single range is honoured; a request for several is answered with the
whole file, which is what the specification allows when a server will not
satisfy the range.

## Listing

The package's own cursor pagination, ordered on `uploadDate` **and** `_id`
together so that two files uploaded in the same millisecond cannot hide each
other.

```ts
const page = await files.paginate({
	filter: { 'metadata.userId': userId },   // strings read as ids here too
	order: 'oldest',   // 'newest' by default
	limit: 20,         // 20 by default; below 1 is a RangeError
	after: cursor,     // page.nextCursor from the page before
});
page.items;        // FileHandle[]
page.nextCursor;   // null on the last page
```

A cursor written for one order is refused by the other, with
`InvalidCursorError`. See [Pagination](pagination.md) for the same shape on a
collection.

## It runs in a transaction

`files.withSession(session)` scopes every read and every write, `put`
included — which the driver's own `GridFSBucket` cannot do, because nothing
in its API takes a session. That is why this package writes the chunks
itself.

```ts
import { withTransaction } from '@nxgt/mongo';

await withTransaction(client, async (session) => {
	const file = await files.withSession(session).put(body);
	await users.withSession(session).update(userId, { avatarId: file._id });
});
```

`files.raw` is still the driver's bucket, and still takes no session: it is
an escape hatch, not a transactional one.

## Create the indexes

Nothing creates a bucket's indexes on its own, except `putOnce`. The driver
builds two of them on its first upload, and this package does not upload
through the driver — see the session above — so that safety net went with it.

```ts
await files.syncIndexes();   // at start-up — or, before the first call:
const avatarFiles = getFiles(db, avatars, { autoSync: true });
```

This is not an optimisation: until `syncIndexes` has run, **every read scans
the whole chunks collection**, and what it examines grows with the size of
the bucket rather than of the file. It creates four — the pagination order,
the digest `putOnce` looks up by, GridFS's own `filename_1_uploadDate_1`, and
the unique `{ files_id, n }` that stops two writers landing two chunk 3s
under one file.

`syncIndexes` runs in the bucket's session like everything else, which means
mongod refuses it inside a transaction — so call it at start-up, or use
`autoSync`, which drops the session for exactly that reason, as `putOnce`
does.

The memo of what has been created is kept **per database**, and survives a
dropped database. `drop()` calls `resetBucketSync` for the whole database;
call it yourself when an index goes from outside this process:

```ts
import { resetBucketSync } from '@nxgt/mongo/gridfs';

resetBucketSync(db);   // or resetBucketSync() for every database
```

## Storing the same bytes once

```ts
const { file, stored } = await files.putOnce(Bun.file('ada.png'));
stored;            // false when the bucket already had these very bytes
String(file._id);  // when this call stored it: twelve bytes of its sha256
```

A `Blob` — `Bun.file` included — can be streamed twice, so its digest is
taken first and nothing is uploaded when the bucket already has those bytes.
Anything else is read once by definition, so it is written and then compared.
A copy that `put` wrote is found and given back too — under **its** id, not
the one the digest decides.

`putOnce` takes no `id` of its own: passing one does not compile, and an
options bag that never met the types is a `TypeError`.

```ts
// @ts-expect-error the bytes decide the id
await files.putOnce(source, { id: someId });
```

### Why the bytes decide the id

Neither of those checks is what makes two callers storing the same bytes **at
the same time** safe: a check cannot see a file whose `files` document has not
been written yet. What settles it is that the bytes decide the id — twelve
bytes of the sha256, which is what an `ObjectId` holds — so the two copies
collide **on the server**, on the unique `{ files_id, n }` index and then on
`_id`, which is unique in every collection there is.

The caller that loses the collision has written nothing that survives,
removes only the chunks it wrote itself, and is given the copy that won:
**`putOnce` never deletes a file that is stored**, its own included.

A rule each caller works out on its own cannot do this. Before 0.15.0 the
winner was the copy first in `(uploadDate, _id)` — a key that says nothing
about the order the documents become visible — so the call that finished last
could be the one every other call was waiting to see, and two copies survived
under two different ids.

What follows from that:

- **The date in one of these ids is not a date.** An `ObjectId` normally
  opens with a timestamp; here those bytes are digest. `uploadDate` is the
  date.
- **`putOnce` creates the bucket's indexes** once per process if they are not
  there, whatever `autoSync` says, because the unique `{ files_id, n }` index
  is half of the election. They are created outside the bucket's session — so
  `putOnce` may be a bucket's first call inside a transaction, where
  `syncIndexes` may not, and the indexes survive a rollback the write does
  not.
- **The caller that loses waits** for the winner's `files` document, which is
  one round trip away: the call that took the id has already written every
  byte. The wait is bounded at ten seconds.
- **If the claim is let go instead**, the waiting call asks once more whether
  those bytes have turned up in the meantime — a plain `put` takes no part in
  the election — and then **takes the id over** rather than waiting the rest
  out: it is holding every byte the id needs. It takes over once.
- **Inside a transaction, a collision is the transaction's to lose.**
  Measured: the duplicate key aborts it on the server, so what comes back is
  the driver's abort and not this package's `ConflictError`. There is nothing
  to wait for in one either — another transaction's document is not in this
  one's snapshot.
- **Files stored by an earlier release keep their own ids.** They are still
  found by digest and given back, so nothing needs moving.

### What `putOnce` refuses

Four `ConflictError`s, each about an id that cannot be taken:

| Message begins | What happened | What to do |
| --- | --- | --- |
| `another write holds _id … and has not finished` | a write claimed the id and died before its `files` document; its chunks are still there after ten seconds | retry, or sweep the chunks (below) |
| `was claimed and let go again while this write was taking it over` | the id slipped twice under one call | retry |
| `holds chunks under _id … that no file claims` | an interrupted write left chunk 0 free and a later one taken, where this file's own would go | retry, or sweep |
| `already has a different file under _id …, whose digest begins the same way` | a stored file under that id whose digest is not the one asked for | store these bytes with `put` |

A chunk sitting **past** this file's last chunk collides with nothing, so it
is left where it is and goes when the file is deleted. A file stored short is
never the answer: the third case refuses rather than store one.

## A file is found whole, and only reading it says otherwise

Nothing in MongoDB ties the `files` document to its chunks, so a chunk
removed by hand or an interrupted write from another client leaves a file
whose `length` promises bytes that are not there. `get` still answers, and
`size` is whatever the document claims; the failure comes when the bytes are
read. A chunk that is absent raises `CorruptFileError` naming its number, and
one that is present but **short** — which leaves no gap to notice — raises it
naming the file and both counts. Neither ever reads quietly short.

### Sweeping chunks with no file

`delete` works from a `files` document, so chunks an interrupted write left
behind have to be removed from the chunks collection directly. That is a
maintenance pass over a bucket nothing is writing, **not** a `catch`:

```ts
import type { ObjectId } from 'mongodb';

// GridFS allows any `_id`; widen this if the bucket holds another kind.
type FilesId = ObjectId | string | number;
const collections = files.definition.collections;
const stored = db.collection<{ _id: FilesId }>(collections.files);
const chunks = db.collection<{ files_id: FilesId }>(collections.chunks);

// A cursor, not `distinct`: a bucket big enough to accumulate leftovers is
// big enough for `distinct`'s 16 MB cap — measured, it fails outright at
// 900 000 ids rather than doing less.
for await (const { _id } of chunks.aggregate<{ _id: FilesId }>([
	{ $group: { _id: '$files_id' } },
])) {
	// The files collection, not `files.exists`: that one answers `false` for
	// an id it cannot read as an `ObjectId`, which is right for a route and
	// fatal here — another client's file, stored under an id of its own,
	// would have its bytes swept out from under it.
	if (await stored.findOne({ _id }, { projection: { _id: 1 } })) continue;
	await chunks.deleteMany({ files_id: _id });
}
```

It assumes nothing is writing to the bucket while it runs, and the same check
inside a `catch` would be a guess: by the time anything acted on a
`ConflictError` naming an id, a writer that was only slow can have landed its
document — and one of the four errors above is raised **because** a file
holds that id. `files.delete(id)` is the only thing that should ever take a
stored file's chunks.

## An upload endpoint, end to end

```ts
import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { getFiles } from '@nxgt/mongo/gridfs';
import { avatars } from './buckets';

const app = new Hono<{
	Bindings: { db: Db };
	Variables: { userId: string };
}>();

app.post('/avatars', async (c) => {
	const form = await c.req.formData();
	const upload = form.get('file');
	if (!(upload instanceof File)) return c.json({ error: 'no file' }, 400);

	const files = getFiles(c.env.db, avatars);
	const { file, stored } = await files.putOnce(upload, {
		metadata: { userId: c.get('userId') },
	});
	return c.json({ id: file.id, size: file.size, stored }, stored ? 201 : 200);
});

app.get('/avatars/:id', (c) =>
	getFiles(c.env.db, avatars).serve(c.req.raw, c.req.param('id'), {
		headers: { 'cache-control': 'public, max-age=86400' },
	}),
);
```

## The signatures

```ts
function defineBucket<M extends z.ZodObject | undefined>(
	config: BucketConfig<M>,
): BucketDefinition<M>;

function getFiles<Def extends BucketDefinition>(
	db: Db,
	definition: Def,
	options?: BucketOptions,
): TypedBucket<Def>;

interface TypedBucket<Def> {
	readonly name: string;
	readonly definition: Def;
	/** The driver's own bucket, for whatever this does not cover. */
	readonly raw: GridFSBucket;
	readonly session: ClientSession | undefined;

	put(source: FileSource, options?: TypedPutOptions<Def>): Promise<FileHandle<Def>>;
	putOnce(
		source: FileSource,
		options?: PutOnceOptions<Def>,
	): Promise<{ file: FileHandle<Def>; stored: boolean }>;

	get(id: FileId): Promise<FileHandle<Def>>;
	find(id: FileId): Promise<FileHandle<Def> | undefined>;
	exists(id: FileId): Promise<boolean>;
	delete(id: FileId): Promise<void>;
	rename(id: FileId, filename: string): Promise<void>;

	paginate(options?: FilePageOptions): Promise<CursorPage<FileHandle<Def>>>;
	/** `ResponseInit` here is this package's, exported as `FileResponseInit`. */
	serve(request: Request, id: FileId, init?: ResponseInit): Promise<Response>;

	syncIndexes(): Promise<BucketIndexReport[]>;
	drop(): Promise<void>;
	withSession(session: ClientSession | undefined): TypedBucket<Def>;
}

/** The same as `TypedPutOptions`, without `id`. */
type PutOnceOptions<Def> = Omit<TypedPutOptions<Def>, 'id'>;

type FileId = ObjectId | string;
```

## Next

- [Errors](errors.md) — `ConflictError`, `CorruptFileError` and the rest.
- [Transactions](transactions.md) — the session a bucket takes.
