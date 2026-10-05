# AGENTS.md

Instructions for any coding agent working in `nxgt-data`.

## What this repository is

The `@nxgt/*` packages for data access, published to the public npm
registry:

| package | what it is |
| --- | --- |
| `@nxgt/backup` | encrypted, verifiable backups on Bun: `defineBackup({ name })` and `bindBackup(definition, { repositories, recipients, tmpDir })` with `create(source)`, `list`, `verify` and `restore(id, target, { identities, only })`. Each entry a source gives is compressed with zstd (Bun's `CompressionStream`) **then** encrypted with age (`age-encryption`, streaming, X25519 or hybrid post-quantum recipients) into one object; then the encrypted **catalog** (entry names and their plain SHA-256), then the clear **manifest**, written **last** — a backup exists once its manifest does. The manifest names no entry and pins every object's size and SHA-256, so `list`, `verify` without a key, and rotation need no secret; a restore stages each object in `tmpDir` and checks it against the manifest **before a byte is decrypted** — age authenticates each chunk, but anyone with a public key can write a whole valid age file — and the plain bytes against the catalog as they go, so a damaged entry fails its stream with `INTEGRITY` and `directoryTarget` lands nothing from it. Several repositories at once: each object goes to every repository still in the run, one that fails is left out from then on, and the manifest goes only where everything landed (`PARTIAL`, `NOT_STORED`, with per-repository `outcomes`). `localRepository` writes `<key>.partial-<random>`, syncs, renames, syncs the folder, and syncs each folder it had to create in its parent. `s3Repository({ client, prefix, name, partSize })` takes the caller's Bun `S3Client`, so credentials never reach it: up to 64 MiB an object goes in **one PUT from bytes** (atomic, and +67 MB RSS for 64 MiB), above that through `writer({ partSize })`, **one `slice(start, start + partSize).bytes()` at a time, each followed by `await writer.flush()`** (+80 MB for 256 MiB at 16 MiB parts) — `writer.write` only queues and returns a number. **Never `write(key, Bun.file(path))` (+700 MB for 256 MiB), nor the writer fed `Bun.file().stream()` chunks (+680 MB, flushed or not), nor `write(key, ReadableStream)`, which hung** (Bun 1.4.2, SeaweedFS, each measured in a fresh process: RSS never comes back down, so a second run in the same process measures nothing). A part S3 refuses is retried, then Bun aborts the upload and `end()` rejects; a **local** read that fails has no abort to call — `end(error)` completes the upload — so that object is deleted straight after, and for that moment a key no manifest names holds part of an object (the `put` contract says so). Every `put` reads the size back (`stat`) before it resolves: once, against a stopped server, `end()` resolved anyway. `get` reads the first chunk to tell a missing key (`NoSuchKey`) without a HEAD and its race; `list` follows `isTruncated` and refuses a truncated page with no token. Key checks are `src/repository/keys.ts`'s `isKeyPath`, shared by both repositories. `stage` cuts an object at the manifest's size (`expect`), so a repository is not trusted with how much it sends. **`create` takes a single-writer lock in every repository** (`src/lock/lock.ts`): `<backup>/locks/<id>.json`, written **before** listing the others, and given up if any other live lock is there — so two writers can both give up, never both go on, with no conditional write — **provided the store lists a key as soon as its `put` resolved** (a local folder, AWS S3, SeaweedFS measured by the S3 race spec; the `Repository` contract requires it). A lock is renewed every `lease`/3 (5 min by default); a writer checks `held()` before every put, so one whose lease ran out **starts** nothing more there (`LEASE_LOST` in that repository's outcome, the others go on) — a put already under way may still land after, so prune leaves backups with no manifest alone until `incompleteAfter`; **a lapsed lease stays lapsed and stops renewing**: a slow renewal landing after the end does not revive it (another writer may have found it stale and taken the lock). The holder's deadline is on `performance.now()`, so a wall clock stepped back cannot stretch it; the file's `expiresAt` is wall-clock ISO for the others. A lock held elsewhere is `LOCKED`. Another writer respects a lock until `expiresAt + lease` (clock skew), and a lock that does not parse is held. Readers take no lock. `list` skips a manifest gone between its listing and its read (`NOT_FOUND`), so a prune does not fail a concurrent listing. **`prune({ from, keep, dryRun, incompleteAfter, now })`** (`src/rotation/`) works one repository at a time, under the lock (`operation: 'prune'`; a dry run takes none): `plan` is pure — `last`, `hourly`/`daily`/`weekly` (ISO, UTC)/`monthly`/`yearly` keep the newest backup per period, `within`, `held` and *newer than now* always keep, and a kept backup keeps its `parent` transitively. A backup **newer than `now`** keeps only that reason and takes no place in `last`, the calendar or the floor (a fast creator clock must not push a real backup out). `maxTotalSize` drops the oldest kept, one at a time with parents recomputed after each, never the floor (`last`, or the newest — which `maxTotalSize` alone then keeps), a held one, a future one or a needed parent (`overSize` says when it could not). Each decision carries its reasons. A manifest is deleted **first**, then the rest under its id; the lease is checked before every delete (`LEASE_LOST`). A backup whose manifest does not read is never removed (`unreadable`). Ids with no manifest go once older than `incompleteAfter` (1 day, **≥ two leases**), measured from the id's time — the create's **start** — by the real clock, never `now`: so it must exceed the longest create plus two leases. An invalid `now` is refused (a NaN date would make `within` keep nothing). Legal holds are `<backup>/holds/<id>.json`, put by `hold(id)` in **every** repository holding the backup (or `from`; `NOT_FOUND` only when none does) and removed by `unhold` everywhere, each under that repository's lock — whose record says `operation: 'prune'`, so a 0.4 reader parses it and expires it after a crash; the call name (`hold`/`unhold`) is only in the message. `list` reports `held`. **Chains** (`src/chain/`): `create(source, { kind: 'incremental' | 'differential', identities, from })` picks, **under the lock**, the newest readable backup (a full one for a differential) **older than its own id** in `from` (by default the first repository still in the run; a named `from` whose lock failed rejects with that error — a base read without its lock could race a prune) — a manifest's `parent` must be older than its `id` (`readManifest` refuses otherwise, so a chain walk ends) — walks its **whole chain** there (`chainOf`: a missing ancestor rejects with `INTEGRITY`), **refuses a base encrypted to other recipients** (as a set: pointing to its objects would keep a removed key reading the new backup), reads its catalog (hence the key), and leaves out any other repository whose copy of the chain is not whole (`NOT_FOUND` or `INTEGRITY` outcome). Every catalog lists the backup's **whole view**: an unchanged entry points to the object where it already is (`in: <id>`, flattened to the backup that stored it, never a hop), so `restore` and `verify` read one backup's catalog and `locate` each object in its chain — no replay, no deletions to apply. Unchanged is a source `fingerprint` equal to the recorded one (not opened), else the same SHA-256 once sealed (the sealed file dropped). A source's `position` is kept in the catalog (encrypted) and handed back as `since.position`. `chainOf` turns a missing ancestor into `INTEGRITY`; `verify` without a key checks every object of every backup of the chain. The directory source's fingerprint is `size:mtimeNs:ctimeNs:ino` from `lstat` before the read — **none when either time is within 2 s of the read** (git's racy-clean rule: coarse clocks let a same-size write in the same tick keep the old times), and an entry no longer a regular file is skipped. `prune` keeps the parent of a manifest that does not read (its raw `parent`, best effort) through a held **stand-in** candidate that no rule counts; a **0.5 prune cannot**, so pruners upgrade before the first incremental. Errors from an ancestor's object name the ancestor (`openEntry`, shared by restore and verify). `localRepository.delete` removes the folders it empties up to its root, and `put` re-makes its folder when a racing delete removed it, up to five times (`raced`: an `ENOENT` anywhere on the way, or the folder gone — on macOS the copy fails `EINVAL`, not `ENOENT`; and asking only whether the folder is gone missed a race on CI's Linux, where another put had made it again before the check). `directorySource`/`directoryTarget` are the generic source and target: neither follows a symbolic link — the source skips one, to a file or a folder, and the target refuses an entry name that is absolute, holds an empty, `.` or `..` segment, or whose folder is already there as a link — and a target's `write` must read its stream to the end, or `restore` refuses it, since the plain digest is checked there. **Who wrote a backup** is proven by an Ed25519 signature over the manifest's exact bytes (`signing: { key }`, PEM; `manifest.sig`, put just before the manifest), checked against `trusted` — the signing key's public half by default — on the bytes, before they are parsed, with the signature read no further than 65 bytes; a failure is `SIGNATURE`. Without `signing` or `trusted` nothing is signed nor checked, and anyone who can write the repository can still write a whole consistent backup that restores — the recipients are in every manifest. Node's error for an unreadable key is dropped like age's. The signature binds a manifest's content, backup and id — a signed pair moved under another id is `INTEGRITY` — **not its freshness, nor the listing's completeness**: whoever can write the repository can still delete a backup, hide it, or put back an older one, each genuinely signed; that is Object Lock's job, later. A binding with `trusted` and no `signing` is a reader: its `create` is refused, since it could not read what it wrote. A manifest is read no further than 64 MiB (`MANIFEST_MAX_BYTES`, about half a million entries), and `create` refuses to write a larger one. Its one error is `BackupError` (`NOT_FOUND`, `INTEGRITY`, `DECRYPT`, `SIGNATURE`, `PARTIAL`, `NOT_STORED`, `LOCKED`, `LEASE_LOST`), whose message names the call, the definition and the repository and never a key, an entry name or a value — measured on age-encryption 0.3.1, age's own message for a bad identity quotes the whole secret key, so `decrypterFor` drops it rather than passing it as `cause`. Wiring refusals are bare `TypeError`s |
| `@nxgt/drizzle` | an SDK over Drizzle ORM: typed repositories (`createRepository`), offset and cursor pagination, `withTransaction`, `upsert` as one `INSERT … ON CONFLICT` on the `where`'s columns, optimistic locking on an integer `NOT NULL` `version` (`OptimisticLockError`), actor stamps from `as(actor)` or the `actor` option, its own errors with `toDataError`, and the `id()`, `timestamps()`, `softDelete()`, `version()`, `actors()` columns. PostgreSQL first |
| `@nxgt/drizzle-meilisearch` | keeps a Meilisearch index in step with a PostgreSQL table: `createSearchSync` with a `transform` and a `toIndexId` typed by both sides, `reindexAll`, and one call per write — `indexRow`, `indexRows`, `removeRow`, `remove`, `removeMany`. Deliberately smaller than the Mongo bridge: PostgreSQL has no change feed a library could follow without owning the deployment, so there is no `start`, no resume point and nothing followed. Its one error is `SearchSyncError` |
| `@nxgt/meilisearch` | a typed Meilisearch index on the official SDK: `defineIndex<Doc>()({ uid, primaryKey, settings })`, which refuses a uid the server would refuse with a bare `TypeError` naming the shape, never the uid (0.6.0: 1 to 400 ASCII letters, digits, `-` and `_`, measured on v1.53.2 — one rule in `src/definition/uid.ts`, `isIndexUid`, shared by `defineIndex`, `bindIndex` for a hand-made definition, `rebuild`'s next uid, whose default `<uid>_next` needs a uid of at most 395, and `tenantToken`, whose own check still fires for an index not from `bindIndex` or whose `uid` was reassigned; the types refuse only a literal that is empty or holds a space, `*`, `.` or `/`), `syncIndex`/`syncIndexes` applying the settings idempotently, and `bindIndex` for typed documents and searches, with `rebuild` filling `<uid>_next` beside the live index and swapping it in atomically, `multiSearch` returning a tuple of results each typed by its own index, and `tenantToken` signing a token whose `searchRules` are keyed by the uids of the bound indexes it is given, over the SDK's `meilisearch/token` — failing closed: `expiresAt` and a rule per index (`null` for no filter) are required, in the types and at run time. Its one error is `SearchIndexError` |
| `@nxgt/mongo` | a typed MongoDB collection from one Zod schema: `defineCollection` with its stamps and MongoDB's own collection options, `syncCollection`/`syncAll` applying the `$jsonSchema` validator, the collection options and the indexes idempotently, `getCollection` returning the driver's own `Collection` merged with pagination, soft delete, optimistic locking and audit stamps, `withTransaction`, `upsert` as one atomic pipeline update, an `_id` never written — `update`, `updateMany` and `upsert` refuse it in any patch, through any operator and even as `undefined`, with a bare `TypeError` naming the call and the collection before anything is sent or any hook runs, and the types leave it out (`FixedOnUpdate` includes `'_id'`) except a top-level `_id: undefined`, which `_id?: never` accepts without `exactOptionalPropertyTypes` and only the run time refuses; an upsert's insert may take it from the filter, which also makes it part of the match, and the driver's own `updateOne`, `findOneAndUpdate`, `replaceOne`, `bulkWrite` and `raw` are left as the driver wrote them — migrations in code under the `./migrations` subpath, and files under `./gridfs` — a bucket described once, typed metadata, `Range`-aware serving, and chunk documents written by the package itself so that a file write can run in a transaction, which the driver's GridFS cannot. A string that arrives from outside is converted from the **schema** — a 24-hex string to `ObjectId` where the schema says `objectId()`, a date string to `Date` where it says `z.date()`, in ids, filters and writes alike — unless `coerce: false`. Since 0.19.0 it holds **the wiring folded in from `@nxgt/mongo-kit`** (`src/wiring/`): `defineMongo` checking a configuration of one or several databases, and `openMongo` giving a `Mongo` whose `db` is the driver's `Db` with every collection typed on it — and every `./gridfs` bucket the config's `buckets` wires, beside them, in the session so a file write joins a transaction — plus the actor (`as`), `withSession`, `transaction`, `sync`, `syncBuckets` (bucket indexes, which `sync` leaves alone), `ping` and `close`; `discoverCollections` reads definitions from a glob, for scripts (Bun only: `Bun.Glob`). Its errors are `DataError` and its subclasses, and, for the wiring alone, `WiringError` — a `TypeError` with a `code` (`CONFIG`, `COLLISION`, `NO_DATABASE`, `SEVERAL_DATABASES`, `TRANSACTION`, `DERIVED`, `DISCOVERY`) |
| `@nxgt/mongo-backup` | MongoDB for `@nxgt/backup`: `mongoSource({ db, collections })` and `mongoTarget({ db, replace, tmpDir })`. A full backup reads every collection in **one snapshot session** pinned at once by a `distinct` on a collection no one has (a session takes the time of its first read, and only `distinct` returns `atClusterTime` in the reply body the driver reads). `listCollections` and `listIndexes` are not served at a cluster time, so they are read **before the pin and again after it**, and the pin is retaken until both agree (five times, then `CHANGING`): an index built during the backup would otherwise reach the metadata while the documents still break it, and a rename in the gap would lose a collection. Entries are `metadata/<name>` (options and indexes, canonical Extended JSON, `_id_` and `v`/`ns` left out) and `documents/<name>` (concatenated raw BSON, `find({ raw: true })`, so no number changes kind); views are metadata only, GridFS buckets are plain collections, `system.*` is never read, and a time-series collection is `UNSUPPORTED`. The position is the cluster time **just after** the snapshot's, so the next change stream replays nothing the snapshot holds, **and how the collections the chain follows differ from its full backup's** (`added`, `removed`): the full backup's are its `metadata/<name>` entries, which every catalog of the chain lists, so the position stays small — a full list once overflowed `@nxgt/backup`'s 64 KiB position limit at about 2000 collections, *after* every entry was stored; a difference past 64 KiB is `UNSUPPORTED` (`fitting`). A chain follows its full backup's collections plus those created since that the filter takes, so a change to `collections` takes effect at the next full backup — a wider filter mid-chain would replay updates to documents never read. An incremental or differential re-yields the base's entries by their recorded fingerprints (never opened) and adds `changes/<n>` (n = the base's changes entries + 1): the database's change stream with `showExpandedEvents`, `fullDocument: 'whenAvailable'` and `promoteValues: false`, read from the position up to the operation time read when the backup started, stopping at the first later event, at an invalidation, or at the first empty read (measured: the first `tryNext` does return pending events) — and the position becomes the last event's resume token, or the stream's own when it caught up. An event on a collection not followed (a creation: not taken) is skipped **before** it is translated, a rename apart, so an update or a creation there that a change could not say never fails the backup. A rename records `dropTarget` (the event's `operationDescription.dropTarget`, the UUID it replaced); a cross-database rename reaches this database's stream as a `drop` on mongod 8.2. An update whose `disambiguatedPaths` is not empty (a field named with a dot or a number) is `UNSUPPORTED` unless the collection keeps post-images; a rename into the filtered collections is `UNSUPPORTED`, one out of them is a drop. **With `promoteValues: false` the server's error `code` arrives as a BSON `Int32`** — `serverCode` unwraps it; a check on `typeof code === 'number'` missed `HISTORY_LOST`. The target builds each collection under `nxgt-restore-<uuid>` with its options, fills it with `bypassDocumentValidation`, indexes it, and renames it into place only once its stream ended cleanly — the backup's checks run at the end — dropping the staging on any failure; a collection or view already there is `EXISTS` unless `replace`. A `changes/` entry is staged to a file in a `mkdtemp` folder of `tmpDir` (0700: it holds whole documents in the clear) and applied after its stream ended cleanly; a replayed rename passes `dropTarget: change.dropTarget || replace` and turns the server's 48 into `EXISTS`, so a target taken even a moment before is refused (a check first, then a rename, left a gap), in order, document changes as ordered bulk writes per collection. Its one error is `MongoBackupError` (`SNAPSHOT_TOO_OLD`, `CHANGING`, `HISTORY_LOST`, `UNSUPPORTED`, `EXISTS`, `MALFORMED`), whose message quotes no name, document or value; wiring refusals are bare `TypeError`s. **Driver errors pass through unchanged** — an E11000 during a restore quotes the key — on purpose: wrapping them would hide the server's own diagnosis, and the docs say so. **`mongoBackups`** is the entry point (0.3.0): one key file (`keygen` writes an age identity and an Ed25519 key, `0600`, `wx` — never over a file; `readKeyFile` refuses one others can read, `KEY_FILE`), `run` (full when none is younger than `fullEvery`, else incremental; `HISTORY_LOST` alone falls back to a full one, any other error is the run's; `verify` with the key, then `prune` with `DEFAULT_KEEP` unless `keep: false`), `restore` (`at` an id or a time; whole through `mongoTarget`, a part through `restoreCollections`), `drill` (`nxgt-drill-<uuid>`, counted, dropped). The key file is read once, lazily, and again after a failed read. The bin `nxgt-mongo-backup` is `src/cli.ts`, a second entry point. A target remembers the metadata it read, so it serves one restore. **`restoreCollections`** (granular restore, "restore as") never filters entries on the way in: a rename in the chain can carry a collection the selection names from one it does not, so it rebuilds the whole backup through `mongoTarget` in a scratch database (`nxgt-restore-<uuid>` on `db.client`, or a given one that must be empty — it is dropped in a `finally`), then picks by the names *at the end of the chain*. Whole collections move by a cross-database `renameCollection` (options and indexes kept; `dropTarget: replace`, 48 → `EXISTS`, after a pre-check so nothing moves when one name is taken), views are made again with `viewOn` mapped when their collection moves too; with `replace`, a view standing where a collection lands is dropped first (mongod renames over a collection, never over a view — it answers 48 even with `dropTarget`; `mongoTarget` drops one the same way, after building the collection apart, and both share `isView`); every key of an `as` record must name a collection restored, since a typo would land that collection under its own name, over the live one; `scratch` must share `db`'s client, as `$merge` names `db` on the scratch's server; `documents: { filter, existing }` is a `$merge` on `_id` (`replace` / `keepExisting`), the collection made first with the backup's options and indexes when absent, views passed over. Measured on mongod 8.2: a cross-database rename goes through a `tmpXXXXX.renameCollection` collection, so a whole restore into the database a chain follows *by a list* makes its next incremental `UNSUPPORTED` (pinned in `restore.spec.ts`). `existing` is required and `replace` is refused with `documents`, by the types (`test/types`) and at runtime |
| `@nxgt/mongo-meilisearch` | keeps a Meilisearch index in step with a MongoDB collection: `createSearchSync` with a `transform` typed by both definitions, `reindex`, and `start`, which follows the collection's changes in batches from a resume point kept in MongoDB. Its one error is `SearchSyncError` |
| `@nxgt/mongo-kit` | **deprecated, a thin re-export of `@nxgt/mongo`**: its API moved into `@nxgt/mongo` and was renamed (`createKit` → `openMongo`, `defineConfig` → `defineMongo`, `KitError` → `WiringError`, `MongoKit` → `Mongo`, `KitOf` → `MongoOf`, `KitConfig`/`KitConfigInput` → `MongoConfig`/`MongoConfigInput`, `KitActor` → `MongoActor`, `KitTransactionOptions` → `MongoTransactionOptions`, `KitBucketOptions`/`KitCollectionOptions` → `WiredBucketOptions`/`WiredCollectionOptions`, `ReservedName` → `DbMemberName`). `src/index.ts` re-exports with `@deprecated` aliases for the old names (`KitError` as a value and a type), `src/index.spec.ts` asserts `createKit === openMongo`, `defineConfig === defineMongo` and `KitError === WiringError`, and there are no docs and no MongoDB in its specs. It holds no logic: change `@nxgt/mongo`, never this. `@nxgt/mongo-search-kit` still imports its type names, until it is folded in turn |
| `@nxgt/mongo-search-kit` | a search kit over the Mongo wiring: `createSearchKit(kit, config)` takes one entry per collection — an index and a transform, under the key the wiring wires that collection under — and gives one `reindexAll`, one `start` and one `close` for all of them. Each entry's sync is `@nxgt/mongo-meilisearch`'s, unchanged |
| `@nxgt/redis` | Redis on Bun's own `RedisClient`, with no third-party driver: `connectRedis`/`closeRedis` sharing one client per URI, `defineCache`/`bindCache` with the key built by a typed function and the value checked by its schema both ways, `withLock` over `SET NX PX` released by a compare-and-delete script, and `defineChannel`/`publish`/`subscribe` typed the same way — and, since 0.4.0, **the wiring folded in from `@nxgt/redis-kit`** (`src/wiring/`): `defineRedis` checking a configuration of one or several Redis instances, and `openRedis` opening the clients and giving `redis.cache.<key>` and `redis.channels.<key>` — every cache and channel typed under the key it is exported as, renamed under the instance's prefix — plus the subscriptions it tracks and closes, `lock`, `ping` and `close`. The wiring has no error of its own: its refusals are bare `TypeError`s (`defineRedis: …`, `openRedis: …`), and what a caller catches at run time is `RedisError` |
| `@nxgt/redis-guard` | guards on Bun's own `RedisClient`, each step a single Lua script on the server: `defineRateLimit`/`bindRateLimit`, GCRA in **exact integers**, over one key holding `"<base> <ahead>"` — the latest server `TIME` in µs the bucket has seen (it only moves forward, so a clock that goes back never refills, and two servers whose clocks alternate cannot count one stretch twice — **while they are at most one full refill apart**: beyond that the stored `base` fails the parse, so alternating clocks allow a full burst at each switch and a single jump back allows one extra burst; the `PX` is counted from `now` plus how far `base` is ahead of it), and the TAT's offset beyond it in ticks of 1/limit µs, where one request is exactly `per × 1000` — timed by the server's clock and never the host's, with `consume`, `enforce`, `peek` and `reset`, a `cost` per call, and results as delays in milliseconds (`resetAfter`, `retryAfter`) rather than dates. A denial and a `peek` write nothing, and the key's `PX` ends when the bucket is full again. Scripts go through `src/scripts/run-script.ts`: `EVALSHA` by a SHA-1 computed once, `EVAL` on `NOSCRIPT`. Its one error is `GuardError` (`RATE_LIMITED`, `COST`, and idempotency's `IN_PROGRESS`, `MISMATCH`, `INVALID`, `LEASE_LOST`), which names the definition and never the key, the params, a fingerprint or a value; a definition that could never work is a bare `TypeError`, including a `burst × per × 1000` above `Number.MAX_SAFE_INTEGER`, the one bound exactness needs. **Three float versions came before and each drifted**: a TAT in float µs near 1.8e15 cannot hold `cost × interval` exactly, and rounding it to nearest let 21 per 10 s with a burst of 1000 allow 1049 at one instant, rounding it up made a full burst unreachable at 3 per second with a burst of 2, and 7 per second under-reported `remaining`. Do not bring a float back into the state; `fixed-now.spec.ts` is what catches it. The earlier bound of 500 requests a millisecond went with the floats: in ticks every rate is exact. A stored value is used only if the script could have written it — two digit strings of at most 16 digits, each at most 2^53 − 1, `ahead` at most the tolerance, `base` at most a full refill ahead of `now` — and any other string reads as a full bucket (a key of another type fails with Redis's `WRONGTYPE`): an out-of-range value once made a division's estimate miss by more than one and its correction loop spin, holding the server BUSY. The corrections are now one bounded step each way, which is exact only under that precondition. **Idempotency** (`src/idempotency/`, 0.2.0; heartbeat and `wait` 0.3.0): `defineIdempotency`/`bindIdempotency` with `run(params, work, { fingerprint, wait })` and `forget`, over one hash per key in exactly two three-field shapes — running (`state`, a 32-hex `token`, `fp`; `PEXPIRE lease` ms) and done (`state`, `fp`, `value` as JSON; `EXPIRE ttl` s) — and four scripts: `BEGIN` takes the key or reports what holds it, checking the fingerprint (a SHA-256, or `''` for none) whether the holder is done or still running; `RENEW` is a compare-and-renew on the run's own token, touching only a running record that carries it; `COMPLETE` stores only under that token; `RELEASE` is a compare-and-delete on it. `BEGIN` trusts a record only if `run` could have written it — `HLEN` of 3 read first, so no loop — and anything else is `INVALID`, kept, with `work` not called: never a free key, which would repeat the side effect, and never `MISMATCH`, which would blame the client. A result is parsed (z.input → z.output), stored as JSON **and parsed back** before it is stored, so the first caller gets what every replay gets and a result that cannot replay is refused while the key can still be released; a stored result the schema now refuses is `INVALID`, not a miss. A thrown error is never stored: the key is released and the error passes through as the same object. **The lease is renewed** every third of it while `work` runs (`lease/heartbeat.ts`, `keepLease`, after `@nxgt/mongo-meilisearch`'s): a renewal that finds the key gone or another run's marks the lease lost and stops the beat, and `run` then rejects with `LEASE_LOST` without calling `COMPLETE`; one that fails to reach Redis is tried again at the next beat; the timer is stopped in a `finally`, and a renewal in flight at the stop reports nothing. So `lease` bounds a **crashed** run's hold, `retryAfter` is when a running key lapses *unless renewed*, and `LEASE_LOST` means the key was taken — `forget`, or no renewal reached Redis for a whole lease, which a synchronous `work` blocking the event loop causes too. **`wait`** (`lease/wait.ts`) polls `BEGIN` again, 25 ms doubling to 250 ms and never past `retryAfter` or the deadline, until done (replay), free (run `work`) or spent (`IN_PROGRESS`); `MISMATCH` and `INVALID` end it at once; a `wait` that is not a safe integer ≥ 0 is a bare `TypeError` quoting no value. The host's clock only paces the sleeps and the deadline — every decision is `BEGIN`'s. `INVALID` messages carry zod's issue **codes** only: measured on zod 4.6.5, `unrecognized_keys` quotes the stray key and a `z.record`'s keys go into the path |
| `@nxgt/redis-kit` | **deprecated, a thin re-export of `@nxgt/redis`**: its API moved into `@nxgt/redis` and was renamed (`connectKit` → `openRedis`, `defineConfig` → `defineRedis`, `RedisKit` → `Redis`, `KitOf` → `RedisOf`, `KitConfig`/`KitConfigInput` → `RedisConfig`/`RedisConfigInput`, `KitLockOptions` → `RedisLockOptions`). `src/index.ts` re-exports with `@deprecated` aliases for the old names, `src/index.spec.ts` asserts `connectKit === openRedis` and `defineConfig === defineRedis`, and there are no docs and no Redis in its specs. It holds no logic: change `@nxgt/redis`, never this |
| `@nxgt/s3` | S3 on Bun's own `S3Client`, with no AWS SDK: `defineBucket` naming the bucket, the key-building function, the content types and the maximum size, and `bindBucket` giving `put`/`bytes`/`text`/`exists`/`stat`/`delete`, a `list` in this repository's cursor shape, and `presignGet`/`presignPut`/`presignPost` from the same definition. The content type and the size are refused **before** the request goes out; `presignPost` signs an S3 POST policy itself (SigV4, `node:crypto` — Bun has no POST presigning), so the **service** holds a browser upload to a size range and a content type. Its error class for refusals is `S3Error`; it also throws a `TypeError` from `defineBucket` for a definition that could never work and from `presignPost` when its secret is not Bun's, and a plain `Error` from `presignPost` when the URL Bun signed cannot be read |

`examples/` holds applications, not packages: they are `private`, unscoped,
and the release scripts never see them — `publish.ts` and
`verify-artifacts.ts` (through `scripts/artifacts/packages.ts`) both glob
`packages/*/package.json`. They are workspace
members, so one `bun install` covers them and biome lints them, and the root
`typecheck` and `test` run theirs after the packages'. An example that no
longer compiles is a failure like any other: that is the whole point of
keeping them in the workspace.

| example | what it shows |
| --- | --- |
| `examples/hono-api` | a Hono API on `@nxgt/mongo`'s wiring, its routes generated from an OpenAPI spec by `@nxgt/openapi-codegen` (nxgt-http) and bound by `@nxgt/openapi-hono`. Laid out **by module**, not by layer: `src/modules/users/` holds `users.model.ts`, `users.service.ts` and `users.route.ts`, and a module **exports** its own `Hono` as `router` rather than being handed one — `src/api.ts` is the shared registry, `tag` bounds each module to its own operations, `src/modules/index.ts` is the one list of what is mounted, `src/middlewares/` holds what every request goes through, and `app.ts` only assembles the two. A service is a **class whose constructor takes the `Mongo`** (`AppMongo`, read from the configuration), the middleware builds one per request on `mongo.as(actor)` and puts them on the context, so a handler never reaches the root `Mongo`. Its write methods take the **validated body** the spec declares (`NewUser`, `NewArticle`, `UserPatch`, `ArticlePatch`), not the stored document, so a field the API does not offer cannot reach a write from a handler — `test/types/routes.ts` pins that. The environment is parsed once with zod in `src/env.ts`, its names declared in a root `bun.d.ts`, and read nowhere else; `src/index.ts` serves with `Bun.serve` on the parsed port. A `PATCH` whose `updatedAt`/`updatedBy` are the collection's, a transaction across two collections, `sync()` as a deployment step, and a spec beside each file it measures: every module has both a service spec, with no HTTP at all, and a route spec over a mongod in memory, and `app.spec.ts` keeps only what is left — the middleware, and that the mounted modules serve the whole spec. **`POST /articles` is guarded by `@nxgt/redis-guard`** (by `workspace:^`), on a Redis the app is handed beside the `Mongo` (`buildApp(mongo, redis, options)`, `REDIS_URL` in `src/env.ts`): `src/modules/articles/articles.guards.ts` defines a rate limit of five writes a minute and an idempotency of a day, **both keyed on the request's user** (the `actor` the services middleware puts on the context), bound **once per app** by `bindGuards` in `src/context.ts` and handed out by `provideGuards`. The route consumes the limit first — `RateLimit-*` headers on every answer from there, 429 with `Retry-After` on a denial, so a denied write takes no key — then runs the write under an optional `Idempotency-Key` with the **raw body** (`c.req.text()`, which Hono kept from the validator's read) as the fingerprint and a `wait` of 2 s: replay with `Idempotent-Replayed: true`, `MISMATCH` 422, `IN_PROGRESS` 409 with `Retry-After`, and any other error, `GuardError` or not, left to Hono's 500. The stored result is the API document, checked by the spec's own `zArticle`, `.nullable()` so a 404 replays as a 404. `articles.guards.spec.ts` measures it over HTTP against a real Redis (`test/redis.ts`, started from `$REDIS_BIN`, `FLUSHDB` before each test). Its 409 holds the first request inside `ArticleService.write` with a `spyOn` gate; `afterEach` opens the last gate, waits for every write still in flight and calls `mock.restore()`, so a failed assertion leaves no request holding a key with its heartbeat running. The wait spec lets the first write go only once the repeat has sent a **second** script on the key (a spy on the client's `evalsha`) — a poll, which only a waiting repeat sends — so it measures the wait on a loaded machine too. Four mutations were measured, each failing exactly one test, the last also 3/3 on 2 CPUs beside four busy loops: a fingerprint of the parsed body (`JSON.stringify(await c.req.json())`) fails the 422 spec on its re-spaced body; every other `GuardError` code answered 409 fails the `INVALID` → 500 spec; `(error as GuardError).code` in place of `instanceof` fails the spec whose write throws a plain `Error` with `code: 'MISMATCH'`; and `wait: 0` fails the wait spec |
| `examples/mongo-backup-job` | a scheduled MongoDB backup in about twenty lines on `@nxgt/mongo-backup`'s `mongoBackups` (`src/backups.ts`, `src/index.ts`): `run` hourly, `drill` daily, the environment naming the database, the repository folder and the key file. It once held the job written by hand — about 200 lines of `kindFor`, the `HISTORY_LOST` fallback, `verify`, `prune` and three secrets — which is what showed that logic belonged in the package. Its spec runs two runs and a drill against a memory replica set (`test/mongo.ts`, a seventh copy of the mongod pin) |

It was started on 2026-09-15, on the tooling of `softistx/nxgt-http`: the
same build, artifact check, publish script, CI and conventions. When one of
them changes there for a reason that applies here, change it here too.

## Layering

Every package is **standalone**: it depends on no sibling, only on the
library it wraps, as a peer — except the two bridges, `@nxgt/mongo-search-kit` and the
deprecated `@nxgt/redis-kit` and `@nxgt/mongo-kit` below, which peer on the siblings they join or wire. A package that would use a sibling declares it
by `workspace:^` and imports it by its published name, as in nxgt-http; there
is no tsconfig `paths` to a sibling and no relative import into one.

- `@nxgt/drizzle` has `drizzle-orm` as a peer, `>=1.0.0-rc.4 <2`, and as a
  devDependency pinned exactly (`1.0.0-rc.4`): Drizzle 1.0 is a release
  candidate, and its types move between RCs. Raise both together, after
  reading the new `.d.ts`: 1.0 changed the relational queries, the column
  types and some imports from 0.x. `@electric-sql/pglite` is a
  devDependency: the specs run a real PostgreSQL in process, with no Docker.
- `@nxgt/meilisearch` has `meilisearch`, the official SDK, as a peer,
  `>=0.62.0 <1`, and as a devDependency pinned exactly (`0.62.0`): a 0.x
  SDK may break its types in a minor. Raise both together, after reading its
  `indexes.d.ts` and `types/types.d.ts`, where `Settings` and `SearchParams`
  live, and `token.d.ts`: `tenantToken` imports `generateTenantToken` from
  the SDK's `meilisearch/token` subpath, which the peer range must keep. `src/token/rules.ts` copies a rule's keys by name — `filter` only, the one key of `TokenIndexRules` in 0.62.0 — so a new key there is refused until it is added.
  The SDK's errors reach the caller as they are — except inside a
  `REBUILD_FAILED`, which carries the one that stopped a rebuild as its
  `cause`; the package's only error of its own is `SearchIndexError`.
- **`@nxgt/mongo/migrations` and `@nxgt/mongo/gridfs` are subpaths** of
  `@nxgt/mongo`, not packages: both reuse its coercion, its `withTransaction`
  and its errors, and version with it. `src/migrations/` and `src/gridfs/`
  import the rest of the package; nothing imports `src/migrations/`, and
  `src/gridfs/` is imported by `src/wiring/` alone, for the buckets
  `openMongo` wires. The root entry therefore reaches `src/gridfs/` through
  the wiring's types and values, but **exports no bucket name**: those stay on
  the subpath.
- **A dialect is a subpath**, not a package: `@nxgt/drizzle/pg` today,
  `./mysql` and `./sqlite` later. What does not depend on a dialect, the
  errors, the cursor and the page shapes, is in `@nxgt/drizzle` itself, and
  every dialect throws those same classes.
- `@nxgt/mongo` has two peers, both required: `mongodb` `>=7.0.0 <8` and
  `zod` `>=4.6.5 <5`, pinned exactly as devDependencies (`7.6.0`, `4.6.5`).
  Zod is not an implementation detail there: the schema an application writes
  is the package's input, so the application's copy has to be the one the
  package parses with. Raise them together, after reading `mongodb.d.ts`,
  where `Filter`, `UpdateFilter` and `IndexDescription` live.
  `mongodb-memory-server-core` is a devDependency, and it depends on
  `mongodb ^7.2.0`: keep the pin inside that range, or the tree carries two
  drivers and two `ObjectId` classes, which no `instanceof` survives.
- **`@nxgt/mongo-search-kit` is built on siblings**: a package over siblings
  is a package of its own, never an import from one into another. It peers on
  four siblings at once and none of them knows it. (It was one of two kits;
  the other, `@nxgt/mongo-kit`, is folded into `@nxgt/mongo`, below, and
  `@nxgt/mongo-search-kit` still imports its type names from the deprecated
  re-export until it is folded in turn.)
- **`@nxgt/mongo`'s wiring is part of the package**, as `@nxgt/redis`'s is.
  It lived in `@nxgt/mongo-kit`, a package over `@nxgt/mongo`, and was folded
  in at 0.19.0 because it was never useful without it. It sits in
  `packages/mongo/src/wiring/` and **imports the package's own modules by
  relative path, never `@nxgt/mongo` or `@nxgt/mongo/gridfs`**: those names
  resolve to `dist/` and would give a second copy of every class.
  `@nxgt/mongo-kit` is now a deprecated re-export whose peers are
  `@nxgt/mongo` (by `workspace:^`) and `typescript`, and `@nxgt/mongo` knows
  nothing of it.
- **`@nxgt/redis`'s wiring is not a kit any more: it is part of the package.**
  It lived in `@nxgt/redis-kit`, a package over `@nxgt/redis`, and was folded
  in at 0.4.0 because it was never useful without it. It sits in
  `packages/redis/src/wiring/` and **imports the package's own modules by
  relative path, never `@nxgt/redis`**: that name resolves to `dist/` and
  would give a second copy of every class. `@nxgt/redis-kit` is now a
  deprecated re-export whose peers are `@nxgt/redis` (by `workspace:^`) and
  `typescript` — `zod` comes with `@nxgt/redis` — and `@nxgt/redis` knows
  nothing of it.
- **Two packages are bridges**, and both are the same shape.
  `@nxgt/mongo-meilisearch` has `@nxgt/mongo` and `@nxgt/meilisearch` as
  required peers, by `workspace:^`, and as devDependencies, the same way;
  `mongodb` and `meilisearch` are peers with their siblings' ranges and pins.
  `@nxgt/drizzle-meilisearch` is the same over `@nxgt/drizzle` and
  `@nxgt/meilisearch`, carrying `drizzle-orm` and `meilisearch`. No sibling
  knows either of them: a bridge between two packages is a third package,
  never an import from one into the other. `bun publish` turns `workspace:^`
  into `^<current version>`, and changesets gives a bridge a **patch** when a
  sibling it peers on takes a minor (measured with changesets 3.0.3), so it
  is republished with the new range.
- **Another database library is another package**, and each keeps its own
  errors, as every package here does.
- **`@nxgt/backup` is standalone, and `age-encryption` is a dependency, not a
  peer** (`~0.3.1`, BSD-3-Clause, Filippo Valsorda's typage): a caller never
  hands it an age object, only key strings, so there is no second copy whose
  classes could disagree — the reason the drivers here are peers does not
  apply. Its range is a tilde because a 0.x may break in a minor. The format
  is age's and zstd's on purpose: a backup opens without this package
  (`age -d` then `zstd -d`), and a format only this code reads would be a
  trap on the day it is needed. Bun-only, like `@nxgt/redis` and `@nxgt/s3`:
  zstd is Bun's `CompressionStream('zstd')`, hashing `Bun.CryptoHasher`. The
  sources for databases are separate packages, never an import into
  `@nxgt/backup`.
- **`@nxgt/mongo-backup` peers on `@nxgt/backup` and `mongodb`, not on
  `@nxgt/mongo`.** `@nxgt/backup` is a required peer by `workspace:^` and a
  devDependency the same way; `mongodb` is a peer with
  `@nxgt/mongo-meilisearch`'s range and pin. A backup takes a whole
  database from the driver's `Db` and needs nothing of a collection's schema,
  so an application on the plain driver can use it, and `@nxgt/mongo` knows
  nothing of it. `age-encryption` is a dependency (`~0.3.1`, `@nxgt/backup`'s
  range), not a peer: `mongoBackups` and `keygen` make and read an age
  identity, and a caller hands it only strings, so a second copy has no
  class to clash with. Neither `@nxgt/backup` nor any other sibling knows it.
- **`@nxgt/redis-guard` is standalone, not a kit.** It is about the same
  server as `@nxgt/redis` and takes the same `RedisClient`, but depends on
  no sibling, not even as a devDependency: a caller on both hands it
  `connection.client`. Its keys are `<name>:<key(params)>`, joined as
  `bindCache` joins them, so the two naming schemes agree without sharing a
  line of code. Wiring its limits beside `openRedis` is on its roadmap; it
  would be a new package peering on both, since `@nxgt/redis` stays
  standalone — never `@nxgt/redis` on it, nor the other way round.

**There are no cycles and there must not be one**, devDependencies included.

## The build

Every package is built by the root `build.ts`, as `bun run ../../build.ts`:

- **JavaScript**, from `Bun.build` with `packages: 'external'` and
  `splitting: true`. A library never bundles its dependencies: a copy of
  `drizzle-orm` would give an app two `SQL` classes, and an `is()` that fails
  for one. Splitting puts what two entry points share in a chunk both
  import: without it, `@nxgt/drizzle/pg` would throw its own copy of
  `NotFoundError`, which an `instanceof` against the one from
  `@nxgt/drizzle` rejects.
- **Declarations**, from `tsc --emitDeclarationOnly` against
  `tsconfig.build.json`, which excludes `*.spec.ts` and `test/`.

Entry points are declared under `nxgt.entrypoints`, and each one needs a
matching key in `exports` — except a `bin` target (`@nxgt/mongo-backup`'s
`src/cli.ts`), which is run, not imported: it has no `exports` key, and
`verify:artifacts` runs it with `--help` instead.

- **`export * from '<external package>'` only in an entry point.** Below one,
  Bun emits a re-export of an undeclared variable, and the built file throws
  at import while `bun run build` exits 0.
- **A build that exits 0 is not evidence the artifact loads.**
  `bun run verify:artifacts` packs every package, installs the tarballs as a
  consumer does, imports every subpath in `exports`, runs every bin with
  `--help`, and rejects a manifest that would break an install: a `link:` or
  `file:` in a field a consumer resolves, a **required** peer on no registry,
  a sibling range that leaves out the sibling released beside it, an exact pin
  on a sibling, or a package that is not MIT or ships no `LICENSE`. It fails
  a `files` entry the tarball holds nothing under, with
  `<package>: files lists <entry>, which the tarball does not hold` — npm
  skips such an entry without a word, and every package here lists `dist`
  and `docs`. It also fails a tarball that ships test code — a `*.spec.*`,
  a `*.test.*`, a snapshot, or a `<subject>.fixtures.*`, with
  `<package>: the tarball ships test code: <path>`. A plain `fixtures.*`
  passes: the dotted prefix is what marks the fixtures specs share. Each
  `tsconfig.build.json` excludes only `test/` and `**/*.spec.ts`, and no
  package holds any of the other kinds today, so the build emits none of
  it; this check is what holds that. It refuses a scoped package without
  `publishConfig.access: "public"` (`<package>: publishConfig.access is not
  "public"; …`): `scripts/publish.ts` runs `bun publish`, which never reads
  the changeset config's `access`, and npm publishes a scoped package as
  restricted by default. And once the tarballs are installed, it reads
  every built import, the `.js` through Bun's own scanner and the `.d.ts`
  through `declarations.ts`, since a declaration file's imports are
  type-only and Bun's scanner drops those. It fails one that names a package
  the manifest does not declare in `dependencies`, `peerDependencies` or
  `optionalDependencies` (`<package>: dist/<file> imports "<specifier>"`):
  the install holds every sibling side by side, so an import of a sibling a
  package lists only as a devDependency, as every kit and bridge here lists
  its siblings for its specs, loads there and fails for a consumer who
  installs that package alone. Only literal specifiers are read. A bin's
  `#!` line is skipped first, since Bun's scanner refuses it as a syntax
  error (softistx/alxia#79). Last, it emits the declarations of each
  package's `test/declarations/*.ts` against the install, under a
  consumer's strict settings with this repository's `@types/bun`
  (`emit.ts`): an exported value whose inferred type holds a type the entry
  does not export fails with TS2883 ("cannot be named without a reference
  to …"), and nowhere else: inside the workspace a package resolves to its
  own folder through a symlink, so tsc names the type by a relative path,
  even with the declaration build on. `mongo`'s fixture (`test/declarations/mongo.ts`)
  covers the collections, a bucket, the config, a `Mongo` of one database and of two,
  `as`, `transaction` and `sync`; `redis-guard`'s the rate limit and
  idempotency, defined and bound to Bun's `RedisClient`. A builder whose
  type an app exports gets a case there. The folder is typechecked with its
  package and never built or shipped.
  `changeset:publish` runs it, so a release cannot skip it.
  `scripts/verify-artifacts.ts` only runs the stages in order and stops at
  the first that fails; each lives in `scripts/artifacts/`, one module per
  responsibility, with a spec beside each pure one: `packages.ts` reads the
  workspace, `tarball.ts` a tarball's entries, `manifest.ts` its dependency
  fields, `registry.ts` asks npm, then `stale.ts`, `install.ts`, `load.ts`,
  `classes.ts`, `imports.ts`, which `declarations.ts` serves, and
  `emit.ts`. An unbuilt package stops at the first stage with
  `<package>: no dist/` and a hint to run `bun run build`: `stale.ts` checks
  the folder exists before scanning it, because `Bun.Glob().scan` throws
  `ENOENT` on a missing one (measured on bun 1.4.2).
- **Build before typecheck and tests.** CI builds first. `bun run build`,
  `typecheck` and `test` run the packages through `scripts/workspace.ts`,
  alxia's, which starts a package only once every sibling it names in any
  dependency field has finished, and the ones of one wave in parallel:
  `bun run --filter` started dependents beside their dependencies on a clean
  checkout in alxia. Three waves here: the standalone packages, then the two
  bridges, the deprecated `@nxgt/mongo-kit` and `@nxgt/redis-kit`, and `@nxgt/mongo-backup`
  (after `@nxgt/backup`), then `@nxgt/mongo-search-kit`. The examples run after them, with
  `--filter './examples/*'`.
- **CI's "Newest peers" job tests the other end of every peer range.** The
  CI job runs the lockfile: the exact version each package pins as a
  devDependency, the oldest its range accepts. `scripts/newest-peers.ts`,
  after alxia's, rewrites every manifest that installs a peer to the
  newest end of the range: the last alternative of an `a || b` range, as
  in alxia, or else the range itself — `mongodb` `>=7.0.0 <8`, `zod`
  `>=4.6.5 <5`, `meilisearch` `>=0.62.0 <1`, `drizzle-orm`
  `>=1.0.0-rc.4 <2`, `typescript` `^6.0.3`. The job then deletes `bun.lock`,
  whose versions satisfy those ranges, installs, and builds, typechecks,
  tests and verifies the artifacts. Every manifest gets the same range: the
  packages', the examples' (including their `dependencies`) and the root's
  `devDependencies` and `overrides`. One range is one version in the tree,
  and two `mongodb`s would be two `ObjectId` classes. A peer that nobody
  installs fails the script, and so do two packages that disagree on a
  range. The job is informational, as alxia's is: an upstream release can
  turn it red with no change here, so read it, and do not make it a
  required check.
- **CI lints with the Biome `bun.lock` resolved**: `bunx biome ci`, the
  version `bun run check` runs locally, and the one `biome.json`'s `$schema`
  names. Not `biomejs/setup-biome` with `latest`, which linted
  CI with a newer Biome than anyone ran locally. Raising Biome is a lock bump
  that moves the `$schema` with it: 2.5.15 today, as alxia's. `biome.json`
  is alxia's too. Beyond the recommended rules it turns
  `noConfusingVoidType` off — a before hook returns
  `Awaitable<Args | undefined | void>`, the one shape that accepts a hook
  declared elsewhere and passed by name, measured, in `@nxgt/mongo`'s
  `collection/hooks/types.ts` — `useLiteralKeys` off, since it would turn the
  bracket reads `noPropertyAccessFromIndexSignature` asks for back into dots,
  and `noBannedTypes` up to an error; the two `{}` that mean "adds no field"
  in `@nxgt/mongo`'s `definition/stamps.ts` carry their own `biome-ignore`.
- **Every job has a `timeout-minutes`**, sized at two to three times the
  slowest run measured: 25 for CI, whose 60 runs up to 2026-09-27 took 6½ to
  9¾ minutes, and 20 for the release, whose took 3 to 7. Past it a run is
  hung, and the six-hour default holds the runner for nothing; the weekly
  `nxgt versions` job has 5, as nxgt-janus's does. `ci.yml` has
  a `concurrency` group, nxgt-janus's: a pull request's new push cancels its
  run in progress, and a push to `develop` never does — each is in a group of
  its own, by run id, because that run writes the caches every pull request
  reads. The release has no cancelling group, since a publish killed half-way
  is worse than one waited on.

- **`@nxgt/redis` has no client dependency at all.** `RedisClient` is Bun's
  own, which is what makes the package Bun-only and why it declares no driver
  peer — the one place in this repository where the "peers and pins move
  together" rule has nothing to pair. Its `zod` peer `>=4.6.5 <5` and its
  exact `4.6.5` pin move with `@nxgt/mongo`'s: raise them together or the
  workspace holds two zods. Read Bun's `redis.d.ts` before using a command,
  not the Redis manual: the client covers a subset, and has no `multi`/`exec`.
- **`@nxgt/redis-guard` has no client dependency either**: it takes Bun's
  `RedisClient` as `bindCache` does and imports nothing from `@nxgt/redis`.
  Since 0.2.0 it has `zod` as a required peer, `>=4.6.5 <5`, pinned exactly as
  a devDependency (`4.6.5`) — `@nxgt/redis`'s range and version, raised with
  it and with `@nxgt/mongo`'s — because an idempotent result is checked
  against the caller's schema both ways, so the caller's zod must be the one
  it parses with. A rate limit parses nothing, but a peer cannot be required
  for one export and not another. What stands in for `multi`/`exec` is a
  script: `src/scripts/run-script.ts` sends `EVALSHA` and falls back to
  `EVAL` on `NOSCRIPT` — which Bun surfaces, measured on bun 1.4.2 against
  Redis 7.4.1, as an `Error` named `RedisError` whose `code` is the generic
  `ERR_REDIS_SERVER_ERROR` every server error carries, so the reply's own
  text (`NOSCRIPT No matching script. Please use EVAL.`) is the only thing to
  tell it by.

## TypeScript

`tsconfig.base.json` is alxia's: the owner chose one skeleton for alxia,
nxgt-http and nxgt-data on 2026-10-02, the strictest of the three. It is
strict past `strict` — `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`,
`noImplicitAny`, `noImplicitOverride`, `noImplicitReturns`,
`noUnusedLocals`, `noUnusedParameters`, `useDefineForClassFields` — and has
no `allowJs`, no decorators and no `strictPropertyInitialization: false`:
nothing here is JavaScript or uses a decorator. An application's own
tsconfig may hold any of these, so the published declarations must compile
under all of them; a package's `tsconfig.json` turns no check on or off.

- **A key off an index signature is read with brackets**: `env['PORT']`,
  `document['_id']`, `options['withDeleted']`. That is what
  `noPropertyAccessFromIndexSignature` asks for, and why Biome's
  `useLiteralKeys` is off.
- **An option a caller is likely to hold as a maybe-missing value, and whose
  `undefined` the package treats as left out, is typed `?: T | undefined`**,
  so a caller under `exactOptionalPropertyTypes` can pass it as it is. So far:
  `page`, `pageSize`, `withDeleted`, a collection's and a bucket's `session`,
  `startAfter`, a file listing's `after`, a bucket's `contentType`, a
  presigned URL's `expiresIn`, `@nxgt/redis`'s wiring `prefix`, `@nxgt/meilisearch`'s
  `settings`, `dryRun` and `wait`, a patch's fields in `@nxgt/mongo`, and the
  key in `@nxgt/drizzle`'s patch, which is dropped. The other options are
  still `?: T`, stricter than the run time; widen one when it is met. One the
  run time refuses stays `?: never`, which that setting then refuses at
  compile time too: `@nxgt/mongo`'s `_id`. A third party's options, the
  driver's or Bun's, are given only the keys that have a value
  (`session ? { session } : {}`), and `@nxgt/mongo`'s README has that as a
  trap.
- **`useDefineForClassFields` is an emit setting, not a check**: `Bun.build`
  reads it, so a class field is defined as JavaScript defines it, an own
  property from construction, in declaration order. A field the constructor
  sets only sometimes is written `declare` — `GuardError.retryAfter` — or it
  would be there as `undefined` when it was not given.
- **What a type does without `exactOptionalPropertyTypes`**, as most
  consumers compile, is pinned apart: `packages/mongo/test/types/without-exact/`
  holds the `_id: undefined` gap, under a tsconfig of its own that turns the
  setting off, and the package's `typecheck` runs it after the strict one.
  It is the one place a flag is looser, and only for that pin.
- `scripts/tsconfig.json` relaxes two, as alxia's does:
  `noPropertyAccessFromIndexSignature` and `exactOptionalPropertyTypes`. The
  repository scripts read manifests and the environment, whose keys are
  open, and are copied from nxgt-http as they are.

## Tests

- **Specs run against PostgreSQL, not a mock**: PGlite, in memory, one per
  spec file (`test/db.ts`), emptied between tests. The DDL is plain SQL in
  `test/schema.ts`, next to the Drizzle tables, with named constraints the
  specs assert on. No drizzle-kit.
- **`@nxgt/meilisearch`'s specs run against a real Meilisearch**, not a mock
  and not Docker: the official binary, from the GitHub releases of
  meilisearch/meilisearch, pinned in `scripts/meilisearch.ts`
  (`MEILISEARCH_VERSION`, v1.53.2 today). The script downloads it for the
  platform (linux amd64/aarch64, macOS Apple silicon) into the git-ignored
  `.cache/meilisearch/<version>/meilisearch`, and prints its path; the
  package's `test` script runs it first. `$MEILISEARCH_BIN` names another
  binary, for Intel macOS, which v1.53 no longer ships a community build
  for. The tenant token's refusals are the exception, with no server at all — `src/token/rules.spec.ts`, `rule-shape.spec.ts`, `uid.spec.ts` and `expiry.spec.ts`: nothing is sent, and a token is decoded rather than used — and so is `src/definition/define-index.spec.ts`, whose uid refusals send nothing; `bind-index.spec.ts` checks the server refuses each of those uids too. `test/server.ts` starts one server per spec file, on a free port,
  with a temporary `--db-path` and a master key, waits for `/health`, and
  kills it in `afterAll`; `reset` deletes every index between tests. CI
  caches `.cache/meilisearch`, keyed on the hash of the script, so raising
  the version there re-downloads.
- **`@nxgt/mongo`'s specs run against a real mongod**, started by
  `mongodb-memory-server-core` as a **single-node replica set**: transactions
  need one, and a standalone mongod refuses to start one. The version is
  pinned in `test/server.ts` (`MONGOD_VERSION`, 8.2.6 today), and the binary
  is downloaded on the first start into the git-ignored `.cache/mongodb`,
  which CI caches keyed on the hash of that file. `-core` rather than
  `mongodb-memory-server`: the wrapper's `postinstall` downloads 120 MB during
  every `bun install`. On Arch and Manjaro the library falls back to the
  Ubuntu 22.04 build on its own; keep mongod at 6.0 or above, because the
  older fallback wants `libcrypto.so.1.1`, which a current distribution no
  longer ships.
- **`@nxgt/mongo-backup`'s specs run against mongod alone**: its `test/`
  holds a copy of `@nxgt/mongo`'s server (`mongo.ts`) and of
  `test/rejection.ts`, and `test/fixtures.ts` binds a local repository in a
  fresh folder with a fresh age key — `age-encryption` is a devDependency
  for that alone. The specs are `full`, `incremental`, `consistency` (the
  catalog bracket, renames, collections the changes create), `follow` (the
  collections a chain follows), `refusals`, `wiring` (options and malformed
  entries), `restore` and `restore-refusals` (`restoreCollections`, `chain` in `test/restore.ts`; a `Db` proxy whose listing
  sees nothing stands for a name taken between the check and the move),
  and with no server `format/format` and `source/followed`. A write *during* a backup is made by
  wrapping the source's `entries` (`during` in `consistency.spec.ts`); a
  lost history and a snapshot too old are a `failNext` on `aggregate` (286)
  and on `find` (239), since a fresh oplog is never truncated; the bracket's
  retries come from a `Db` proxy whose every listing creates a collection.
  `--timeout 30000` like the other mongod packages.
- **`@nxgt/mongo-meilisearch`'s specs run against both**: its `test/`
  holds a copy of each sibling's server (`mongo.ts`, `meilisearch.ts`), and
  `test/fixtures.ts` starts one of each per spec file. Its specs are
  `create-search-sync` (the options and errors, no server), `reindex`,
  `follow` and `lease` — the last makes a second process by creating a
  second sync under the same name, and steals a lease by rewriting its
  holder. Its `test` script
  downloads Meilisearch first, as `@nxgt/meilisearch`'s does, and passes
  `--timeout 30000`: Meilisearch takes about half a second to apply each
  write, measured, so a test that writes a few batches outlasts Bun's 5 s.
- **`@nxgt/drizzle-meilisearch`'s specs run against both too**: PGlite in
  process (`test/db.ts`, with its own one-table `test/schema.ts`) and the
  fourth copy of the Meilisearch server (`test/meilisearch.ts`), one of each
  per spec file. Its specs are `create-search-sync` (the options and the
  refusals, no server at all — `createSearchSync` does no I/O, so a
  repository and an index that are only their shapes are enough), `reindex`
  and `write`. Same `--timeout 30000`, for the same reason.
- **`@nxgt/mongo`'s wiring specs** (`src/wiring/`) use `test/wiring.ts`, which
  builds on the package's own `test/server.ts`: `useMongo` starts one mongod
  per spec file and closes the `Mongo`s a file opened (`track`) — `connectMongo`
  shares a client per URI, so one a test left open keeps the server alive.
  `close.spec.ts` is on its own for that reason — it measures what closing
  gives back, which only holds when nothing else holds the client.
  `test/wiring/models/` and `test/wiring/models-clash/` are the files
  `discoverCollections` globs. `@nxgt/mongo-kit` has no server and no mongod:
  its one spec compares values.
- **`@nxgt/mongo-search-kit`'s specs** hold the fifth mongod copy and a
  second Meilisearch one (`test/mongo.ts`, `test/meilisearch.ts`), and
  `test/fixtures.ts` starts one of each plus **one kit** (a `MongoKit` from the
  deprecated re-export) per spec file. `beforeEach` drops both databases and then calls `kit.sync()`: the
  drop takes the collections with it, and `autoSync` runs once per
  collection per process, so nothing would recreate them. Its `test` script
  downloads Meilisearch and passes `--timeout 30000`, for the same measured
  reason as the bridge's. Two of its specs are regression specs with no
  assertion of their own shape: one fails by **killing the run** if a
  sync's `closed` stops being taken as it starts, and one pins that
  `close()` still throws a second sync's failure once `failed` is spent.

- **`@nxgt/redis`'s specs run against a real Redis**, one per spec file,
  emptied before each test. There is **nothing to download**: neither
  redis/redis nor valkey publishes a prebuilt binary, so `redis-memory-server`
  fetches the source and **compiles** it. What that costs is measured and
  written down in one place, `packages/redis/test/server.ts`; do not repeat
  the numbers here. That is why `scripts/redis.ts` exists and the package's `test` script runs it first,
  the way `@nxgt/meilisearch`'s runs `scripts/meilisearch.ts`: that build does
  not belong inside a test's timeout. The script holds no logic of its own —
  `redisBinary` lives beside the server that starts it — and
  `scripts/redis.spec.ts` covers its `$REDIS_BIN` branch. The root `test` script runs it
  once **before** the parallel suites: two packages start a Redis (three before `@nxgt/redis-kit` was folded in), and on a
  cold cache their builds into one directory broke each other on CI. `$REDIS_BIN` names a `redis-server` to
  use instead. CI caches `.cache/redis`, keyed on **both** copies of
  `test/server.ts` — `@nxgt/redis`'s and `@nxgt/redis-guard`'s — and the script. `examples/hono-api` starts a Redis
  too, but carries **no copy**: its `test` script runs `scripts/redis.ts` and
  passes the path it prints as `$REDIS_BIN`, and its `test/redis.ts` only
  starts that binary (refusing to run without it), so it pins no
  `REDIS_VERSION`, has no cache path, and is not in the CI key. `@nxgt/redis`'s `test/fixtures.ts` calls `closeRedis()` before stopping the server,
  because `connectRedis` shares a client per URI and a connection a test left
  open would outlive it.
  **`bun install` builds no Redis in CI**: `redis-memory-server` is on Bun's
  default trusted list, so its postinstall compiles the *latest* Redis into
  `node_modules/.cache` — a binary no spec runs, since `scripts/redis.ts`
  builds the pinned one into `.cache/redis`. The setup action sets
  `REDISMS_DISABLE_POSTINSTALL=1`, as nxgt-janus's does
  (softistx/nxgt-janus#91): the install step took 226 s without it on
  develop's last run before. Locally, `REDISMS_DISABLE_POSTINSTALL=1 bun
  install` saves the same minutes; a plain `bun install` still works.

- **`@nxgt/redis-guard`'s specs run against a real Redis** too, from the
  third copy of the server (`test/server.ts`), one per spec file, emptied
  before each test; the package opens no client of its own, so its
  `test/fixtures.ts` closes the server's, and the two a spec opens with
  `useClients` for a second process's connection. Its specs are
  `define-rate-limit` (the refusals, no server), `rate-limit` (everything a
  bound limit answers), `concurrency` — 50 consumes at once over **two**
  `RedisClient`s allow exactly the burst; one client alone pipelines its
  commands in order, and would let a check that is not atomic pass — `clock`,
  which moves the host's clock a day either way with `setSystemTime` and
  expects the same answers, `fixed-now` — the script with `now` from ARGV
  (`GCRA_AT_ARGV`, which `src/index.ts` does not export), so a burst taken
  one request at a time at one instant must allow **exactly** the burst over
  thirteen awkward rates, and a refill lands on the exact microsecond —
  `rounding` — fractional intervals against real time: a whole burst from a
  full bucket, `remaining` against the decision over six rates, and the
  stored state draining by exactly `limit` ticks a microsecond — and
  `stored-state` — values the script could not have written read as a full
  bucket, within 100 ms and a 1 s test timeout, and a clock that moves back:
  two clocks a second apart, alternating, allow exactly the burst; a key of
  another type fails `consume` and `peek` with Redis's `WRONGTYPE`, and
  `reset` deletes it — and
  `scripts/run-script` (`SCRIPT FLUSH`, then the `EVAL` fallback).
  Idempotency has eight, in `src/idempotency/` and its `lease/`: `define-idempotency` (the
  refusals, no server), `idempotency` (the first run and the replay counted,
  `replayed`, defaults from the output schema on both, a thrown error
  released and passed through as the same object, a union failure replayed,
  `ttl` and `lease` read back through `TTL`/`PTTL`, `forget`, `INVALID` on
  write and on replay, and that no message carries the key, the fingerprint
  or the value), `fingerprint` (`MISMATCH` both ways, `''` against none, a
  `DataView` cut from a larger buffer hashing like the text), `in-progress`
  — over **two** `RedisClient`s, as `concurrency` is: `IN_PROGRESS` with a
  `retryAfter`, `MISMATCH` while the first still runs, twenty runs at once
  calling `work` exactly once — `stored-state`, a hash per way a record
  can be one `run` did not write, each `INVALID` with the record kept and
  `work` not called, plus `WRONGTYPE` — and in `lease/`: `heartbeat` (work
  three times its lease runs once, a repeat meanwhile `IN_PROGRESS` then
  the replay; the renewals stop after a success, a throw and `LEASE_LOST`,
  read from `INFO commandstats` staying still over six beats, with the done
  `TTL` or the key gone; a **process of its own**, `test/exit.ts`, spawned
  with `process.execPath`, that must exit by itself after all three — with
  a 3 s lease, so no beat fires during a 100 ms run and a timer left behind
  first fires after `client.close()`, fails, and is retried for ever; a
  renewal **cut off from Redis** and retried — the second client pauses
  writes (`CLIENT PAUSE 700 WRITE`) so the first beat's `RENEW` is held on
  the server, then `CLIENT KILL`s the run's connection, which fails that
  renewal with `Connection closed` (5/5 measured on bun 1.4.2, Redis
  7.4.1; Bun reconnects in about 50 ms and queues, so a renewal sent after
  the kill never fails), and the next beat must renew before the 1.5 s
  lease lapses; and synchronous work blocking the event loop past a 30 ms
  lease losing it — the one real lapse left), `lost` —
  the key taken mid-run by `forget`, by a foreign token a second client
  writes, or by a second client's `DEL` and run: `LEASE_LOST`, and the other
  holder's record and `PTTL` untouched, its result the one that replays, and
  a late failure unable to release it — and `wait` (a replay, a release
  followed by running `work`, a deadline spent, `MISMATCH` at once, and
  `MISMATCH`/`INVALID` found mid-wait; its refusals). Its deadline spec
  waits 400 ms: after pauses of 25, 50, 100 and 200 ms, 25 are left and the
  next pause would be 250, so a last sleep not capped at what is left ends
  near 625 ms where the capped one ends near 400; it bounds the wait below
  550 ms, and lets both runs settle before asserting, so a waiter still
  polling cannot take the next test's key. A lease that renews
  cannot be lost by waiting, so the lost-lease specs **take** the key
  rather than wait for a lapse. Three mutations were measured, each failing
  exactly one test: `COMPLETE` without its token check (the take-over spec),
  `BEGIN` comparing the fingerprint only once done (`MISMATCH` while
  running), and `RELEASE` without its token check (the late-failure spec).
  Six more with the heartbeat and `wait`, each measured over at least two
  full runs: `RENEW` without its token check fails two of `lost`'s (the
  foreign token's `PTTL`, and the take-over's), 2/2; `stop()` without its
  `clearInterval` fails four of `heartbeat`'s — the three commandstats
  specs and the process that no longer exits — 2/2; **never calling
  `stop()`** fails the exit spec 5/5, and one or two of the commandstats
  specs only sometimes (1, 1, 0, 2, 0 of them over five runs): a stray
  beat that finds the key done or gone clears its own timer, and may do it
  before the baseline is read — the exit spec is the one that pins it, and
  only since its lease became 3 s (with 30 ms it never failed, and the
  suite failed 2, 0, 2, 0 in review); a renewal that fails to reach Redis
  counted as lost fails exactly the cut-off spec, 5/5; `wait` ignoring its
  deadline once it is above 0 fails exactly the deadline spec, which races
  the waiter against 1.5 s so a wait that never ends fails that test alone,
  5/5; and the last sleep not capped at what is left of `wait` fails
  exactly the deadline spec (about 635 ms against 550), 5/5. The three
  `lease/` files took the package's suite from **2.2 s to 7.35-7.45 s**
  over three runs, nearly all of it their own waits — the cut-off spec
  1.7 s, the work three leases long 0.9 s — not the three extra servers.
  A fourth, found in review: returning the first parse rather than the
  parse-back from JSON passed all 47 tests then; the spec with
  `z.number().transform((n) => n + 1)`, not a fixed point, now fails on it
  (the first caller got 2, the replay 3). A script
  that never returns cannot be rescued inside a spec file: measured, the test
  fails on its timeout, a `SCRIPT KILL` from another connection does free
  Redis, but Bun kills the file's redis-server as a dangling process at that
  timeout, so every later test in the file fails too — read the first
  failure. Six mutations were measured: `now` sent from the host fails the clock spec (4
  where 3 was expected); a check split into a read and a separate write fails
  the race (25 to 35 allowed out of 50, not 5); the previous float-TAT script
  fails three of `fixed-now`'s four tests; without the
  `MAX_SAFE_INTEGER` check its spec in `define-rate-limit` fails; writing
  `base = now` again lets the alternating clocks allow 50, not 10; and
  without the tolerance check, with the correction loops unbounded, the
  stored-state spec times out at 1000 ms instead of hanging the run.
  Every rejection is held with `test/rejection.ts`, a copy of
  `@nxgt/mongo`'s.

- **`@nxgt/s3`'s specs — and `@nxgt/backup`'s `s3.spec.ts`, through its
  copy of the server — run against a real S3 API**, one SeaweedFS per spec
  file: `weed server -s3`, from the binary `scripts/seaweedfs.ts` downloads
  into `.cache/seaweedfs`. **Not MinIO** — measured 2026-09-18, `dl.min.io`
  answers `410 Gone` and the project is archived, so nothing in any repository
  should plan around it. Five things about SeaweedFS were measured here and
  every one of them is a line in `test/server.ts`: `-dir` must already exist,
  or it dies; 4.47 starts an **Iceberg** catalog on a fixed 8181 and a
  **Lance** namespace on a fixed 9101, either of which kills the process when
  a second spec file starts, so both are `=0`; each service listens **twice**,
  and its gRPC port defaults to its own `+10000`, so either name it —
  `-master.port.grpc` and the three others, which is what `test/server.ts`
  does — or keep that neighbour free; and each bucket is a *collection*
  needing a volume,
  which the production defaults (8 volumes of 30 GB) cannot allocate — hence
  `-master.volumeSizeLimitMB=64 -volume.max=100`. **Its log goes to a file,
  never a pipe**: SeaweedFS fills a 64 KB pipe buffer in under a minute, and a
  pipe nobody drains blocks the process writing to it. **It is stopped with
  `SIGKILL`**: measured on 4.47, `weed server` takes **20 s** to exit on
  SIGTERM *or* SIGINT — 20078 / 20024 ms and 20015 / 20102 ms over two runs
  each — and **11 ms** on SIGKILL. That is a fixed grace period, not a flush,
  and the directory it writes into is removed on the next line. It was the
  whole of the suite's local slowness: `packages/s3` ran in 24.9 / 29.9 /
  29.5 s and now runs in 5.2 / 4.9 / 4.9 s, and a default 5 s hook timeout
  used to report a phantom `(fail) (unnamed) [5000ms]` that named no test.
  `@nxgt/meilisearch`'s server does **not** share the defect — measured, it
  stops in 8 ms on SIGTERM — so do not copy the signal across. `weed` also
  leaves a unix socket in the temp directory per port it bound, so `stop()`
  removes the eight it knows.

- **Type tests** are `test/types/*.ts`, checked by the package's
  `typecheck` (`tsc --noEmit`) and never run. A call that must not compile
  carries `// @ts-expect-error`; if it compiles, tsc fails on the unused
  directive. A type alias that only asserts (`Assert<Equals<…>>`) is
  exported, so `noUnusedLocals` does not count it as dead.

- **A spec that watches a promise reject takes the rejection where the
  promise is made**, not after the line that causes it. In that window
  nobody is waiting, Bun counts the rejection as unhandled, and the test
  fails with the very error it came to assert — a loaded CI runner fails
  where an idle laptop passes, which is exactly how this was found. Hold it
  with a plain `.then(onResolved, onRejected)` whose resolved arm throws
  (`rejection` in `packages/mongo/test/rejection.ts`, with `rejectionMessage`
  for a `toThrow`'s substring), and assert on `expect(await held)`. **Not**
  `expect(promise).rejects`, even awaited on the spot — two failures, both
  measured on bun 1.4.2:
  - held across an `await` and finished later, it never returns — the whole
    file runs out of time and the per-test timeout does not fire;
  - awaited at once on a promise still doing I/O, on a loaded machine, it
    leaves Bun no longer reading the test mongod's stdout. mongod logs each
    DDL there, and once the unread socket buffer fills, its logger blocks
    with the log lock held and the whole server stops answering: every hook
    after it times out at 5000 ms, and Bun then kills the mongod, which ends
    the file in a `(fail) (unnamed)`. That was the migration specs' CI
    flake — on 2 CPUs beside six busy loops they failed 12 runs out of 12,
    at 58–68 KB drained; with the helper, 0 out of 6, with ~150 KB drained.
    Every `@nxgt/mongo` spec — the wiring's included, since `@nxgt/mongo-kit`
    was folded in — and every `@nxgt/mongo-meilisearch` spec now holds its
    rejections this way; `grep -rn "\.rejects" packages/mongo/src
    packages/mongo-meilisearch/src` finds nothing. There, `follow.spec.ts`
    and `lease.spec.ts` hold them with their own file-local `rejection`,
    which also rethrows anything but a `SearchSyncError` and narrows the
    type, so the package needs no `test/rejection.ts` copy. The other
    packages' specs (`drizzle`, `drizzle-meilisearch`,
    `mongo-search-kit`, `redis`, `s3`) and
    `examples/hono-api` still use `.rejects` and are open to it;
    `grep -rn "\.rejects" packages/*/src packages/*/test examples/*/src`
    lists them, and should end up listing only the comments in the
    `rejection.ts` copies.

  A fixture that hands back something long-lived takes its `closed` at
  hand-over, the way `track()` does in
  `packages/mongo/src/collection/changes/subscription.spec.ts` and in
  `packages/mongo-meilisearch/test/fixtures.ts`.

## Releasing

Changesets, with independent versions. `bun changeset` describes a change.
Merging to `develop` opens a "Version packages" PR, and merging that PR
publishes to npm.

- **A change under `packages/` needs a changeset.** CI runs
  `changeset:status`, except on `changeset-release/develop`. A change that
  reaches a consumer takes one naming the package; a change that cannot —
  a spec, a comment, anything `tsconfig.build.json` excludes and `files`
  does not ship — takes `bun changeset --empty`, which says in words why
  nothing is published. Measured on changesets 3.0.3: the gate is that *some*
  changeset was added on the branch, not that one names the changed package.
- **`bun publish`, not `changeset publish`.** `scripts/publish.ts` publishes in
  dependency order and skips versions already on the registry. It writes the
  `git-tag` events `changesets/action@v2` reads from `$CHANGESETS_OUTPUT`.
- **Registry configuration lives in `bunfig.toml`, never in `.npmrc`.**
  Installing needs no token. Publishing reads `$NPM_TOKEN`, which must be a
  **granular** access token covering the `@nxgt` scope, not selected
  packages. The `NPM_TOKEN` secret holds it for CI; it is an organisation
  secret of `softistx`. The only test of whether a token can publish is a
  publish.
- **The release PR needs the repository's switch.** Settings → Actions →
  General → Workflow permissions: *Read and write*, plus *Allow GitHub Actions
  to create and approve pull requests*. To check it:
  `gh api /repos/softistx/nxgt-data/actions/permissions/workflow`.
- **Siblings are depended on by `workspace:^`, never `workspace:*`.** What
  `workspace:^` becomes in a published manifest is read from **`bun.lock`**,
  not from the sibling's `package.json` — measured: `@nxgt/mongo-meilisearch`
  0.1.0 went out with a peer on `@nxgt/mongo` `^0.10.0` while the workspace
  held 0.11.0, because `changeset version` bumps manifests and leaves the
  lockfile alone. `changeset:version` therefore ends with
  `bun install --lockfile-only`, and a stale `bun.lock` in a release is a bug,
  not noise.
- **A new `@nxgt/*` release is found by a schedule, not by memory.** The
  `@nxgt/*` packages from outside this repository are `examples/hono-api`'s
  `@nxgt/openapi-codegen` and `@nxgt/openapi-hono`, from nxgt-http, and the
  example's specs run only the versions `bun.lock` holds. `bun run
  nxgt:outdated` (`scripts/check-nxgt-versions.ts`, spec'd beside it) lists
  every `@nxgt/*` devDependency of a workspace — `packages/*` and
  `examples/*`, whose globs must be `<folder>/*` or it exits 2 — that is not
  a sibling and whose locked version is behind npm's `latest`; a private
  workspace's `dependencies` count as devDependencies, since nobody installs
  it. Exit 0 when all are current, 1 when something is behind, 2
  when the registry did not answer, which is never read as "current". The
  `nxgt versions` workflow runs it every Monday and on `workflow_dispatch`;
  something behind opens the issue *@nxgt/\* devDependencies behind npm
  latest*, or updates the one open, and fails the run, and a later run with
  nothing behind closes it. The bump is a pull request like any other: the
  devDependency and `bun.lock` in one commit, and the example's `typecheck`
  and `test` run. A bump confined to `examples/` needs no changeset — the
  example is private and `changeset status` passes without one. Not
  Dependabot: its Bun updater reads `bun.lock` up to `lockfileVersion` 1,
  and this one, from Bun 1.4.2, is 2.
- **`typescript` is a peer, `^6.0.3`, in every package**, as in nxgt-core
  and nxgt-http; do not raise it in one package alone.
- **Every package is public**, like the repository. Never `private: true`.
- **Every package is MIT**, `"license": "MIT"`, with `LICENSE` in its `files`
  and a copy of the root `LICENSE` in its directory. A new package copies it.

## Deliberate duplication: do not "clean this up"

| Kept twice | Why |
| --- | --- |
| `LICENSE`, at the root and in each `packages/*/` | npm ships only the `LICENSE` in the package's own directory. `verify:artifacts` fails a tarball without one. Change them all together |
| `build.ts`, `scripts/`, `.github/`, `biome.json`, `bunfig.toml` | copied from nxgt-http, not shared: each repository releases on its own. Change every copy the reason applies to. `verify-artifacts.ts` is split into `scripts/artifacts/`, module for module, in all four copies — nxgt-janus first, then here (#135), in nxgt-http (softistx/nxgt-http#53) and in nxgt-core (softistx/nxgt-core#152, with a `browser.ts` of its own) — to keep each file under 250 lines. A check added to one copy belongs in the others. All four hold the same three: the test-code check, the guard in `newestMtime` (an unbuilt package reports `no dist/` rather than crashing on `ENOENT`), and `missingFiles`, whose spec holds that a `files` entry `dis` is not covered by `dist/`. This copy, alxia's and bumail's hold two more, which alxia took from bumail (softistx/alxia#32) and this copy from alxia: `imports.ts` with `declarations.ts`, the undeclared-import check, and `accessProblems` in `manifest.ts`. nxgt-janus, nxgt-http and nxgt-core do not have them yet. `emit.ts`, the declaration-emit check over `test/declarations/`, and the bin's `#!` skip in `imports.ts` come from alxia (softistx/alxia#87 and #79); This copy's `emit.ts` takes the tsc run as a parameter and has `emit.spec.ts`, and compiles with Bun's types where alxia's #87 had `types: []`; alxia's copy takes all of it back in softistx/alxia#94, and nxgt-http (softistx/nxgt-http#98), nxgt-janus (softistx/nxgt-janus#186) and nxgt-core (softistx/nxgt-core#173) carry the same module and spec, so the copies are in step. Until those land, `emit.ts` is in alxia and here only, and the `#!` skip is in alxia's `imports.ts`, this one's and softistx/nxgt-http#97's. `scripts/workspace.ts` and `scripts/newest-peers.ts`, with their specs and the "Newest peers" job in `ci.yml`, are alxia's (and bumail has them too). This copy of `newest-peers.ts` differs in three ways: a single range counts as its own newest end, since no peer here has an `a || b` range; it also rewrites the examples' manifests and every `dependencies`/`devDependencies` entry that installs a peer, so the kits' and the example's `zod` and `mongodb` follow the peers; and the job deletes `bun.lock` before installing. `workspace.ts` is unchanged except for its comment, and it runs `packages/*` only. Where they still differ: only nxgt-core has `browser.ts`; this copy and nxgt-janus read a sibling's version from the workspace, nxgt-http and nxgt-core from the packed manifests; and, outside `scripts/artifacts/`, `check-changesets.ts` is nxgt-janus's alone, as `meilisearch.ts`, `redis.ts` and `seaweedfs.ts` are this copy's. `check-nxgt-versions.ts`, its spec and `.github/workflows/nxgt-versions.yml` are copied from nxgt-janus; this copy reads every workspace the root `package.json` names, `examples/*` included, where nxgt-janus's reads `packages/*` alone, so it names a directory from the root (`examples/hono-api`), not from `packages/`, and it counts a private workspace's `dependencies` as devDependencies (`folderOf` and `manifestOf`, which nxgt-janus's has not) |
| `pagination/page.ts` and `pagination/cursor.ts`, in `@nxgt/drizzle` and `@nxgt/mongo` | every package is standalone, and a shared `@nxgt/pagination` would make one depend on a sibling for four exported shapes. `page.ts` is the closest of the two — 104 and 109 lines, fifteen of them different — so **a fix in one is a fix to make in the other**. `errors/data-error.ts` looks like a third copy and is not: the classes differ. `@nxgt/s3`'s `ObjectPage` is **not** a copy either — four lines agreeing with `CursorPage`'s shape so a caller pages the same way, with no logic to keep in step |
| `checkKeep` in `@nxgt/mongo-backup`'s `src/backups/options.ts`, and `checkPolicy` in `@nxgt/backup`'s `src/rotation/policy.ts` | the rule list and its "a whole number, 1 or more", copied so `mongoBackups()` refuses a bad `keep` when it is called rather than in `prune` after every backup is stored; exporting `checkPolicy` would be a minor of `@nxgt/backup` and a peer range moved for one check. `RULES` is `satisfies readonly (keyof KeepPolicy)[]`, and `RULES_COVER_KEEP` fails the typecheck when `KeepPolicy` gains a rule the copy lacks. What differs: the copy's one message names no rule (`mongoBackups: keep must be false, or name rules each a whole number, 1 or more`) and accepts `false`; `prune` still runs `checkPolicy`, so the original stays the authority |
| `connection/connect.ts`, in `@nxgt/mongo` and `@nxgt/redis` | reference-counted client sharing per URI, copied rather than factored: a shared `@nxgt/connection` would make both depend on a sibling for one function, and layering comes first. **97 lines are identical**, comments included — measured as the sorted, trimmed, non-empty lines the two files share, 97 of mongo's 189 and of redis's 168 — closer than `page.ts` — so **a fix in one is a fix to make in the other**, and a spec added to one belongs in the other. What deliberately differs: `@nxgt/redis` has no `db`, holds the `RedisClient` itself rather than a `Promise<MongoClient>`, closes synchronously, closes sequentially in `closeRedis` where `closeMongo` uses `Promise.all`, and compares options with `Bun.deepEquals` in place of a hand-written `sameValue`. Since the error-code work, a sixth: `@nxgt/redis`'s `ping` races the command against a timer of its own and reports `PING_TIMEOUT` on the result, and `@nxgt/mongo`'s races a timer too, but reports a `ConnectionError` (code `CONNECTION`, message `ping: no answer in …ms`), not a `PING_TIMEOUT` code, and a 250 ms grace after `timeoutMS`, so that the driver's own `MongoOperationTimeoutError` still wins when the driver honours the deadline. Measured on mongodb 7.6.0, `timeoutMS` does not bound server selection: one of the next pings on a connected client that just lost its server waited `serverSelectionTimeoutMS` (30 s). The wiring's `pingMongo` calls that same `ping` for a database whose client the configuration handed in. Both connection failures are a class with a code now, and **neither carries the URI** — a connection string holds the password, and a spec in each asserts its absence |
| `test/server.ts` of `@nxgt/redis`, copied into `@nxgt/redis-guard` | the same rule: a package reaches no sibling's tests. Keep `REDIS_VERSION` equal in both copies — `redis-memory-server` **compiles** the source, so two versions is two builds and two caches, and CI keys the redis cache on the hash of the two files and `scripts/redis.ts`. (There were three copies until `@nxgt/redis-kit` was folded into `@nxgt/redis`.) Neither copy adds anything to the server itself; what differs is each `test/fixtures.ts` — `@nxgt/redis`'s `useRedis` also closes the Redis objects a spec opened with `track`, and `@nxgt/redis-guard`'s calls no `closeRedis()`, since it never connects through `@nxgt/redis`. `examples/hono-api/test/redis.ts` is **not** a copy: it starts the binary `$REDIS_BIN` names, which the example's `test` script takes from `scripts/redis.ts`, and pins nothing |
| `idempotency/result.ts` in `@nxgt/redis-guard`, after `bindCache`'s `checked`/`get` in `@nxgt/redis`, and `RELEASE` in its `idempotency/scripts.ts`, after `withLock`'s | not code — no line is shared, and the layering forbids an import — but the same behaviour on purpose: a value parsed with the caller's schema on the way in (z.input → z.output) and on the way out, the stored form being what the schema gave back, and a lock-like key released only by a compare-and-delete on the holder's own token. **A rule changed in one is a rule to consider in the other.** What deliberately differs: a stored value the schema refuses is a **miss** for a cache and `INVALID` for an idempotent result, which stands for work already done; `run` parses its result back from JSON before storing it, where `remember` does not; the idempotency token lives in a hash field beside the state, not as the key's value; and `INVALID` names zod's issue **codes** only, where `bindCache`'s message joins zod's messages — which on zod 4.6.5 can quote a stray key |
| `test/server.ts` of `@nxgt/s3`, copied into `@nxgt/backup` as `test/s3-server.ts` | the SeaweedFS test server, byte for byte below a three-line header saying so; both run `scripts/seaweedfs.ts` first. **A fix in one is a fix in the other** |
| `test/rejection.ts` of `@nxgt/mongo`, copied into `@nxgt/drizzle`, `@nxgt/redis-guard`, `@nxgt/backup`, `@nxgt/mongo-backup` and `@nxgt/mongo-search-kit` | the helper that holds an expected rejection with `.then` where the promise is made — see Tests. `@nxgt/redis-guard`'s is the full copy, `rejectionMessage` included, and `@nxgt/backup`'s, `@nxgt/mongo-backup`'s and `@nxgt/mongo-search-kit`'s are `@nxgt/redis-guard`'s byte for byte; `@nxgt/drizzle`'s is an earlier, shorter one with `rejection` alone and a shorter comment. **A fix in one is a fix to make in the others** |
| `test/server.ts` of `@nxgt/mongo` and of `@nxgt/meilisearch`, as `test/mongo.ts` and `test/meilisearch.ts` in `@nxgt/mongo-meilisearch` and again in `@nxgt/mongo-search-kit`, `test/mongo.ts` alone in `@nxgt/mongo-backup` (its `dbName` apart), and once more in `examples/hono-api/test/mongo.ts` and `examples/mongo-backup-job/test/mongo.ts` (the version and cache only) | a package reaches no sibling's tests, and an example reaches no package's. Keep `MONGOD_VERSION` equal in all six mongod copies: CI keys the mongod cache on the hash of those six files. (There were seven until `@nxgt/mongo-kit` was folded into `@nxgt/mongo`; its `test/server.ts` went with it.) |
| `test/server.ts` of `@nxgt/meilisearch`, a **fourth** time as `test/meilisearch.ts` in `@nxgt/drizzle-meilisearch` | the same rule. The Meilisearch cache key hashes `scripts/meilisearch.ts` alone — the script pins the version, and the copies only start the binary it prints — so a new copy needs no CI change |
| `test/db.ts` of `@nxgt/drizzle`, copied into `@nxgt/drizzle-meilisearch` | the PGlite helper: one database per spec file, `reset` between tests. The copy carries this package's own `test/schema.ts` — one `articles` table instead of five — so only the four lines around `createTestDb` are the same |
| `batch.ts`, `documents.ts`, `errors.ts` and `reindex.ts`'s `sendAll`/`removeUnwanted`, in `@nxgt/mongo-meilisearch` and `@nxgt/drizzle-meilisearch` | the two bridges write to Meilisearch the same way: chunking by `batchSize`, one `Entry` per id so adds and deletes cannot race, `keyOf` telling `1` from `'1'`, the same `SearchSyncError`/`failed` pair, and the same read-back of the index 1 000 ids at a time to find what to take out — `LIST_LIMIT`, `missingIndex` and `removeUnwanted` are identical. **A fix in one is a fix to make in the other.** What deliberately differs: `entryOf` takes a row and reads its id through the caller's required `toIndexId` instead of taking a Mongo `_id`; the batch helpers take a `wait` flag, because only `reindexAll` waits here; `reindexAll` takes a per-call `pageSize` where the Mongo one reads `ctx.pageSize`, and an `onPage` progress callback the Mongo one has not (its reindex runs inside `start` as often as from a script), and takes no resume token before the scan and saves no state after it; the Drizzle error has no `HISTORY_LOST`, `RUNNING` or `LEASE_LOST`, and so no `holder` or `expiresAt`, since nothing is followed and nothing is leased; and **the dedup by `Entry.key` sits on the other side** — the Mongo bridge's follower buffers into a `Map` before calling `send`, while here the list of rows is the caller's, so `indexRows` keys it itself, last one wins |
| The stamp **policy** — optimistic lock, actor stamps and `upsert`'s rules — in `@nxgt/drizzle`'s `pg/repository/stamp-writes.ts` and `operations/upsert.ts`, after `@nxgt/mongo`'s `collection/stamp-writes.ts`, `documents.ts` and `operations/upsert.ts` | not code — no line is shared, and the two drivers could not share one — but one behaviour kept parallel on purpose, down to the names: `upsert(where, values)` with the `where` written as well as matched, a `version` in `update`'s patch that is checked and never written, `updateMany` and `upsert` refusing one, every update raising it, `OptimisticLockError` with `expectedVersion`/`actualVersion` and a second read to tell a moved row from a missing one, `as(actor)` and the `actor` option, a soft-deleted row an upsert will not write over, and no update that moves a document's key — `@nxgt/drizzle` 0.6.0 refused a primary-key column in `update`/`updateMany`, and `@nxgt/mongo` 0.18.0 brought the same rule to `_id` in `update`, `updateMany` and `upsert`, with the message in drizzle's shape (`update on "users": "_id" is immutable, …`). **A rule changed in one is a rule to consider in the other.** What deliberately differs is listed once, in `packages/drizzle/docs/guide/stamps.md` ("How this differs from `@nxgt/mongo`"): the stamps are read off the table by column key rather than declared; a stamp or a version a write gives itself is kept rather than refused; `optimisticLock: false` makes `version` an ordinary column rather than refusing an expected one; refusals are `ArgumentError`s; a soft delete and a restore also stamp `updatedAt`/`updatedBy`; PostgreSQL requires the unique constraint an upsert conflicts on; a key given as `undefined` is dropped there and refused by `@nxgt/mongo`, and a key in an upsert's values is the insert's id there and refused by `@nxgt/mongo`, whose insert takes `_id` from the filter; and there are no hooks, so nobody is told which half of an upsert ran |
| `idempotency/lease/heartbeat.ts` (`keepLease`) and `RENEW` in `@nxgt/redis-guard`, after `keepLease`/`renew` in `@nxgt/mongo-meilisearch`'s `run/lease.ts` | not code — no line is shared, and the layering forbids the import — but the same heartbeat on purpose: an interval of a third of the lease, a renewal filtered on the holder's own token that marks the lease lost when it matches nothing and stops the beat, a renewal that fails to reach the server tried again at the next beat, and one in flight at the stop reporting nothing. **A fix to renewal in one is a fix to consider in the other.** What deliberately differs: the renewal is a Lua script on one hash, not an `updateOne`, and it also refuses a record no longer `running`, so a finished result's `ttl` is never cut to a lease; a lost lease is reported only when `work` finishes (`LEASE_LOST` from `run`), never by stopping anything, since `work` is the caller's and cannot be interrupted; the renewal promise takes both handlers where it is made; and there is no `confirmLease` — `COMPLETE`'s own token check is the confirmation |
| `run/lease.ts` in `@nxgt/mongo-meilisearch`, after `migrations/lock.ts` in `@nxgt/mongo` | a bridge takes no sibling's internals, and the lock is not exported. Both keep one document timed by the server (`$$NOW`), name the holder `host:pid:<ObjectId>`, renew with an update filtered on the holder, and release with a `deleteOne` on it; the refusal carries the lease document's `holder` and `expiresAt`, under the same names and types as `MigrationLockedError`'s. **What deliberately differs is the taking**: the lease is one `findOneAndUpdate` with `upsert` whose pipeline update keeps a live holder's fields and writes its own when the lease lapsed — no `$documents`/`$merge` `aggregate`, which a failpoint on the change stream's `aggregate` also caught; and a lease found lost stops the running sync, or the reindex before it removes or records, with `LEASE_LOST`, where the lock only fails the migration run. A fix to renewal or release in one is a fix to consider in the other |

## Keeping the code maintainable

These are measured limits, not taste. They exist because both packages grew
the same shape before anyone looked: `@nxgt/mongo`'s `build()` reached **487
lines** and `@nxgt/drizzle`'s **353**, and both have since been taken apart
the same way — the drizzle one down to **31**. The drizzle number said 321 for
longer than it was true, which is its own lesson: measure it when you touch
the file.

- **A long file of declarations is fine; a long function is not.** A type or
  an options interface earns its length in documentation —
  `mongo/src/collection/types.ts` is 513 lines and every one of them is a
  declaration with a reason. A *function* past **80 lines** is the signal.
  Keep a source file under **250** lines; when it climbs, it is almost always
  one function that grew, not a file that filled up.
- **A builder that grows becomes a context plus modules by role.** When a
  factory accumulates a closure — ten captured variables and twenty inner
  functions — extract the resolved state into a `context.ts`, and move the
  methods into modules named after what they do: `filters.ts`,
  `documents.ts`, `operations/reads.ts`, `operations/writes.ts`,
  `operations/paginate.ts`. Each takes the context as its **first
  argument**. `mongo/src/collection/` is the worked example, and the factory
  that is left (`get-collection.ts`) only assembles and proxies.
  `@nxgt/drizzle`'s `pg/repository/` is the second one, done the same way and
  on purpose in a PR of its own: `create-repository.ts` fell from **419 lines
  to 103** and its `build()` from **353 to 31**, against an unchanged 113
  tests. A split like this is never made in the same PR as a behaviour
  change — the identical test count is the only evidence that nothing moved,
  and it is worthless if the tests changed too.
- **The context holds data, not closures.** This is the half of the rule that
  is easy to miss, and it was missed here first: a `createContext` that
  resolves the options *and* returns eight functions closed over them is the
  same factory one size down, and it grew straight back to 173 lines. Once
  `hasOwnId` and `parses` were on the context like every other resolved
  value, every helper became a plain function over it and the factory fell to
  **41 lines**. If a context field cannot be printed, it does not belong on
  the context. The one exception is the caller's own hooks,
  which are handed over as given: the rule is about closures the package
  builds.
- **A folder is a subject; when one holds more than one, split it.** A
  folder past a dozen source files, or one whose files need a prefix to tell
  them apart (`hook-types`, `change-types`), is several subjects. In
  `mongo/src/collection/` the root keeps what every subject shares — the
  surface (`get-collection.ts`, `types.ts`, `auto-sync.ts`), the
  `context.ts`, `filters.ts`, `documents.ts`, the reading of the strings a
  caller passes, `coerce.ts`, and the stamp-write policy `documents.ts`
  applies, `stamp-writes.ts` — and each subject has a folder whose files drop the prefix:
  - `operations/` — `reads`, `writes`, `upsert`, `paginate`;
  - `hooks/` — `types`, `sets`, `hooked`;
  - `changes/` — `types`, `events`, `subscription`, `retry`;
  - `aggregation/` — `types`, `distinct`, `group-by`, `populate`.

  A subject imports the root, and another subject only one way: `hooks/`
  wraps `operations/writes`, so `operations/` never imports `hooks/`. Only
  `get-collection.ts` and `types.ts` reach into all of them. The one root
  import of a subject is `context.ts` → `hooks/sets`, a leaf that imports
  nothing and turns the `hooks` option into context data.
- **Specs are split by subject, not one per source file.** `@nxgt/drizzle`'s
  `pg/repository/` has seven — `create-repository` for what the factory
  decides, `operations/reads`, `operations/writes`, `operations/upsert`,
  `soft-delete`, `optimistic-lock` and `actors` — and a spec file is not
  free: it opens a database of its own. Measured, `createTestDb` costs
  0.8-2.0 s cold and far less warm, so two more files cost **+0.5 s**; the
  three the parity with `@nxgt/mongo` added, with their 33 tests (and one
  more in `columns.spec`), took the suite from **9.1-10.1 s** to
  **11.9-13.3 s** over five runs; `@nxgt/s3` was left whole because the same measurement
  came back at **+13 s** on a 5 s suite, one SeaweedFS per file — before
  `stop()` took SeaweedFS down with `SIGKILL`. Its second server file,
  `operations/presign-post.spec.ts`, measured the cost again: the suite went
  from **9.1 s** to **10.5-15.4 s** over five runs, 2.1 s of it the expiry
  spec's own wait, against a file that would have taken `bind-bucket.spec.ts`
  past 850 lines. Measure before splitting, and say the number. `collection/` has
  fourteen, beside the code they test: `id`, `coerce`, `upsert`,
  `optimistic-lock`, `soft-delete`, `stamp-writes`, `driver-methods`,
  `auto-sync` and the general one at the root,
  `operations/paginate`, `hooks/hooks`, `changes/changes`,
  `changes/subscription` and `aggregation/aggregation`. Beside `collection/`,
  `connection/connect` covers `connectMongo` and `connection/ping-lost` the ping after the server is lost (about 3 s of the suite), `migrations/` has three:
  `plan` (the list against the records, no server), `migrate` and `lock`, and
  `gridfs/` has three: `define-bucket` and `serve` (no server) and `gridfs`
  (everything against one). A refactor that moves code must leave them untouched —
  if a spec has to change, the refactor changed behaviour.
- **A deduplicating write elects on the server, never on a rule each caller
  works out for itself.** `putOnce` in `@nxgt/mongo/gridfs` is the worked
  example, and the reason is measured: the copies collide on the unique
  `{ files_id, n }` index and then on `_id`, because the bytes decide the id.
  An order every caller computes the same way — `(uploadDate, _id)` — cannot
  do it, whatever the key: a document is not visible when it is written but
  when it is committed, so the copy that is first by any client-side key can
  be the last one anybody can see, and every caller then finds itself first.
  That was a released defect, not a theory. It follows that `putOnce` creates
  the bucket's indexes itself whatever `autoSync` says, that `drop()` forgets
  the memo of having created them, and that **no call removes a `files`
  document it did not write** — a caller takes back only the chunks whose
  `_id` it wrote.
- **A public method that refuses something must have a `@ts-expect-error`
  case** in `test/types/`. Type safety is what the compiler rejects, not what
  the README claims: when this was last measured on `@nxgt/mongo`, **seven of
  twelve** plausible mistakes still compiled.
- **Never factor across packages.** Layering comes first; a near-copy goes in
  the duplication table above instead, with what makes the two diverge.
- **Refactoring is its own pull request**, with a `chore:` commit and a patch
  changeset that says plainly that nothing public moved. The proof is that
  the test counts are identical on both sides of it.
- **The `code-reviewer` agent** checks all of this. It comes from the shared
  `nxgt-review` plugin (marketplace `nxgt-core`), and reviews against this
  file and its reference for this repository,
  `plugins/nxgt-review/references/nxgt-data.md` in `softistx/nxgt-core`. It
  reads and reports; it does not edit. Run it before opening a pull request
  (skill `review-before-a-pr`), and `documentation-auditor` (plugin
  `nxgt-docs`) beside it when a public surface changed. A rule changed here
  is changed in that reference too.

## Conventions

- Biome, with tabs and single quotes. Run `./node_modules/.bin/biome check
  --write` before committing, and `bunx biome ci` must pass, as in CI.
- Commit messages: `<type>: <Capitalized summary>`, with types `feat`, `fix`,
  `update`, `chore`, `docs`, `typo`, and `ci` for the workflows and the setup
  action.
- Git: the default branch is `develop`. Work on a feature branch and open a
  pull request into `develop`.
- A repository script is a TypeScript file run by Bun, with Bun Shell, not a
  `.sh`.
- **Imports carry no extension**: `from './repository'`, not
  `'./repository.js'`. Every tsconfig here resolves as a bundler does, and
  Bun runs the specs the same way. The READMEs' examples carry none.
- **A package's `README.md` is its page on npmjs.** It is read by someone who
  has never seen this repository: organize it by section, with a copy-paste
  example each, an **API** section and a **Traps** section, and never name a
  private application.
- Specs live next to the code they test (`*.spec.ts`), and files are
  organised in folders by role (`errors/`, `pagination/`, `pg/repository/`…),
  not flat.
- **A package keeps its own errors.** `@nxgt/drizzle` throws `DataError` and
  its subclasses; it depends on no exception package.
- **Which base class, and whether a refusal gets a code.** Two questions, and
  they are answered separately.
  - *A code, or a bare `TypeError`?* A refusal at **definition or wiring
    time** — `defineCache('')`, `defineBucket({})`, a table with no primary
    key, `connectRedis` called twice with different options — stays a bare
    `TypeError`: it cannot come from a request, and no handler should answer
    it. A refusal at **call time, on a value that could have come from a
    request** — a `where`, an `orderBy`, an `acl`, an `expiresIn` — carries a
    class with a `code`, so a handler answers 400 without matching message
    text.
    `WiringError`, in `@nxgt/mongo`, is the deliberate exception: every one of
    its refusals is wiring-time, and it still gives them codes, because it has
    seven distinct ones and a start-up script wants to tell them apart. The
    rule underneath is **a handful of refusals can be told apart by their
    sentence; a dozen cannot**.
  - *Extend `Error` or `TypeError`?* Extend whichever class the refusals it
    replaces already threw, so no consumer's `catch` stops working.
    `WiringError` and `ArgumentError` replaced bare `TypeError`s, so they extend
    `TypeError`; `DataError`, `RedisError` and `S3Error` never replaced one,
    so they extend `Error`. A class that extends `TypeError` must be tested
    for **before** any `TypeError` branch in a handler, and its docs say so.
  - `@nxgt/mongo` has **no** `ArgumentError`: a refused argument to a
    collection method there is a bare `TypeError`, and
    `packages/mongo/docs/guide/errors.md` says so outright, because an
    application on both it and `@nxgt/drizzle` gets a code for one and message
    text for the other. The **wiring's** refusals are the one place it has a
    code: `defineMongo`, `openMongo` and the rest of `src/wiring/` throw a
    `WiringError`, a `TypeError` with a `code`, and that guide says it too.
- **A message names what failed, not only what was wrong.** Every one of these
  packages has several calls that take options under the same names — `page`,
  `pageSize`, `limit`, `after` — so `limit must be an integer of at least 1`
  is true and useless: a log line holding it says which of an application's
  listings produced it never. A refusal names the call and the thing it was
  on, and it names the call **a consumer wrote**, not the function behind
  it: `paginate on "uploads": limit must be…` for a bucket's listing, whose
  internal function is `paginateFiles`,
  `Invalid cursor in paginateByCursor on "posts": …`,
  `Chunk 4 of file 6721… in "uploads" holds a string where its bytes should
  be`. Where a message is what a consumer searches for, the searchable lead
  stays in front and the call is named after it. A helper that several calls
  share takes an optional trailing `where` rather than being copied per call.
- **A message reports a shape, never a value.** A transform's return, a
  chunk's `data`, an option off a request body: say `a string`, `an array`,
  `no data field`. The value came from somewhere this package does not
  control and can hold anything the documents held.
- **`process.emitWarning` is the one warning channel.** Nothing here logs on
  its own account. A `bin` target (`@nxgt/mongo-backup`'s `src/cli.ts`)
  writes to the console, since that is its output; elsewhere in
  `packages/*/src`, the one `console.error` is `@nxgt/redis`'s
  default `onError`, which is a callback the caller replaces — a message that
  would otherwise end the process, not a package deciding to write. A
  package that has something to say and nothing to refuse — a GridFS bucket
  whose missing index makes every read a collection scan — emits one
  `process` warning with a `code` of its own (`NxgtGridFSMissingIndex`), once
  per subject for the life of the process. It is the one channel every
  application already has, it can be listened to with `process.on('warning')`
  or silenced, and it commits nobody to a logger. Measured on bun 1.4.2: a
  listener receives it *and* Bun prints it, unlike Node, where a listener
  replaces the default print. A warning never throws and never delays the
  call it is about: probe beside the work, not in front of it, and forget a
  probe that failed so the next call tries again. The memo is a module-level
  `Set` keyed by the subject's own name — `<database>:<bucket>` — and it has
  no reset: a suite that wants to observe the warning binds a bucket of its
  own rather than clearing the memo, because a reset exported for the tests
  is a reset an application can call, and the promise is once per process.
- **The verb says what the function does.** `define*` describes and touches
  nothing (`defineCollection`, `defineIndex`, `defineMongo`,
  `defineMigration`); `get*` and `bind*` attach to a live client without
  reaching the server (`getCollection`, `bindIndex`); `connect*` opens it
  (`connectMongo`). `create*` assembles an object and does **no** I/O:
  `createRepository`, `createSearchSync` and `createContext` are all
  synchronous. `open*` is the wiring's `connect*`: `openMongo` and `openRedis`
  are `async`, take what `defineMongo` and `defineRedis` described, and open
  the clients. (`createKit` was an `async` `create*`, kept on 2026-09-17; the
  rename to `openMongo` ended that exception, so a second async `create*`
  has no precedent left.)

## Known state

`bun run test` is **1817 pass, 0 fail**, measured by a full run on
2026-10-04 (after `@nxgt/mongo-kit` was folded into `@nxgt/mongo`): drizzle
167, meilisearch 130, mongo 667 (565 before the fold, plus the 101 that came
from `mongo-kit`, plus `ping-lost`), drizzle-meilisearch 42, mongo-meilisearch 58, mongo-kit 3
(its `index.spec.ts`), mongo-search-kit 17, redis 101, redis-guard 124,
redis-kit 2 (its `index.spec.ts`), s3 104, backup 196, mongo-backup 68,
`mongo-backup-job-example` 2, hono-api-example 43 and the scripts' 93. The
scripts' count once held 3 of `redis-guard`'s `run-script.spec.ts` run a
second time. It runs one process per package, then
the scripts' specs through `bun test ./scripts/`. The leading `./` matters: a
bare `bun test scripts` is a substring filter, and on 2026-09-28 it ran 64
tests across 11 files,
`packages/redis-guard/src/scripts/run-script.spec.ts` included. Treat any
failure as yours.

- **The test mongod runs with `enableTestCommands`**, so a spec can make it
  fail a command on demand with `t.failNext(['getMore', 'aggregate'], …)`.
  That is how the change-stream specs reach the reopen path, and the error
  code matters — all measured:
  - **43** (CursorNotFound) is the transient one to use. The driver resumes
    once by itself after a failed `getMore`, so fail its `aggregate` too.
  - **91** makes the driver forget the server: every command after it waits
    about ten seconds.
  - **2, 9, 14, 40647** are the caller's own input and are not retried, so
    they cannot stand for a transient failure.
  - `t.clearFailures()` turns a failpoint off; setting `times: 0` still fails
    one more command. The subscription spec calls it after each test.
- **The packages' suites run in parallel, and each wants a server**: a mongod,
  a Meilisearch binary and PGlite, all at once. On a machine that is short of
  memory they fail together, and the failures do not look like what they are: a
  mongo `beforeAll` that times out is reported as `(fail) (unnamed)` and raises
  the test count by one, and Meilisearch fails its first test after several
  seconds and the rest in a millisecond each. Before reading that as a
  regression, run the packages one at a time — green in series means it was the
  machine, not the code.

- **The migration lock is timed by the server (`$$NOW`)**, and two things
  mongod 8.2 refuses shaped how it is taken — both measured:
  - `$expr` in the filter of an **upsert** ("not allowed in the query
    predicate for an upsert"), so taking the lock is two atomic writes: an
    insert, then a take-over of a lapsed lock by an update filtered on
    `$expr`;
  - `$documents` on a **collection's** `aggregate` (it needs
    `{ aggregate: 1 }`), so the insert is `db.aggregate([{ $documents }, { $merge,
    whenMatched: 'fail' }])`, which answers 11000 when the lock exists.
  - `@nxgt/mongo-meilisearch`'s lease on a sync name gets round the first
    one differently: its upsert filters on `_id` alone and puts the decision
    in a **pipeline update** (`$cond` on `$expiresAt <= $$NOW`), which the
    server accepts; two racing inserts answer 11000 to the loser.

- **Meilisearch answers `succeeded` to a settings update whatever it holds**:
  measured on v1.53.2 with an unknown ranking rule, an empty dictionary entry
  and a 600-character sortable attribute. A failed settings task therefore
  cannot be produced against a real server, so `syncIndex`'s `TASK_FAILED` and
  `index_already_exists` branches are covered by a scripted client in
  `sync-index.spec.ts`. Everything a server does reach is tested against the
  real one.
