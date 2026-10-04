# Troubleshooting

This package throws one error of its own, `MongoBackupError`, told apart by
its `code`: `SNAPSHOT_TOO_OLD`, `CHANGING`, `HISTORY_LOST`, `UNSUPPORTED`,
`EXISTS` or `MALFORMED`. A refusal of the way `mongoSource` or `mongoTarget` was called
is a plain `TypeError`. Errors from the driver or the server come back as
they are; when one is the cause of a `MongoBackupError`, it is its `cause`.

**No message of `MongoBackupError` or of those `TypeError`s quotes a value,
a document or a collection name**: a backup error ends up in logs. A driver
or server error passes through as it is, and its message may quote both —
an `E11000` during a restore quotes the duplicate key. To find which collection is concerned, read the
server's log, or the change stream, around the time of the failure.

```ts
import { MongoBackupError } from '@nxgt/mongo-backup';

try {
	await backups.create(mongoSource({ db }), { kind: 'incremental', identities });
} catch (error) {
	if (error instanceof MongoBackupError) console.error(error.code, error.message);
	throw error;
}
```

The errors of `@nxgt/backup` itself — keys, repositories, locks, chains —
are on [its own troubleshooting page](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/troubleshooting.md);
the few you meet first with this package are repeated below. Their headings
use `app` for the definition's name and `local` for the repository's.

