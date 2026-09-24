# @nxgt/mongo

## 0.18.1

### Patch Changes

- [#129](https://github.com/softistx/nxgt-data/pull/129) [`2607662`](https://github.com/softistx/nxgt-data/commit/2607662b5044bae56de5e65c225c08138d1f966e) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Say where `serverCodeName` comes from. A write error — one document refused inside the server's insert, update or delete command — carries no `codeName`, so `updateMany` gives `serverCode: 121` with no name where `update` (a `findAndModify`) gives `DocumentValidationFailure`. Match on `serverCode`.

- [#131](https://github.com/softistx/nxgt-data/pull/131) [`1fec6f1`](https://github.com/softistx/nxgt-data/commit/1fec6f19a24701217cda2ae6d6426259c3588037) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Say that without post-images an update read after its document was hard deleted arrives with `document: undefined`: the document is looked up when the change is read, and a subscription only a little behind is enough.

## 0.18.0

### Minor Changes

- [#127](https://github.com/softistx/nxgt-data/pull/127) [`3bf3ff2`](https://github.com/softistx/nxgt-data/commit/3bf3ff2e456676230d16299b2bd64d94a06239ac) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `update`, `updateMany` and `upsert` in `@nxgt/mongo` no longer send a patch that names `_id`. A patch that gives `_id` as a field, through any operator (`$set`, `$setOnInsert`, `$unset`, `$rename` onto it or away from it, `$currentDate`, `$min`, `$max`…), under a path such as `_id.x`, or even as `undefined` or through a cast, is refused before anything is sent and before any hook runs, with a bare `TypeError`: `update on "users": "_id" is immutable, and an update never writes it. Leave it out; a document that needs another _id is a new document`. `updateMany on …` is the same refusal, and `upsert on "users": "_id" is immutable, and an upsert never writes it. Name it in the filter, which is what an inserted document is seeded from` is the one for an upsert's values, where the `_id` an insert gets now goes in the filter. What a `before` hook returns is checked again. The message names the call and the collection, never the value.
  
  **A behaviour change, so a minor.** A new `_id` used to reach the server and come back as a plain `DataError` with `serverCode: 66` (`ImmutableField`) — on an upsert, in a message that quoted the value; the same `_id` went through as no change, and an `_id` in an upsert's values chose the id of an insert. Each of these throws now. `FixedOnUpdate` includes `'_id'`, so `Patch`, `ManyPatch`, `UpsertOf`, `WritableDocumentOf`, `WritableFieldOf`, `WritablePath` and `RemovablePath` leave it out: `update(id, { _id })`, `update(id, { $set: { _id } })` (`$set: { _id: undefined }` included) and `upsert(filter, { _id })` no longer compile, and neither does a whole document, as the schema types it, handed to `update` on a collection with no stamps. **One gap:** a top-level `_id: undefined` — `update(id, { _id: undefined, name })`, `upsert(filter, { _id: undefined, rank })`, or the idiom `update(id, { ...body, _id: undefined })` — still compiles, because `_id?: never` accepts `undefined` unless the consumer turns on `exactOptionalPropertyTypes`; it is refused at run time only. What newly breaks at run time is a whole document spread back into an update — `update(id, { ...doc, title })` where `doc` came from a `raw` or driver read, a client body with `id` taken off, or a collection whose schema declares its own `id`; a spread of this package's own `getById` result already threw in 0.17, on `id`. Take `_id` out of the patch.
  
  **Moving `_id` into an upsert's filter is not the same call.** The filter is also the match: `upsert({ title: 'a', _id: chosen }, …)` matches that title **and** that id, so where 0.17's `upsert({ title: 'a' }, { _id: chosen, … })` matched on the title alone, it now inserts a second document or fails with `ConflictError` on a unique index. An upsert keyed on a business field that also picks the id of its insert has no exact equivalent: derive `_id` from the key, or read first and `create` or `update`.
  
  The driver's own methods are untouched: `updateOne`, `findOneAndUpdate`, `replaceOne`, `bulkWrite` and `raw` check nothing, and the server refuses a changed `_id` there as before.
  
  `@nxgt/drizzle`: documentation only. The table in `docs/guide/stamps.md` of what differs from `@nxgt/mongo` now says that `_id` is refused there too, and lists the two differences that remain — a key given as `undefined`, and a key in an upsert's values. No code changed.

## 0.17.1

### Patch Changes

- [#105](https://github.com/softistx/nxgt-data/pull/105) [`528be97`](https://github.com/softistx/nxgt-data/commit/528be97359691b5bfe8f0ad08f09e0fc525e9115) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `put` and `putOnce` in `@nxgt/mongo/gridfs` refuse a source that has nothing left to give, rather than storing it as an empty file. A `ReadableStream` that was read — to the end or in part — or that someone holds a reader on, a `Response` whose body was read or is held that way, a node `Readable` that was read, ended or destroyed, and a generator these calls read before are now a `TypeError` naming the call and the bucket (`put on "avatars": this stream was already read, or is held by another reader, so it has nothing left to store. …`), thrown on the first read, before any chunk is written. The case that mattered is a transaction the driver retries — a bucket's first upload with `autoSync` fails its commit with 112 and is one: the second run read the spent stream as empty and stored a file of 0 bytes, with no error, beside whatever the callback committed. It now fails the transaction, which commits nothing. A put refused before it reads — an `_id` already taken — leaves the stream to the next call. `@nxgt/mongo-kit`'s docs on the `autoSync` retry say the stream is refused now, and a spec pins it through the kit.
  
  Two messages changed with it. A `Response` whose body was already read gets the refusal above instead of `put: this Response has no body…`, which now only answers a response that never had a body and reads `put on "avatars": this Response has no body, so it has nothing to store.` A source of no readable shape reads `put on "avatars": expected a file, a blob, a response, a stream or bytes, not a number` — the call, the bucket and the kind or class of what was given, where it used to print the value itself. Not detected, and documented as such: an iterable that hands out a new iterator over a one-shot resource, and a generator the caller drained before `put`.

- [#101](https://github.com/softistx/nxgt-data/pull/101) [`77e7140`](https://github.com/softistx/nxgt-data/commit/77e7140570a540ba3ed66edb0d9cc98b4a23ccfc) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The roadmap records an audit journal as not planned. `actors` stamps and an `after` hook, which sees each write with its actor and its session, already let an application keep its own journal in the same transaction.

## 0.17.0

### Minor Changes

- [#70](https://github.com/softistx/nxgt-data/pull/70) [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A bucket with no chunk index says so, once, instead of being quietly slow.
  
  Nothing creates a bucket's indexes on its own: `GridFSBucket` takes no
  session, so this package writes chunks itself, and the driver's habit of
  creating `files_id_1_n_1` on the first upload went with it. Until
  `syncIndexes()` has run, reading one file's bytes examines every chunk
  document of the bucket — the cost grows with the bucket rather than with the
  file, the read still works, and nothing said a word.
  
  The first read of such a bucket now emits one `process` warning:
  
  ```
  (node:1) [NxgtGridFSMissingIndex] Warning: Bucket "avatars" has no
  files_id_1_n_1 on "avatars.chunks": every read scans the whole collection, and
  the cost grows with the bucket rather than with the file. Call syncIndexes()
  at start-up, or bind with autoSync.
  ```
  
  ```ts
  process.on('warning', (warning) => {
  	if ((warning as { code?: string }).code === 'NxgtGridFSMissingIndex') {
  		log.warn(warning.message);
  	}
  });
  ```
  
  `process.emitWarning` rather than a logger or a `console.warn`: it is the one
  channel every application already has, and it can be listened to or silenced
  without this package taking an opinion on logging. It is emitted once per
  database and bucket for the life of the process, costs one `indexes()` round
  trip, never throws, and never delays the read — the probe runs beside it. A
  bucket bound with `autoSync`, or an application that calls `syncIndexes()` at
  start-up, never sees it.

- [#70](https://github.com/softistx/nxgt-data/pull/70) [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every refusal that had a sentence and nothing else now names what failed.
  
  **A pagination number says which call refused it.** A collection's `paginate`
  and `paginateByCursor` and a bucket's `paginate` all take a `page`, a
  `pageSize` or a `limit`, and all three used to refuse one with `limit must be
  an integer of at least 1, not 0` — the same sentence, so a log line said which
  listing produced it never.
  
  ```ts
  await files.paginate({ limit: 0 });
  // RangeError: paginate on "uploads": limit must be an integer of at
  //             least 1, not 0
  ```
  
  The bucket's own check was a second copy of the collection's; it is now the
  same one. It takes no maximum, because a bucket has no `maxPageSize` and
  giving it one here would cap a listing that is uncapped today.
  
  **A cursor says which listing rejected it, and along which columns.**
  
  ```ts
  await posts.paginateByCursor({ after: cursorFromAnotherPage });
  // InvalidCursorError: Invalid cursor in paginateByCursor on "posts": it
  //                     holds 2 value(s) where the ordering _id:asc needs 1 (_id)
  ```
  
  **And it wears the cursor class.** That one refusal was a bare `DataError`
  with `code: 'DATABASE'`, while the three beside it were `InvalidCursorError`
  with `INVALID_CURSOR` — so a handler mapping codes to statuses answered 500
  to the one cursor failure a client can cause by pasting the wrong page's
  link. It is an `InvalidCursorError` now, and one `catch` takes all four.
  
  The lead stays where it was, because `Invalid cursor` is the part a consumer
  searches for. `decodeCursor` takes an optional third argument for the same
  reason; `pageWindow` and `cursorLimit` take an optional trailing one. All are
  optional, so no existing call changes.
  
  **A GridFS chunk that holds no bytes names the chunk, the file and the
  bucket**, the way a missing chunk and a truncated one already did:
  
  ```
  Chunk 4 of file 6721… in "uploads" holds a string where its bytes should be:
  the chunk was written by something that is not GridFS, or its `data` was
  overwritten
  ```
  
  It reports the *shape* of what was stored, never its value.
  
  **An upsert the server answers with no document is a `DataError`, not a
  `TypeError`.** MongoDB does not do that, and the message now says so and says
  where to report it. It mattered because every other refusal of the same call
  *is* a `TypeError` written by this package and *is* the caller's mistake:
  wearing the same class and the same `upsert: "users"` prefix left no way to
  tell the caller's mistake from the one thing that should never happen.

## 0.16.0

### Minor Changes

- [#68](https://github.com/softistx/nxgt-data/pull/68) [`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A connect that a close interrupts is a `ConnectionError`, not a bare `Error`.
  
  ```ts
  import { ConnectionError } from '@nxgt/mongo';
  
  try {
  	await connectMongo(uri);
  } catch (error) {
  	if (error instanceof ConnectionError) {
  		// The shared client went away mid-connect: worth trying again.
  	}
  }
  ```
  
  It is a `DataError` like the rest of this package's failures, with
  `code: 'CONNECTION'`, so a handler that already maps `DataError` codes to
  statuses covers it without a second branch. MongoDB's own refusal to connect
  is still the driver's error, unchanged — this is only what *this* package
  decides.
  
  **It carries no URI**, and a spec asserts it: a connection string holds the
  password, and this package prints none.

## 0.15.1

### Patch Changes

- [#66](https://github.com/softistx/nxgt-data/pull/66) [`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every package now ships a `docs/` folder, linked from its npm page.
  
  The README stays the short version: what the package is, how to install it,
  and one copy-paste example per area. `docs/` is the long one — a guide page
  per area with the option tables, the defaults, what is returned and what is
  thrown; a `troubleshooting.md` whose headings are the exact error text you
  would paste into a search box, with the line that prevents each one; and a
  `roadmap.md` saying what is coming, and what is deliberately not.
  
  `docs` is named in each package's `files`, so it travels in the tarball
  rather than living only on GitHub.

## 0.15.0

### Minor Changes

- [#63](https://github.com/softistx/nxgt-data/pull/63) [`b4f07aa`](https://github.com/softistx/nxgt-data/commit/b4f07aa4c497bec08297a0c4bd9cb0ea57ccc682) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `putOnce` stores a file under the id its bytes decide, and two callers can no
  longer both win.
  
  The old rule elected the copy first in `(uploadDate, _id)` — a key that says
  nothing about the order the documents become **visible**. Measured, by holding
  one caller's `files` insert open: the call that finished last carried the
  earliest key, so the calls that finished before it could not see it, each
  found itself first, and the bucket kept two copies under two different ids
  while all three callers were told their bytes were safe. It is what a loaded
  CI machine produced on its own.
  
  The election is now the server's. A file written by `putOnce` is stored under
  the first twelve bytes of its sha256, so two callers storing the same bytes
  collide on the unique `{ files_id, n }` index and then on `_id`. The caller
  that loses has written nothing that survives, takes back only the chunks it
  wrote itself, and is given the copy that won: **`putOnce` never deletes a
  stored file.** A copy `put` wrote is still found and given back.
  
  What changes for a caller:
  
  - The `_id` of a deduplicated file is its content. The timestamp an
    `ObjectId` normally opens with is digest here, and means nothing;
    `uploadDate` is the date.
  - `putOnce` takes no `id`, at the type level and at run time. Use `put` to
    choose one.
  - `putOnce` creates the bucket's indexes once per process if they are not
    there, whatever `autoSync` says: the unique `{ files_id, n }` index is half
    of the election.
  - A file stored under that id whose digest is not the one asked for is a
    `ConflictError` rather than the wrong bytes.
  - The caller that loses waits for the winner's document, which is one round
    trip away. The wait is bounded at ten seconds, and what it runs out on is a
    write that claimed the id and never finished: a `ConflictError` naming it.
  - Inside a transaction a collision is the transaction's to lose. Measured:
    the duplicate key aborts it on the server, so what comes back is the
    driver's abort rather than this package's `ConflictError`.
  - A chunk an interrupted write left where this file's own would go is a
    `ConflictError` too, rather than a file stored short; one past its last
    chunk collides with nothing and is left alone.
  - A claim that was let go is taken over rather than waited out, after asking
    once more whether those bytes have turned up meanwhile. An id claimed and
    let go twice under one call is a `ConflictError` asking for a retry.
  - Files stored by 0.14.0's `putOnce` keep their own ids. They are still found
    by digest and given back, so nothing needs moving.

## 0.14.0

### Minor Changes

- [#60](https://github.com/softistx/nxgt-data/pull/60) [`a6cac9b`](https://github.com/softistx/nxgt-data/commit/a6cac9bf5f22c44c9b6e1b211ae8946e4658cad3) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `@nxgt/mongo/gridfs`: files in MongoDB, with the shape the rest of the package
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
  `stream`, `bytes`, `text`, `json`, `blob` and `response` are what fetch.
  
  `serve(request, id)` answers the whole file, the range the request asked for
  as a `206`, `304` when the caller already has the bytes, `416` when the range
  cannot be met, and `404` when there is no such file — an id that could not
  name one included, so a junk path parameter is never a `500`. The headers of
  the `init` you pass ride on every answer, the ones with no body included; an
  answer that carries bytes adds `Content-Length`, `Accept-Ranges` and
  `Last-Modified`, plus `Content-Type` when the file carries one, an `ETag` when
  the bucket hashes, and a `Content-Disposition` that carries a non-ASCII
  filename intact when you ask for a download. The conditional request is
  `If-None-Match` only, so a bucket bound `hash: false` has no `ETag` and never
  answers `304`. `putOnce` stores the same bytes once, two callers at once
  included. `paginate` is this package's cursor pagination, ordered on
  `uploadDate` **and** `_id`, filtering on the metadata with the same string
  coercion as everywhere else.
  
  It runs in a transaction, which the driver's own GridFS cannot: measured on
  mongodb 7.6.0, **no** GridFS call takes a session — not the upload, not the
  download, not `delete`, not `rename` — so a write through `GridFSBucket`
  leaves the transaction it was asked to run in without a word. This package
  writes and reads the chunk documents itself.
  
  `syncIndexes()` creates the four indexes a bucket needs, and `autoSync` does
  it before the first call that needs one. Call one or the other: nothing else
  creates them, because the driver built two of them on its first upload and
  this package no longer uploads through the driver.
  
  Also new: `CorruptFileError`, raised while reading a file whose bytes are not
  all there — naming the chunk when one is missing, and the file and both counts
  when one is merely short. A read never comes back quietly truncated.

## 0.13.1

### Patch Changes

- [#58](https://github.com/softistx/nxgt-data/pull/58) [`12baf06`](https://github.com/softistx/nxgt-data/commit/12baf06b46131bceedd596dc5cc09702dc6027d1) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `upsert` no longer writes, on the half that matched, things `update` would
  never write: a field the stored document is **missing** is no longer filled
  from the schema's default, and a document with no `createdBy` is no longer
  credited to whoever happened to upsert it.
  
  Measured on mongod 8.2: the server seeds an inserted document from the filter
  before the pipeline runs, so `$type` of `$_id` is `missing` on an insert whose
  filter did not name `_id`, and `objectId` on the update that follows — and
  because an upsert's filter already refuses the `$and`/`$or` that could hide an
  `_id`, that is a sound signal wherever the filter carries none.
  
  A filter that **does** name `_id` — a collection keyed by a string `_id` has
  to — takes the signal away, and there each field still falls back to its own
  absence. That narrow case is what the Traps now describe; it was the general
  case before.

## 0.13.0

### Minor Changes

- [#56](https://github.com/softistx/nxgt-data/pull/56) [`9117fff`](https://github.com/softistx/nxgt-data/commit/9117fffc1897452d1503c814fc878dbd8082286e) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `upsert(filter, values)`: the live document that matches, changed — or a new
  one — in one round trip, with no read to go stale in between. Two requests
  racing on the same key give one document and not two **when a unique index
  covers that key**; without one, MongoDB may insert twice. The loser of that
  race meets the index and rejects with `ConflictError`; nothing here retries.
  
  ```ts
  const user = await users.upsert({ email: 'ada@example.com' }, { name: 'Ada' });
  ```
  
  An insert lands what `create` would have landed: the schema's defaults,
  `createdAt`, `createdBy` and version 0. An update does what `update` does:
  `updatedAt`, `updatedBy`, and the version raised by one — `createdAt` and
  `createdBy` are never moved. It is sent as **one** aggregation pipeline
  update, which is what makes that branch possible: measured on mongod 8.2,
  `$inc: { version: 1 }` beside `$setOnInsert: { version: 0 }` is refused by the
  server, and `$inc` alone starts an inserted document one ahead of a created
  one.
  
  The filter seeds an insert, which makes it unlike every other filter in this
  package — it is written, not only matched — so it is checked as a write is.
  A condition rather than a value (an operator bag or a regular expression), a
  field the schema does not have, a stamp the collection keeps, `$and`/`$or`
  — the server seeds from inside those too, measured — and a dotted path are
  each a `TypeError` naming the field. `_id` is allowed, and required there
  when the schema fills `_id` with something that is not an `ObjectId` — the
  server generates one before the pipeline runs, so an upsert cannot apply that
  default and asks rather than land a document `create` would not have landed.
  
  An upsert must always be able to insert, so the seeds, the values and the
  schema's defaults are parsed as a whole document before the server is asked:
  a missing required field is the `ZodError` `create` would have raised, and
  not a server `ValidationError` on the day the document happened not to be
  there. The cost is that such a field has to be named on every upsert,
  matching or not.
  
  The values are the document's own fields, each optional, and no operators.
  Which half ran is told to the hooks: `afterCreate` or `afterUpdate` runs
  according to what the server did, and the new `beforeUpsert` is the one hook
  that runs before — until the server answers, which of the two it will be is
  not known.
  
  Also recorded in the Traps, measured while building this: a **filter** does
  not refuse a field the schema has no idea about, here or anywhere else — the
  driver's `Filter<T>` carries `Document`'s index signature. Sorts, projections
  and patches are checked; filters are not.

## 0.12.1

### Patch Changes

- [#54](https://github.com/softistx/nxgt-data/pull/54) [`6f08b69`](https://github.com/softistx/nxgt-data/commit/6f08b6905b7b73d29afbb99cd7e87b7054f3e3c5) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Four things these packages do that their documentation did not say, each one
  measured, and recorded rather than changed.
  
  - **`@nxgt/mongo`: a read is never checked against the schema.** `validate` is
    about writes, so a document written by `raw`, by a migration or before a
    field existed comes back typed as though the field were there. Parse what
    you read when it matters.
  - **`@nxgt/drizzle`: `findById` with a value the column's type refuses throws.**
    On a `uuid` primary key, `findById('nope')` is a `DataError` with
    `code: 'DATABASE'`, not an empty read.
  - **`@nxgt/mongo`: `$setOnInsert` does nothing.** No write this package makes
    is an upsert, so there is no insert for it to apply to.
  - **`@nxgt/mongo-meilisearch`: a reindex holds one id per live document in
    memory** and pages the whole index. It is a deployment step.
  
  `@nxgt/drizzle`'s "`paginate` counts, then reads" was also corrected: the two
  queries run together. Two queries are still not one snapshot.

## 0.12.0

### Minor Changes

- [#51](https://github.com/softistx/nxgt-data/pull/51) [`5012472`](https://github.com/softistx/nxgt-data/commit/5012472fdcbb374961b2d604303c9f732da69114) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A string that arrives from outside is now read from the schema, so a handler
  no longer parses ids or dates before a query.
  
  `getCollection` reads the collection's Zod schema once and converts, in
  filters, in writes, in hooks and in the id argument of `findById`, `getById`,
  `update`, `delete`, `hardDelete` and `restore`: a 24-hex string where the
  schema says `bsonType: 'objectId'` becomes an `ObjectId`, and a date string
  where it says `z.date()` becomes a `Date`. The same happens inside `$eq`,
  `$ne`, the comparisons, `$in`, `$nin`, `$all`, `$each` and `$not`, under
  `$and`/`$or`/`$nor`, at a nested path and in the `$elemMatch` that names it, in
  a patch of fields and in one written in operators, and in `onChange`'s filter.
  
  The types say the same thing: an `ObjectId` field takes `ObjectId | string`
  and a `Date` field takes `Date | string`, everywhere the collection reads one.
  `FilterOf<Def>` and `NewOf<Def>` are exported for typing your own functions
  over them. The hooks are unchanged and still see the stored forms: the reading
  happens before they run.
  
  Nothing is guessed at, because a wrong guess is a query that silently matches
  nothing. An id is 24 hexadecimal characters; a date is `2026-01-01`, or a time
  with a zone on it — `'5'`, `'2026'`, `'2026-02-31'` and `'2026-01-01T00:00'`
  are all things `new Date` reads and none of them means one instant, so all four
  are handed on for the schema to refuse by name. A number is never a date, and a
  field the schema does not declare is passed to the server untouched.
  
  `coerce: false` turns it off for a collection.

## 0.11.0

### Minor Changes

- [#31](https://github.com/softistx/nxgt-data/pull/31) [`62bd44b`](https://github.com/softistx/nxgt-data/commit/62bd44b3012d3db6d5c55474eb7ba47d73c9dd3b) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `onChange`'s subscription gains `position`: where the stream is, changes or not. `resumeToken` is the last change handled and stands still while the collection is quiet; `position` is that token, or, after a read that brought nothing, the point the server gave, and every change up to it has been handled. A worker that records `position` instead is not sent back to the start of a long silence by a history the server has since dropped.

## 0.10.0

### Minor Changes

- [#28](https://github.com/softistx/nxgt-data/pull/28) [`beb6ebd`](https://github.com/softistx/nxgt-data/commit/beb6ebdee5328c6c74d0e66e007080876313e0a1) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add migrations in code, under `@nxgt/mongo/migrations`.
  
  - `defineMigration({ id, up, down?, transaction? })` declares one. `migrate(db, list, { to?, dryRun? })` applies the pending ones in order, each in a transaction together with its record. `transaction: false` is for index builds and `collMod`.
  - `rollback(db, list, { to?, dryRun? })` undoes the last applied migration, or every one after `to`. It refuses before undoing anything if one of them has no `down`.
  - `migrationStatus(db, list)` reports each migration as `applied`, `pending` or `missing`.
  - The list may only grow at its end: an id listed twice, an applied migration no longer listed, or a pending one before an applied one is refused before anything runs.
  - A renewed lock in `<collection>_lock` keeps two runs from migrating at once. A second run fails with `MigrationLockedError`, and a run that loses its lock stops before its next migration.
  - New error codes: `MIGRATION` (`MigrationError`, which names the migration) and `MIGRATION_LOCKED`.

## 0.9.0

### Minor Changes

- [#25](https://github.com/softistx/nxgt-data/pull/25) [`2ee8fe3`](https://github.com/softistx/nxgt-data/commit/2ee8fe3dac161f0e795bab438729e3078c888e12) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Type and guard what a write may say about the stamps.
  
  - `create` takes `createdAt` and `updatedAt` as optional `Date`s and keeps them.
  - `update` and `updateMany` take `updatedAt`, and `$currentDate` on it is left to the server instead of conflicting with the stamp the collection adds.
  - A refusal is a compile error and, before anything is sent, a `TypeError`; `raw` is the way to set a stamp by hand. One is runtime only: an expected version on a collection opened with `optimisticLock: false`.
  - `validate: 'off'` now fills the stamps the collection keeps, since a caller can no longer give them.
  - `undefined` values inside an update operator are dropped, as they already were at the top of a patch.
  - The field builders have explicit return types (`ObjectIdField`, `TimestampField`, `DeletedAtField`, `VersionField`, `ActorField`), so an editor shows the stamps as `Date` rather than as inferred aliases.
  - New exports: `StampNameOf`, `VersionNameOf`, `SetByCollection`, `FixedOnUpdate`, `ManyPatch`, `ExpectedVersion`, `WritableDocumentOf`, `WritableFieldOf`, `WritablePath`, `RemovablePath`, `ObjectIdField`.
  
  **Breaking:**
  
  - The expected version is given in `update`'s patch, under the version field's configured name (`{ subject, revision: 3 }`). The `expectedVersion` option is gone, and `UpdateOptions` with it. The version must be a whole number and needs the optimistic lock; `updateMany` refuses it.
  - `create` refuses the version, the soft-delete field and the actors: importing soft-deleted documents through `create` no longer works, so use `raw`.
  - `update` and `updateMany` refuse `createdAt`, the soft-delete field, the actors and the version, as fields and through any operator (`$set`, `$inc`, `$unset`, `$rename`, `$push`…). `$inc: { version }` is no longer a way out.
  - `updatedAt` can no longer be removed or renamed.
  - The actors come only from `collection.as(actor)`: a `createdBy` or `updatedBy` given explicitly is refused, where it used to be kept.
  - `NewDocumentOf` leaves the stamps the collection keeps out.

## 0.8.0

### Minor Changes

- [#23](https://github.com/softistx/nxgt-data/pull/23) [`c5dfe8a`](https://github.com/softistx/nxgt-data/commit/c5dfe8a007fa410cde33a8fe0c8fddaadf6e0d99) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Typed aggregation helpers: `distinct`, `groupBy` and `populate`
  
  - `collection.distinct(field, filter?, { withDeleted })`: the distinct values
    of a field, typed — an array field gives its elements. It now leaves
    soft-deleted documents out, like every read; the driver's is
    `raw.distinct`.
  - `collection.groupBy(field, { filter, measures, sort, limit, withDeleted })`:
    each group's `key` and `count`, and typed measures — `sum` and `avg` on
    numeric fields, `min` and `max` on any. Largest groups first by default.
  - `collection.populate(documents, relations)`: related documents under each
    relation's name, one query per relation. `{ from, by }` follows a field of
    these documents (a list field gives a list, in its order); `{ from, on }`
    gathers the documents that point back. The related collection reads with
    its own session and soft delete.
  
  The types refuse a non-numeric sum, a measure named `key` or `count`, a
  field that holds no reference, and a relation named after an existing field.

## 0.7.0

### Minor Changes

- [#22](https://github.com/softistx/nxgt-data/pull/22) [`174eb4c`](https://github.com/softistx/nxgt-data/commit/174eb4c39d2e4979af9fcef73cdb17f39732dbcf) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `connectMongo(uri, options)`: one `MongoClient` shared per URI
  
  Every call with the same URI shares a client, connected once even when the
  calls race, and gets its own `MongoConnection` (`client`, `db`, `ping`,
  `close`, `await using`). The client closes with its last connection, so one
  module closing its own does not cut the others off. A second call with other
  options throws without repeating the URI. A failed connect is forgotten, so
  the next call retries. `ping({ timeoutMS })` answers `{ ok, latencyMs }` or
  `{ ok: false, error }` and never throws. `closeMongo()` closes every client at
  shutdown; nothing listens to signals for you.

### Patch Changes

- [#20](https://github.com/softistx/nxgt-data/pull/20) [`ec2c664`](https://github.com/softistx/nxgt-data/commit/ec2c6640275dbddc28fcdaf1c669ab79fea9a5d1) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Internal: `src/collection/` is split into subject folders (`operations/`,
  `hooks/`, `changes/`). Nothing public moved: the exports, their types and
  their behaviour are unchanged, and the test counts are the same on both
  sides.

## 0.6.0

### Minor Changes

- [#18](https://github.com/softistx/nxgt-data/pull/18) [`af56ef9`](https://github.com/softistx/nxgt-data/commit/af56ef9884bdeb8962a0cfc2a098c693d8025ba5) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `collection.onChange`: a typed subscription to a collection's changes
  
  `users.onChange(handler, { events, filter, withDeleted, startAfter, onError,
  retries })` listens until `close()` — or `await using` — and hands over
  `create`, `update`, `delete` and `restore` changes typed by the schema. A soft
  delete arrives as a `delete` with `hard: false`, and a restore as a
  `restore`; updates to soft-deleted documents are left out unless
  `withDeleted`. `filter` is a filter on the documents, keyed on the schema's
  fields.
  
  Changes are handed over one at a time, in order. The driver resumes on its
  own after a dropped connection; when it gives up, the stream is reopened from
  the last token it held, so nothing is missed while the process is up. A
  change's `resumeToken` — typed `ResumeToken`, so an id is not taken for one —
  passed back as `startAfter`, picks up after a restart.
  The document is the exact post-image when the collection keeps them
  (`options.changeStreamPreAndPostImages`), and `before` is the pre-image.
  
  Errors go to `onError`; without it, the first one closes the subscription and
  rejects `closed`. `ready` rejects when the subscription fails before it ever
  opened. A handler may `close()` its own subscription.

## 0.5.0

### Minor Changes

- [#16](https://github.com/softistx/nxgt-data/pull/16) [`1616f15`](https://github.com/softistx/nxgt-data/commit/1616f1548f679d62fc1b6f09a1f4efe6c26c0e75) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Hooks around the writes, typed by the schema
  
  `getCollection(db, users, { hooks: { beforeCreate, afterDelete, … } })` runs
  hooks around `create`, `createMany` (once per document), `update`,
  `updateMany`, `delete`/`hardDelete`, `deleteMany`/`hardDeleteMany` and
  `restore`. A `before` hook gets what is about to be written — `{ values }`,
  `{ id, patch }`, `{ filter }` — and may return a replacement of the same shape
  or throw to stop the write; an `after` hook gets the document or the count.
  Every hook gets the operation, the collection the write runs on (session and
  actor included), the session and the actor; the delete hooks also say whether
  the delete is hard. `hooks` takes an array of sets, run in order, and
  `withSession` and `as` keep them. `restore`'s hooks are only typed on a collection
  whose definition soft deletes. An empty filter is refused before any hook
  runs, so a hook that narrows the filter cannot turn `deleteMany({})` into a
  delete of everything it can reach.
  
  `getCollection` now infers its types from the definition alone. It used to
  read them from the options too, which let a hook set typed for another
  collection widen them until it fit.

## 0.4.0

### Minor Changes

- [#14](https://github.com/softistx/nxgt-data/pull/14) [`170615a`](https://github.com/softistx/nxgt-data/commit/170615aae3e3c456151c0a659fb55042a640dda6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Stamps are options of `defineCollection`, and collections carry MongoDB's own options
  
  **Breaking.** The four spread helpers are gone. A field added by hand was only
  a field — spreading `...softDelete()` never made `delete` soft — so the stamps
  became options that add their fields to the schema *and* turn the behaviour on.
  
  ```ts
  // before
  schema: z.object({ _id: id(), email: z.email(), ...timestamps(), ...softDelete() }),
  
  // now
  schema: z.object({ _id: id(), email: z.email() }),
  timestamps: true,
  softDelete: true,
  ```
  
  | removed | replaced by |
  | --- | --- |
  | `...timestamps()` | `timestamps: true` |
  | `...softDelete()` | `softDelete: true` |
  | `...optimisticLock()` | `optimisticLock: true` |
  | `...actors(type?)` | `actors: true` or `actors: { type }` |
  | `stampsOf(schema)` | `definition.stamps` |
  
  Each option is `true`, `false`, or an object naming its fields one by one —
  `softDelete: { deletedAt: 'removedAt' }`, `actors: { createdBy: 'openedBy',
  deletedBy: false }`. Inside that object an absent key means on under its
  default name; only `false` turns a field off. The name then follows
  everywhere: the document type, the `$jsonSchema` validator, the field `delete`
  writes, and the fields an index may be keyed on — indexing `deletedAt` on a
  collection that renamed it no longer compiles. The single-field builders
  (`timestampField`, `deletedAtField`, `versionField`, `actorFieldOf`) stay, for
  a field with no behaviour attached.
  
  `ActorOf` now reads the actor's type under the name the option gave it. It was
  looking for a literal `createdBy`, so a renamed actor field resolved to `never`
  and made `as()` uncallable — silently, since that compiles.
  
  **MongoDB's own collection options** are part of the definition:
  `options: { capped: { size, max }, timeseries: { timeField, metaField },
  collation, clusteredIndex, expireAfterSeconds, changeStreamPreAndPostImages }`,
  keyed on the schema's fields where they name one. `capped` is one object rather
  than three sibling keys, because the server refuses `capped` without a `size`.
  `sync` creates the collection with them, changes the few `collMod` accepts, and
  throws on the rest naming the option, the live value and the wanted one;
  `dryRun` lists every difference instead. Only what the definition asks for is
  compared, because MongoDB fills its own defaults into `collation` and
  `timeseries` and an equality check would report a difference on every run.
  A time-series collection gets no validator — MongoDB refuses one — so
  `validation.level` defaults to `'off'` there and asking for another throws
  where the definition is written.
  
  **`syncAll(db)`** syncs every collection `defineCollection` has built, with no
  list to keep: importing the module that defines one registers it.
  **`getCollection(db, def, { autoSync: true })`** syncs once per database before
  the first operation, for tests and development — `resetAutoSync(db)` forgets
  it, which a suite that drops its database between cases needs.

## 0.3.1

### Patch Changes

- [#12](https://github.com/softistx/nxgt-data/pull/12) [`8ecab7a`](https://github.com/softistx/nxgt-data/commit/8ecab7a858201e1c63bf7e86a2fd394d169c0131) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Internal: a collection is now assembled from modules instead of one factory.
  
  Nothing public moved — every export, every signature and every behaviour is
  what 0.3.0 shipped, and the same 144 tests pass on both sides of the change.
  
  `getCollection` was one 583-line file whose `build()` function held 487 of
  them: a closure over a dozen variables with twenty functions inside it. It is
  now a `CollectionContext` of plain resolved data, passed as the first argument
  to functions that live in `filters.ts`, `documents.ts`, `reads.ts`,
  `writes.ts` and `paginate.ts`. The factory that is left resolves the database,
  assembles the surface and proxies the driver's own collection, and nothing
  else; the largest function in the folder is now 66 lines.
  
  `withSession` and `as` still rebuild the collection with one option changed,
  exactly as before.
  
  The one thing this tidies in passing: `delete` and `deleteMany` built the
  soft-delete update separately, and now share it.

## 0.3.0

### Minor Changes

- [#10](https://github.com/softistx/nxgt-data/pull/10) [`0c30a0a`](https://github.com/softistx/nxgt-data/commit/0c30a0ac4fca03b79da1a20d7c0617bd7afc2018) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Collections rather than repositories, with the driver's own methods on the same
  object — and a good deal more of the schema actually checked by the compiler.
  
  **Breaking.** `createRepository` and the `Repository` type are gone, replaced by
  `getCollection` and `TypedCollection`. To migrate: `createRepository(db, def)`
  becomes `getCollection(db, def)`, `.with(session)` becomes
  `.withSession(session)`, and `.collection` — the driver's collection — becomes
  `.raw`. `RepositoryOptions` is `CollectionOptions`.
  
  What you get back is no longer a wrapper standing in front of the driver: it is
  this package's methods **and** the driver's `Collection`, on one object.
  `aggregate`, `watch`, `bulkWrite`, `distinct`, `collectionName` are all there
  directly. Three names are defined by both and this package's win, because a
  filter that came out empty must not rewrite a collection: `count`, `updateMany`
  and `deleteMany` return a number and require a filter. The driver's own stay
  reachable on `raw`, which is also the way out for an update operator this
  package does not name.
  
  `getCollection` takes a `Db` or a `MongoClient` — with a client, the database
  is the URI's, or the one named in `{ db }`. It does not take a session, because
  a session does not expose its client: the driver marks that field internal and
  keeps it out of its public types, so reading it would be a bet on a private
  field. `withSession` is how a collection joins a transaction.
  
  **The typing is considerably stricter**, which is the other half of this
  release. Measured on twelve mistakes that a user of 0.2.0 could make, seven got
  past the compiler; all seven are now compile errors: `sort` and `projection` on
  a field that does not exist, a projection that is neither 0, 1 nor an operator,
  `$set` on an unknown field or with the wrong type, and an actor of any type at
  all — `as()` now takes what the schema declares for `createdBy`, and a
  collection that stamps no actor has no `as()` to call. The update operators are
  declared by this package rather than taken from the driver, whose `UpdateFilter`
  is intersected with `Document` and therefore accepts every key; `$inc` and
  `$mul` want a numeric field, `$push` and `$addToSet` an array field and its
  element type. What stays unchecked, on purpose: the tail of a dotted path, and
  `filter`, which remains the driver's `Filter`.

## 0.2.0

### Minor Changes

- [#8](https://github.com/softistx/nxgt-data/pull/8) [`3aeeb5e`](https://github.com/softistx/nxgt-data/commit/3aeeb5edcb3f4b821ac355c33050ffa4c7f6b987) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Index keys are typed by the schema, documents carry `id`, and ids arrive from
  strings safely.
  
  `defineCollection`'s indexes were typed as the driver types them, which is
  `{ [key: string]: IndexDirection }` — every key accepted, nothing completed and
  a misspelt field only discovered when the index silently indexed nothing. They
  are now keyed on the schema's own fields, so an editor completes them and
  `{ key: { emial: 1 } }` does not compile. A path into a field,
  `{ key: { 'address.city': 1 } }`, is still allowed: that is how MongoDB indexes
  a nested key, and there is no honest way to check the tail of a path.
  
  Every document a repository gives back now has `id`, its `_id` as a string.
  It is computed rather than stored — the collection still holds `_id` alone —
  and it is enumerable, so `JSON.stringify` and a spread carry it and a handler
  can return the document unchanged. It is no field of the document, so a filter
  or a patch keyed on it does not compile, and writing a document that was read
  back drops it again rather than letting the validator refuse it. A schema that
  declares an `id` of its own keeps that one.
  
  New helpers turn a string into an `ObjectId`: `toObjectId`, which throws the
  new `InvalidIdError`, `tryObjectId`, which answers `undefined`, `toObjectIds`
  for a `$in` filter, `isValidObjectId` and `isObjectIdString`, and
  `objectIdParam()`, a Zod schema for a route's parameters. They exist because
  `new ObjectId(undefined)` does not throw — it invents a fresh id, and a
  parameter that never arrived then matches nothing instead of failing.

## 0.1.0

### Minor Changes

- [#6](https://github.com/softistx/nxgt-data/pull/6) [`835971d`](https://github.com/softistx/nxgt-data/commit/835971d11ea47d3bffaf368db799d9a42421a56b) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/mongo`: a typed MongoDB collection from one Zod schema.
  
  The schema is the single source. `z.output` types every read and `z.input`
  every write, and the same schema becomes the collection's `$jsonSchema`
  validator — which is not a mechanical conversion: MongoDB rejects `$ref`,
  `$schema`, `default`, `format` and `id`, has no `integer` type, and treats a
  keyword it does not know as an error rather than ignoring it.
  `toMongoJsonSchema` inlines every `$ref`, keeps only the keywords MongoDB
  knows, and maps `integer` onto the BSON types a whole number actually arrives
  as.
  
  `syncCollection` creates the collection, writes the validator when it changed
  and brings the indexes in line, idempotently and with a `dryRun`.
  `createRepository` gives typed reads and writes by `_id` or by filter, offset
  and cursor pagination, soft delete, optimistic locking through a `version`
  field, and audit stamps from `repository.as(actor)`. `withTransaction` runs a
  callback in a transaction and joins one that is already open, since MongoDB
  has no savepoints.
  
  MongoDB's errors arrive as `NotFoundError`, `ConflictError`, `ValidationError`,
  `OptimisticLockError` and `DataError`, so an application never reads a numeric
  code — and a duplicate key is the same `ConflictError` whether it came from a
  single write, which carries `keyPattern` and `keyValue`, or from a bulk one,
  which carries neither.
  
  The driver, `mongodb` (>=7), and `zod` (>=4.6.5) are peer dependencies.
