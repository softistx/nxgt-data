# @nxgt/mongo-kit

## 0.4.2

### Patch Changes

- Updated dependencies [[`3bf3ff2`](https://github.com/softistx/nxgt-data/commit/3bf3ff2e456676230d16299b2bd64d94a06239ac)]:
  - @nxgt/mongo@0.18.0

## 0.4.1

### Patch Changes

- [#105](https://github.com/softistx/nxgt-data/pull/105) [`528be97`](https://github.com/softistx/nxgt-data/commit/528be97359691b5bfe8f0ad08f09e0fc525e9115) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `put` and `putOnce` in `@nxgt/mongo/gridfs` refuse a source that has nothing left to give, rather than storing it as an empty file. A `ReadableStream` that was read — to the end or in part — or that someone holds a reader on, a `Response` whose body was read or is held that way, a node `Readable` that was read, ended or destroyed, and a generator these calls read before are now a `TypeError` naming the call and the bucket (`put on "avatars": this stream was already read, or is held by another reader, so it has nothing left to store. …`), thrown on the first read, before any chunk is written. The case that mattered is a transaction the driver retries — a bucket's first upload with `autoSync` fails its commit with 112 and is one: the second run read the spent stream as empty and stored a file of 0 bytes, with no error, beside whatever the callback committed. It now fails the transaction, which commits nothing. A put refused before it reads — an `_id` already taken — leaves the stream to the next call. `@nxgt/mongo-kit`'s docs on the `autoSync` retry say the stream is refused now, and a spec pins it through the kit.
  
  Two messages changed with it. A `Response` whose body was already read gets the refusal above instead of `put: this Response has no body…`, which now only answers a response that never had a body and reads `put on "avatars": this Response has no body, so it has nothing to store.` A source of no readable shape reads `put on "avatars": expected a file, a blob, a response, a stream or bytes, not a number` — the call, the bucket and the kind or class of what was given, where it used to print the value itself. Not detected, and documented as such: an iterable that hands out a new iterator over a one-shot resource, and a generator the caller drained before `put`.
- Updated dependencies [[`528be97`](https://github.com/softistx/nxgt-data/commit/528be97359691b5bfe8f0ad08f09e0fc525e9115), [`77e7140`](https://github.com/softistx/nxgt-data/commit/77e7140570a540ba3ed66edb0d9cc98b4a23ccfc)]:
  - @nxgt/mongo@0.17.1

## 0.4.0

### Minor Changes

- [#95](https://github.com/softistx/nxgt-data/pull/95) [`2151598`](https://github.com/softistx/nxgt-data/commit/2151598e72c2a8fadaa06ae6fb3f68c5ebda3eb5) Thanks [@SteveGT96](https://github.com/SteveGT96)! - GridFS buckets on the kit. A database takes `buckets`, a module of `@nxgt/mongo/gridfs` bucket definitions as `import * as buckets` gives it, and `bucketOptions` for every one of them. Each bucket is reached on the scope beside the collections, as `kit.db.avatars`, typed with its metadata, and runs in the kit's session: inside `kit.transaction(fn)` a file write commits or rolls back with the documents written beside it.
  
  ```ts
  import * as buckets from './files';
  
  const config = defineConfig({ uri, collections, buckets });
  const kit = await createKit(config);
  await kit.syncBuckets();
  
  await kit.transaction(async (tx) => {
  	const user = await tx.db.users.create({ email: 'ada@example.com' });
  	await tx.db.avatars.put(Bun.file('ada.png'), {
  		metadata: { userId: user._id },
  	});
  });
  ```
  
  `sync()` is unchanged and leaves buckets alone: `syncBuckets()` creates their indexes, reporting per database and per bucket key. A database's `autoSync` now also creates each bucket's indexes before its first call — with a caveat: when that first call is an upload inside a transaction, the chunks collection appears after the transaction's snapshot, the commit fails and the driver runs the body twice, and a stream source is spent by then. Call `syncBuckets()` at start-up, before any transactional upload.
  
  `defineConfig` refuses a bucket key a collection already holds, two keys on one bucket, a `buckets` object with no bucket in it, `session` or `autoSync` in `bucketOptions`, and `bucketOptions` on a database with no `buckets`; `createKit` refuses a bucket key the driver's `Db` answers to, with `COLLISION`, as it does for a collection.

## 0.3.0

### Minor Changes

- [#87](https://github.com/softistx/nxgt-data/pull/87) [`01063a5`](https://github.com/softistx/nxgt-data/commit/01063a51728a7ff1b0a24281842d2e7d8bd1ea2c) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `kit.ping(options?)` sends `ping` to every database the kit wires, at once, and reports `@nxgt/mongo`'s `PingResult` under each database's name — `{ ok: true, latencyMs }` or `{ ok: false, error }` — for a health endpoint. It never throws and answers within `timeoutMS` (2 s by default) even for a `client` the configuration handed over unconnected, whose first connect the driver bounds by `serverSelectionTimeoutMS` instead. Every kit answers, derived ones included.

## 0.2.1

### Patch Changes

- Updated dependencies [[`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893), [`1f99fcb`](https://github.com/softistx/nxgt-data/commit/1f99fcb8bbf37e6af9cc19a0b919c9c7d6a9a893)]:
  - @nxgt/mongo@0.17.0

## 0.2.0

### Minor Changes

- [#68](https://github.com/softistx/nxgt-data/pull/68) [`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Every refusal this package makes is a `KitError`, with a code to switch on.
  
  ```ts
  import { KitError } from '@nxgt/mongo-kit';
  
  try {
  	await createKit(config);
  } catch (error) {
  	if (error instanceof KitError && error.code === 'COLLISION') {
  		// `error.database` and `error.key` name where, without parsing the text.
  	}
  }
  ```
  
  `code` is one of `CONFIG`, `COLLISION`, `NO_DATABASE`, `SEVERAL_DATABASES`,
  `TRANSACTION`, `DERIVED` or `DISCOVERY`; `database` and `key` carry which
  database and which collection key it is about. Until now every one of these
  was a bare `TypeError` with the answer only in the sentence, so a caller that
  wanted to tell a configuration collision from a missing database had to match
  message text.
  
  **It extends `TypeError`, not `Error`**, because that is exactly what these
  were before it existed: a `catch` that already tests `error instanceof
  TypeError` keeps catching them, and gains a `code` it can read. The class,
  `KitErrorCode` and `KitErrorOptions` are exported.
  
  Two messages say more than they did. A `databases` block that is not one now
  names the shape — `{ databases: { main: … } }` — and says a single database
  is the configuration itself, naming itself with `database`; it used to state
  only that the value was wrong. An empty one now says to give it at least one,
  with the same shape.

### Patch Changes

- Updated dependencies [[`2e63c80`](https://github.com/softistx/nxgt-data/commit/2e63c80a3530fb5cc600c2deb2ddc1d1b68bfd19)]:
  - @nxgt/mongo@0.16.0

## 0.1.5

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
- Updated dependencies [[`5c5aa1d`](https://github.com/softistx/nxgt-data/commit/5c5aa1d8b8902c25e9a6a8a12b1ce44834c943f6)]:
  - @nxgt/mongo@0.15.1

## 0.1.4

### Patch Changes

- Updated dependencies [[`b4f07aa`](https://github.com/softistx/nxgt-data/commit/b4f07aa4c497bec08297a0c4bd9cb0ea57ccc682)]:
  - @nxgt/mongo@0.15.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`a6cac9b`](https://github.com/softistx/nxgt-data/commit/a6cac9bf5f22c44c9b6e1b211ae8946e4658cad3)]:
  - @nxgt/mongo@0.14.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`9117fff`](https://github.com/softistx/nxgt-data/commit/9117fffc1897452d1503c814fc878dbd8082286e)]:
  - @nxgt/mongo@0.13.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`5012472`](https://github.com/softistx/nxgt-data/commit/5012472fdcbb374961b2d604303c9f732da69114)]:
  - @nxgt/mongo@0.12.0

## 0.1.0

### Minor Changes

- [#37](https://github.com/softistx/nxgt-data/pull/37) [`24bd4e7`](https://github.com/softistx/nxgt-data/commit/24bd4e7e3de1fa265f01df857730baba11f934fe) Thanks [@SteveGT96](https://github.com/SteveGT96)! - First release: an application's MongoDB wiring in one object.
  
  `defineConfig` checks a configuration — one database or several, a `uri` or a
  client the application opened, the collections as `import * as collections`,
  and the collection options — and freezes it, connecting to nothing.
  `createKit` opens it and gives a kit whose `db` is the driver's own `Db` with
  every collection typed on it, so `db.users` is the typed collection and
  `db.command(…)` is still the driver's.
  
  It carries what used to be threaded by hand: `as(actor)` and
  `withSession(session)` give another kit over the same clients,
  `transaction(fn)` runs the body with a kit whose collections are all in the
  session and joins an outer transaction rather than opening a second one,
  `sync()` syncs exactly the collections the kit wires, database by database,
  and `close()` gives back the clients it opened and leaves alone the ones it
  was given. A collection wired under a name the driver's `Db` already has is
  refused, by the types and again against the object itself.
  
  `discoverCollections({ glob })` reads definitions from the file system for
  scripts; it has no types and does not survive bundling.