- **Install and run**
  - [`ReferenceError: Bun is not defined`](#referenceerror-bun-is-not-defined)
- **Configuration**
  - [`mongoSource: db must be a MongoDB Db`](#mongosource-db-must-be-a-mongodb-db)
  - [`mongoSource: collections must be a list of names or a function`](#mongosource-collections-must-be-a-list-of-names-or-a-function)
  - [`mongoTarget: db must be a MongoDB Db`](#mongotarget-db-must-be-a-mongodb-db)
  - [`mongoTarget: tmpDir must be an absolute path`](#mongotarget-tmpdir-must-be-an-absolute-path)
- **Full backups**
  - [`mongoSource: the server gave no snapshot time; a backup needs a replica set or a sharded cluster`](#mongosource-the-server-gave-no-snapshot-time-a-backup-needs-a-replica-set-or-a-sharded-cluster)
  - [`mongoSource: a collection named in collections is not in the database`](#mongosource-a-collection-named-in-collections-is-not-in-the-database)
  - [`mongoSource: a collection is of a type this version does not back up (a time-series one); leave it out with collections`](#mongosource-a-collection-is-of-a-type-this-version-does-not-back-up-a-time-series-one-leave-it-out-with-collections)
  - [`mongoSource: the collections or their indexes kept changing while the snapshot was taken; try again when they settle`](#mongosource-the-collections-or-their-indexes-kept-changing-while-the-snapshot-was-taken-try-again-when-they-settle)
  - [`mongoSource: the snapshot outlived the history the server keeps; raise minSnapshotHistoryWindowInSeconds, or back up fewer collections at a time`](#mongosource-the-snapshot-outlived-the-history-the-server-keeps-raise-minsnapshothistorywindowinseconds-or-back-up-fewer-collections-at-a-time)
- **Incremental and differential backups**
  - [`create on "app": no backup to build on (repository "local")`](#create-on-app-no-backup-to-build-on-repository-local)
  - [`create on "app": the source is not of the kind the backup it builds on was made from`](#create-on-app-the-source-is-not-of-the-kind-the-backup-it-builds-on-was-made-from)
  - [`mongoSource: the server gave no operation time; a backup needs a replica set or a sharded cluster`](#mongosource-the-server-gave-no-operation-time-a-backup-needs-a-replica-set-or-a-sharded-cluster)
  - [`mongoSource: the backup built on recorded no position this version reads; make a full backup`](#mongosource-the-backup-built-on-recorded-no-position-this-version-reads-make-a-full-backup)
  - [`mongoSource: the change stream cannot resume where the last backup stopped: the oplog no longer reaches back there; make a full backup`](#mongosource-the-change-stream-cannot-resume-where-the-last-backup-stopped-the-oplog-no-longer-reaches-back-there-make-a-full-backup)
  - [`mongoSource: an update touched a field whose name holds a dot or is a number, which a change cannot say without its post-image; turn on changeStreamPreAndPostImages for that collection, or make a full backup`](#mongosource-an-update-touched-a-field-whose-name-holds-a-dot-or-is-a-number-which-a-change-cannot-say-without-its-post-image-turn-on-changestreampreandpostimages-for-that-collection-or-make-a-full-backup)
  - [`mongoSource: the collections created, renamed or dropped since the full backup are too many to record; make a full backup`](#mongosource-the-collections-created-renamed-or-dropped-since-the-full-backup-are-too-many-to-record-make-a-full-backup)
  - [`mongoSource: a collection was renamed into those backed up, with documents an incremental backup never read; make a full backup`](#mongosource-a-collection-was-renamed-into-those-backed-up-with-documents-an-incremental-backup-never-read-make-a-full-backup)
  - [`mongoSource: an entry of the backup built on was asked for again; it has no fingerprint, so make a full backup`](#mongosource-an-entry-of-the-backup-built-on-was-asked-for-again-it-has-no-fingerprint-so-make-a-full-backup)
- **Restoring**
  - [`mongoTarget: a collection or view the backup holds is already in the database; restore into another one, or pass replace: true`](#mongotarget-a-collection-or-view-the-backup-holds-is-already-in-the-database-restore-into-another-one-or-pass-replace-true)
  - [`mongoTarget: an entry name is not one this version writes`](#mongotarget-an-entry-name-is-not-one-this-version-writes)
  - [`mongoTarget: a collection’s documents came before its metadata`](#mongotarget-a-collections-documents-came-before-its-metadata)
  - [`mongoTarget: a metadata entry is not one this version wrote`](#mongotarget-a-metadata-entry-is-not-one-this-version-wrote)
  - [`mongoTarget: a metadata entry is larger than 16 MiB`](#mongotarget-a-metadata-entry-is-larger-than-16-mib)
  - [`mongoTarget: an entry is not a sequence of BSON documents`](#mongotarget-an-entry-is-not-a-sequence-of-bson-documents)
  - [`mongoTarget: a change is not one this version wrote`](#mongotarget-a-change-is-not-one-this-version-wrote)

## Install and run

### `ReferenceError: Bun is not defined`

**When:** the first `create` or `restore`, under Node.
**Why:** `@nxgt/backup` runs on Bun only, and `mongoTarget` stages the
changes of an incremental backup with `Bun.write` and reads them back with
`Bun.file`.
**Fix:** run the job with Bun.

```sh
bun run backup.ts
```

## Configuration

These are thrown by `mongoSource(…)` or `mongoTarget(…)` themselves, where
the backup is wired: nothing was read or written.

### `mongoSource: db must be a MongoDB Db`

**When:** `mongoSource({ db })` with something that is not a driver `Db` —
a `MongoClient`, a collection, a connection string, or `undefined`, such as
a Mongoose connection's `db` read before it connected.
**Why:** the source reads one database, and needs the `Db` of the official
`mongodb` driver: it calls `watch`, and reads `databaseName`.
**Fix:** give the database, not the client.

```ts
import { MongoClient } from 'mongodb';
import { mongoSource } from '@nxgt/mongo-backup';

const client = await MongoClient.connect(process.env.MONGO_URL!);
const source = mongoSource({ db: client.db('shop') });
```

With Mongoose, `await mongoose.connect(…)` first, then pass
`mongoose.connection.db`.

### `mongoSource: collections must be a list of names or a function`

**When:** `mongoSource({ db, collections })` with a single string, or a list
holding something other than strings.
**Why:** `collections` is either the names to back up, or a test on each
name; a lone string is refused rather than read letter by letter.
**Fix:**

```ts
mongoSource({ db, collections: ['orders'] });
mongoSource({ db, collections: (name) => !name.startsWith('cache.') });
```

### `mongoTarget: db must be a MongoDB Db`

**When:** `mongoTarget({ db })` with something that is not a driver `Db`.
**Why:** as for [the source](#mongosource-db-must-be-a-mongodb-db): the
target writes into one database.
**Fix:**

```ts
import { mongoTarget } from '@nxgt/mongo-backup';

await backups.restore(id, mongoTarget({ db: client.db('shop-restored') }), { identities });
```

### `mongoTarget: tmpDir must be an absolute path`

**When:** `mongoTarget({ db, tmpDir })` with a relative path.
**Why:** each `changes/<n>` entry of an incremental or differential backup
is staged to a file in `tmpDir` until it has been read and checked to its
end, then applied; a relative path would depend on the folder the job was
started from.
**Fix:** an absolute path on a disk with room for the largest `changes`
entry — or leave `tmpDir` out for the system's temporary folder.

```ts
import { join } from 'node:path';

mongoTarget({ db, tmpDir: join(import.meta.dir, 'tmp') });
```

## Full backups

A full backup reads every collection in one snapshot session: one cluster
time for the whole database.

### `mongoSource: the server gave no snapshot time; a backup needs a replica set or a sharded cluster`

**Code:** `UNSUPPORTED`.
**When:** a full `create`, before any entry is read.
**Why:** the backup reads every collection at one cluster time with a
snapshot session, and records that time so the next incremental backup can
start its change stream just after it. A standalone `mongod` has no cluster
time, no snapshot reads and no change stream. The server may refuse the
snapshot read itself first, with an error of its own; the cause is the same.
**Fix:** run MongoDB as a replica set — a single member is enough — and
connect to it as one.

```sh
mongod --replSet rs0 --dbpath /data/db
mongosh --eval 'rs.initiate()'
```

```ts
const client = await MongoClient.connect('mongodb://localhost:27017/?replicaSet=rs0');
```

### `mongoSource: a collection named in collections is not in the database`

**Code:** none — a `TypeError`, as `create`'s rejection.
**When:** a full `create` with `collections: [...]` listing a name the
database does not hold: a typo, a collection not created yet, or the wrong
database.
**Why:** a backup of a name that is not there would back up nothing, and
say nothing. `system.*` collections are never taken, so naming one is
refused the same way.
**Fix:** name collections that exist — or pass a function, which takes what
it matches and refuses nothing.

```ts
mongoSource({ db, collections: (name) => ['orders', 'customers'].includes(name) });
```

### `mongoSource: a collection is of a type this version does not back up (a time-series one); leave it out with collections`

**Code:** `UNSUPPORTED`.
**When:** a full `create` on a database holding a time-series collection
that `collections` takes — every one, by default. Or an incremental or
differential `create` whose change stream holds the creation of a
time-series collection since the backup it builds on.
**Why:** this version backs up collections and views; it neither reads nor
restores a time-series collection, and refuses rather than leave it out
without saying so.
**Fix:** leave it out, and back it up another way.

```ts
mongoSource({ db, collections: (name) => name !== 'metrics' });
```

For an incremental backup too, leaving it out is enough: the change stream
passes over a collection `collections` leaves out before translating its
events, so
the next incremental with the new filter goes past the creation.

### `mongoSource: the collections or their indexes kept changing while the snapshot was taken; try again when they settle`

**Code:** `CHANGING`; nothing was stored.
**When:** a full `create`, while collections the filter takes are created,
dropped or renamed, or their indexes or options change, without pause — a
migration, an index build, an application making temporary collections.
**Why:** the server does not list collections or indexes at a cluster time,
so a full backup reads them before pinning its snapshot and again after,
and keeps them only when both agree: then they are the snapshot's. It
retakes the pin up to five times before giving up, rather than store
metadata the documents might break — a unique index built in the gap would
make the backup impossible to restore.
**Fix:** run the backup once the migration or index build is over, or
retry after a pause.

```ts
import { MongoBackupError } from '@nxgt/mongo-backup';

for (let attempt = 1; ; attempt++) {
	try {
		await backups.create(mongoSource({ db }));
		break;
	} catch (error) {
		if (!(error instanceof MongoBackupError && error.code === 'CHANGING') || attempt === 3) throw error;
		await Bun.sleep(60_000);
	}
}
```

### `mongoSource: the snapshot outlived the history the server keeps; raise minSnapshotHistoryWindowInSeconds, or back up fewer collections at a time`

**Code:** `SNAPSHOT_TOO_OLD`; the server's error is its `cause`.
**When:** a full `create` on a large database, partway through: the read of
one collection's documents fails some minutes after the backup started.
**Why:** every collection is read at the cluster time the backup started,
and the server keeps the history needed to read at that time for
`minSnapshotHistoryWindowInSeconds` only — 300 seconds by default. A
backup that takes longer, or a slow repository, outlives it.
**Fix:** raise the window on every member of the replica set, for as long
as a full backup takes — it costs cache and disk while a snapshot is open:

```ts
await client.db('admin').command({ setParameter: 1, minSnapshotHistoryWindowInSeconds: 3600 });
```

Or split the database into several backups, each with its own
`collections` — each is consistent in itself, but not with the others.

## Incremental and differential backups

An incremental or differential backup reads the change stream from the
position the backup it builds on recorded, into one `changes/<n>` entry;
the entries of the backup it builds on are not read again.

### `create on "app": no backup to build on (repository "local")`

**Code:** `BackupError` from `@nxgt/backup`, `NOT_FOUND`; nothing was read
from the database. For a differential, the message is
`create on "app": no full backup to build on (repository "local")`.
**When:** the first incremental or differential `create` of a definition —
or after every backup of it was pruned or is unreadable.
**Why:** an incremental backup stores what changed since another backup,
and a full one is never made in its place without being asked for.
**Fix:** make a full backup first, or fall back to one in the job.

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.create(source, { kind: 'incremental', identities });
} catch (error) {
	if (!(error instanceof BackupError && error.code === 'NOT_FOUND')) throw error;
	await backups.create(source); // the first one: full
}
```

### `create on "app": the source is not of the kind the backup it builds on was made from`

**Code:** a `TypeError` from `@nxgt/backup`; nothing was read from the
database.
**When:** an incremental or differential `create` with `mongoSource`, on a
definition whose last backup came from another source — a
`directorySource` of `mongodump`'s output, say.
**Why:** a backup from `mongoSource` is of kind `mongo`, and an incremental
one only builds on a backup of the same kind.
**Fix:** a definition of its own for the database, starting with a full
backup.

```ts
const database = bindBackup(defineBackup({ name: 'shop-db' }), { repositories, recipients });
await database.create(mongoSource({ db }));
```

### `mongoSource: the server gave no operation time; a backup needs a replica set or a sharded cluster`

**Code:** `UNSUPPORTED`.
**When:** an incremental or differential `create`, before the change stream
is opened.
**Why:** the backup reads the change stream up to the cluster's operation
time at its start, and a standalone server gives none — nor a change
stream.
**Fix:** as for [a full backup](#mongosource-the-server-gave-no-snapshot-time-a-backup-needs-a-replica-set-or-a-sharded-cluster):
a replica set, a single member being enough.

```ts
const client = await MongoClient.connect('mongodb://localhost:27017/?replicaSet=rs0');
```

### `mongoSource: the backup built on recorded no position this version reads; make a full backup`

**Code:** `MALFORMED`.
**When:** an incremental or differential `create`, before the change stream
is opened.
**Why:** the backup it builds on recorded no position, or one this version
did not write: it was made by another source declaring the kind `mongo`,
or by a later version of this package whose position this one does not
read.
**Fix:** a full backup, then incrementals from it.

```ts
await backups.create(mongoSource({ db }));
```

### `mongoSource: the change stream cannot resume where the last backup stopped: the oplog no longer reaches back there; make a full backup`

**Code:** `HISTORY_LOST`; the server's error is its `cause`.
**When:** an incremental or differential `create`, as the change stream is
opened.
**Why:** a change stream is read from the oplog, which is a capped
collection: once more was written since the last backup than the oplog
holds, the position it recorded is gone, and the changes since cannot be
read. The longer between backups, and the busier the database, the sooner.
**Fix:** make a full backup — every incremental after it works again — and
then either back up more often or keep more oplog.

```ts
import { MongoBackupError } from '@nxgt/mongo-backup';

try {
	await backups.create(source, { kind: 'incremental', identities });
} catch (error) {
	if (!(error instanceof MongoBackupError && error.code === 'HISTORY_LOST')) throw error;
	await backups.create(source); // full: the chain starts again here
}
```

To keep more oplog, on each member — the size in megabytes, or a minimum
retention in hours:

```ts
await client.db('admin').command({ replSetResizeOplog: 1, size: 51200 });
await client.db('admin').command({ replSetResizeOplog: 1, minRetentionHours: 48 });
```

### `mongoSource: an update touched a field whose name holds a dot or is a number, which a change cannot say without its post-image; turn on changeStreamPreAndPostImages for that collection, or make a full backup`

**Code:** `UNSUPPORTED`.
**When:** an incremental or differential `create`, when the change stream
holds an update to a field whose name holds a `.` or is all digits —
`'price.eur'`, `'2026'` — in a collection the chain follows: those of its
full backup, and those created since that `collections` takes. One it does
not follow is passed over before its events are translated; narrowing
`collections` mid-chain changes that only from the next full backup.
**Why:** for such an update the server describes the change with paths it
cannot tell apart from nested fields or array indexes, so it cannot be
replayed as written. With the collection's post-images on, the change
stream gives the whole document after the update, and the backup records
that instead.
**Fix:** turn post-images on for that collection, then make a full backup —
the update already in the change stream has no post-image, so every
incremental from the old position fails on it.

```ts
await db.command({ collMod: 'orders', changeStreamPreAndPostImages: { enabled: true } });
await backups.create(mongoSource({ db }));
```

Turning them on makes the server keep a copy of each document as it was
before an update, which costs writes and storage.

### `mongoSource: the collections created, renamed or dropped since the full backup are too many to record; make a full backup`

**Code:** `UNSUPPORTED`; the incremental is not stored.
**When:** an incremental or differential `create`, at the end of its
changes, once the collections created, renamed or dropped since the chain's
full backup no longer fit in a position — 64 KiB, `@nxgt/backup`'s limit:
some thousands of names.
**Why:** the position records how the collections the chain follows differ
from those of its full backup, and each incremental carries that difference
on. An application that makes and drops collections all the time — one
per tenant, per day — makes it grow until the next full backup.
**Fix:** make a full backup: the difference starts again from nothing.

```ts
await backups.create(mongoSource({ db }));
```

### `mongoSource: a collection was renamed into those backed up, with documents an incremental backup never read; make a full backup`

**Code:** `UNSUPPORTED`.
**When:** an incremental or differential `create`, when a collection the
chain does not follow was renamed to a name the filter takes — a collection
left out by `collections`, one a wider filter would take only from the next
full backup, or the `nxgt-restore-<uuid>` collections of a restore into the
database backed up.
**Why:** the documents of a collection not followed were never read, so the
change stream cannot give them, and a restore could not bring them back. A rename the other way — out of those backed up — is recorded as a
drop, and a rename between two names taken is replayed.
**Fix:** make a full backup; the incrementals after it read from there.

```ts
await backups.create(mongoSource({ db, collections: (name) => name.startsWith('orders') }));
```

### `mongoSource: an entry of the backup built on was asked for again; it has no fingerprint, so make a full backup`

**Code:** `MALFORMED`.
**When:** an incremental or differential `create`, as `@nxgt/backup` goes
through the entries of the backup it builds on.
**Why:** those entries are never read again: `@nxgt/backup` keeps each one
whose fingerprint is the one recorded, and every entry `mongoSource` writes
has one. An entry recorded without a fingerprint was written by another
source declaring the kind `mongo`, so this one cannot give it again.
**Fix:** a full backup with `mongoSource`, then incrementals from it.

```ts
await backups.create(mongoSource({ db }));
```

## Restoring

`mongoTarget` takes the entries in the order the backup holds them: each
collection's `metadata/<name>`, then its `documents/<name>`, then the
`changes/<n>` of each incremental in the chain. A collection lands whole or
not at all; the collections before it in the backup stay restored.

### `mongoTarget: a collection or view the backup holds is already in the database; restore into another one, or pass replace: true`

**Code:** `EXISTS`.
**When:** `restore` into a database that already holds a collection or view
of the same name — the database the backup was made from, or one a first
restore already filled. Also when the `changes` of an incremental backup
create a collection that is there, or replay a rename onto a name that is
taken, where the rename at the source replaced nothing. A rename that did
replace a collection at the source replaces it here too.
**Why:** a restore never writes over data without being asked to: the
collection there is left untouched, and the one from the backup is not
created.
**Fix:** restore into an empty database, or replace what is there — each
collection the backup holds is dropped and created anew, the others are
left as they are.

```ts
await backups.restore(id, mongoTarget({ db: client.db('shop-restored') }), { identities });
await backups.restore(id, mongoTarget({ db, replace: true }), { identities });
```

After a refusal partway through a restore, drop the database before
restoring again without `replace`: the collections before the refused one
were restored.

### `mongoTarget: an entry name is not one this version writes`

**Code:** `MALFORMED`.
**When:** `restore` with `mongoTarget`, at the first entry whose name is
not `metadata/<collection>`, `documents/<collection>` or `changes/<n>`.
**Why:** the backup was not made by `mongoSource` — a `directorySource`
backup restored into a database, say — or by a later version with entries
this one does not know.
**Fix:** restore a backup of `mongoSource` into `mongoTarget`, and any other
into the target of its kind.

```ts
import { directoryTarget } from '@nxgt/backup';

await files.restore(id, directoryTarget({ path: '/srv/restore' }), { identities });
```

### `mongoTarget: a collection’s documents came before its metadata`

**Code:** `MALFORMED`.
**When:** `restore` with `only`, when it picks `documents/<collection>`
without `metadata/<collection>`.
**Why:** a collection is created from its metadata — its options,
validator, collation and indexes — before its documents land; without it,
the documents have nowhere to go.
**Fix:** take both entries of each collection. This is for a full backup:
the `changes` of an incremental one may touch any collection, so restore it
whole.

```ts
const wanted = new Set(['orders', 'customers']);
await backups.restore(id, mongoTarget({ db }), {
	identities,
	only: (name) => wanted.has(name.slice(name.indexOf('/') + 1)),
});
```

### `mongoTarget: a metadata entry is not one this version wrote`

**Code:** `MALFORMED`.
**When:** `restore`, at a `metadata/<collection>` entry.
**Why:** its content is not the options and indexes `mongoSource` writes,
as Extended JSON — the backup came from another source, or from a later
version of this package.
**Fix:** restore it with the version that made it, or a later one.

```sh
bun add @nxgt/mongo-backup@latest
```

### `mongoTarget: a metadata entry is larger than 16 MiB`

**Code:** `MALFORMED`.
**When:** `restore`, at a `metadata/<collection>` entry.
**Why:** a metadata entry holds a collection's options and indexes, never
its documents; none `mongoSource` writes comes near 16 MiB, so one that
does was not written by it.
**Fix:** check the backup is one of `mongoSource`, and that it is whole.

```ts
await backups.verify(id, { identities });
```

### `mongoTarget: an entry is not a sequence of BSON documents`

**Code:** `MALFORMED`.
**When:** `restore`, while a `documents/<collection>` or `changes/<n>` entry
is read. For `documents`, the collection being restored is dropped and
nothing of it lands; for `changes`, those before the damaged point were
applied.
**Why:** the bytes are not BSON documents one after the other, as
`mongodump` writes them: the entry was not written by `mongoSource`, or it
was damaged on the way — in which case `@nxgt/backup`'s own integrity check
may report it first.
**Fix:** verify the backup with its keys: it checks every entry against
what the source gave.

```ts
const verified = await backups.verify(id, { identities });
```

### `mongoTarget: a change is not one this version wrote`

**Code:** `MALFORMED`.
**When:** `restore` of an incremental or differential backup, at its
`changes/<n>` entry; the changes before that one in the entry were
applied.
**Why:** the entry holds BSON documents, but not the change records
`mongoSource` writes — it came from another source, or from a later
version of this package.
**Fix:** restore it with the version that made it, or a later one.

```sh
bun add @nxgt/mongo-backup@latest
```
