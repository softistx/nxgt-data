# @nxgt/mongo-backup

MongoDB as a source and a target for
[`@nxgt/backup`](https://www.npmjs.com/package/@nxgt/backup): encrypted,
verifiable backups of a whole database, on **Bun**.

- a **full** backup reads every collection in **one snapshot**, at one
  cluster time, so the collections agree with each other however long the
  read takes — their options and indexes included;
- an **incremental** or **differential** backup reads the **change stream**
  from where the backup it builds on stopped: documents written, updated and
  deleted, collections created, modified, renamed and dropped, indexes built
  and dropped;
- a **restore** lands each collection **whole or not at all**, into the same
  database or another one, and applies recorded changes only once their
  entry has been checked to its end;
- documents are kept as `mongodump` writes them, concatenated BSON, so no
  number changes kind: an `Int32` stays an `Int32`, a `Decimal128` a
  `Decimal128`.

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoSource, mongoTarget } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string); // a replica set
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string], // age1… — a public key
});
const identities = [process.env.BACKUP_IDENTITY as string]; // AGE-SECRET-KEY-1…
const source = mongoSource({ db: client.db('shop') });

const full = await backups.create(source);
// { kind: 'full', parent: null, entries: …, … } — every collection at one cluster time

const next = await backups.create(source, { kind: 'incremental', identities });
// { kind: 'incremental', parent: full.id, reused: …, … } — the change stream since `full`

// The database as it was at `next`, into another database:
await backups.restore(next.id, mongoTarget({ db: client.db('shop-restored') }), { identities });
```

> **0.x.** Full, incremental and differential backups of one database, and
> restores into it or another — whole, or some collections or documents —
> are here. What comes next — and what was
> ruled out — is in the [roadmap](docs/roadmap.md).

## Install

```sh
bun add @nxgt/mongo-backup @nxgt/backup mongodb
bun add -d @types/bun typescript
```

- **Bun only**, as `@nxgt/backup` is: zstd, hashing and the files a restore
  stages are Bun's own.
- **Required peers:** `@nxgt/backup` 0.6, `mongodb` `>=7.0.0 <8` (the
  Node.js driver), `typescript` `^6.0.3`.
- **A replica set.** A snapshot read and a change stream need one; a
  standalone `mongod` cannot serve either. A single-node replica set is
  enough. A sharded cluster serves both too, but is **untested**: the specs
  run against a replica set, and a restore does not shard a collection.
- **MongoDB 6.1 or later** for incremental and differential backups: they
  read the change stream's expanded events (collections and indexes created,
  modified, dropped) and its `disambiguatedPaths`, which 6.0 and 6.1 added.
  The specs run against MongoDB 8.2.
- It does not depend on `@nxgt/mongo`: it takes the driver's `Db`, so an
  application on the plain driver uses it as is.

## Back up

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoSource } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const { id, entries } = await backups.create(
	mongoSource({
		db: client.db('shop'),
		collections: (name) => !name.startsWith('cache.'), // or a list of names; all by default
	}),
);
```

A full backup holds, for each collection, `metadata/<name>` — its options
(validator, collation, capped…) and its indexes — then `documents/<name>`,
every document as concatenated BSON. A view has its metadata only, its
pipeline included. A GridFS bucket is two collections like any other,
`<bucket>.files` and `<bucket>.chunks`. `system.*` is never read. Entries
come in collection-name order — [format](docs/guide/format.md).

**Choosing collections.** `collections` is a list of names or a test on each
name. A name in the list that the database lacks rejects the backup with
`TypeError: mongoSource: a collection named in collections is not in the
database` — a typo would otherwise back up nothing, and say nothing. A test
picks what it returns `true` for. Either applies to views too, and to the
changes an incremental records. A change to `collections` takes effect at
the next full backup: an incremental follows the collections its full
backup held, plus those created since that the filter takes —
[getting started](docs/guide/getting-started.md#choosing-collections).

## Incremental and differential

```ts
import { BackupError, bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { MongoBackupError, mongoSource } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});
const identities = [process.env.BACKUP_IDENTITY as string];
const source = mongoSource({ db: client.db('shop') });

try {
	await backups.create(source, { kind: 'incremental', identities });
} catch (error) {
	const startOver =
		(error instanceof BackupError && error.code === 'NOT_FOUND') || // nothing to build on yet
		(error instanceof MongoBackupError &&
			(error.code === 'HISTORY_LOST' || error.code === 'UNSUPPORTED' || error.code === 'MALFORMED'));
	if (!startOver) throw error;
	await backups.create(source); // a full one; the chain starts again from it
}
```

An incremental or differential adds **one entry**, `changes/<n>`, to the
entries of the backup it builds on, which are not read again. It reads the
database's change stream (with `showExpandedEvents`) from where that backup
stopped up to the time it started:

- **documents** inserted, replaced, updated and deleted. An update is kept
  as the fields it set, unset and the arrays it cut — or as the whole
  document, when the collection keeps **post-images**
  (`changeStreamPreAndPostImages`). An update to a field whose name holds a
  dot or is a number cannot be said without one, and is `UNSUPPORTED`;
- **collections** created, modified (`collMod`), renamed and dropped, and
  **indexes** created and dropped, in the collections the chain follows:
  those its full backup held, plus those created since that `collections`
  takes. A rename out of them is kept as a drop; a rename **into** them is
  `UNSUPPORTED`, since an incremental never read the documents it brings;
- a **dropped database**, which a restore applies as one; the next backup
  resumes after it.

The stream resumes from the **oplog**. An incremental whose last backup is
older than the oplog reaches back fails with `HISTORY_LOST`: back up more
often than the oplog window, and keep a weekly full backup —
[incremental](docs/guide/incremental.md).

## Restore

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoTarget } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const latest = (await backups.list()).backups.at(-1);
if (latest) {
	await backups.restore(
		latest.id,
		mongoTarget({
			db: client.db('shop-restored'), // the database backed up, or another
			replace: false, // the default: a collection already there is refused with EXISTS
			tmpDir: '/var/tmp', // where a changes entry is staged; the system's temp folder by default
		}),
		{ identities: [process.env.BACKUP_IDENTITY as string] },
	);
}
```

- **Each collection lands whole or not at all.** It is built under a
  staging name, `nxgt-restore-<uuid>`, with its options, filled, indexed,
  and renamed into place only once its entry has been checked to its end;
  any failure drops the staging collection.
- **A collection or view already there is refused** with `EXISTS`, before
  any of its documents is read, and nothing of it is touched — unless
  `replace: true`, which swaps it for the restored one. A recorded rename
  that replaced nothing at the source refuses one under its new name the
  same way.
- **Changes are staged, then applied.** A `changes/<n>` entry is written to
  `<tmpDir>/nxgt-mongo-changes-XXXXXX/changes.bson`, in a folder only the
  restoring user can read, until its stream has ended cleanly — a change
  applied cannot be taken back — then applied in order, and the folder
  removed.
- **A target serves one restore**: it remembers the metadata it read. Make
  a new `mongoTarget` for each `restore`.
- **Documents are written with `bypassDocumentValidation`**, so a document
  the validator would refuse today comes back as it was.

[Restore](docs/guide/restore.md) has the order, `replace`, restoring one
collection with `only`, and what a failure leaves.

## Restore part of a backup

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { restoreCollections } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});
const identities = [process.env.BACKUP_IDENTITY as string];
const latest = (await backups.list()).backups.at(-1);

if (latest) {
	// orders as it was at the backup, beside today's
	await restoreCollections(backups, latest.id, {
		identities,
		db: client.db('shop'),
		collections: ['orders'], // names at the backup's time; all by default
		as: { orders: 'orders-before' }, // or (name) => …; its own name by default
	});

	// one deleted customer, merged back into the live collection
	await restoreCollections(backups, latest.id, {
		identities,
		db: client.db('shop'),
		collections: ['customers'],
		documents: { filter: { _id: 'c-42' }, existing: 'keep' }, // or 'replace'
	});
}
```

- **The whole backup is rebuilt first**, chain included, in a scratch
  database — `nxgt-restore-<uuid>` on `db`'s client, or the empty one given
  as `scratch` — then dropped, failed or not. Getting one document costs a
  full restore, and the user needs the right to create that database.
- **Whole** (no `documents`): each collection moves into `db` with its
  options and indexes, and views are made again on their collection's new
  name. A name already taken is `EXISTS` before anything moves, unless
  `replace: true`.
- **Documents**: what `filter` matches is merged on `_id`; `existing` says
  whether a document already there is replaced or kept. A missing
  collection is made with the backup's options and indexes; views hold no
  documents and are left out. A key of an `as` map that names nothing
  restored is a `TypeError`, so a typo never lands a collection over the
  live one under its own name.
- A name in `collections` the backup lacks is `NOT_FOUND`. A sharded
  collection cannot be restored whole, and a `$lookup` inside a view is not
  renamed —
  [restoring part of a backup](docs/guide/restore.md#restoring-part-of-a-backup).

## API

| Export | |
| --- | --- |
| `mongoSource({ db, collections? })` | a `BackupSource` of `kind: 'mongo'` for one database. `collections` is a list of names or a test on each name; every collection and view but `system.*` by default |
| `mongoTarget({ db, replace?, tmpDir? })` | a `RestoreTarget` for one database, the one backed up or another. `replace` is `false` by default; `tmpDir` must be absolute |
| `restoreCollections(backups, id, options)` | some collections and views of a backup, chain included, into `db`: whole, or the documents a filter takes. `backups` is anything with `restore`, such as a `bindBackup` binding; resolves to `RestoredCollections` |
| `MongoBackupError` | what this package throws, with a `code` |

| Type | |
| --- | --- |
| `MongoSourceOptions`, `MongoTargetOptions` | what `mongoSource` and `mongoTarget` take |
| `RestoreCollectionsOptions`, `DocumentSelection` | what `restoreCollections` takes, and its `documents: { filter, existing }` |
| `RestoredCollections` | `Restored` plus `collections: { name, as, documents? }[]` |
| `Restorer` | what `restoreCollections` needs of `backups`: its `restore` |
| `CollectionFilter` | `readonly string[] \| ((name: string) => boolean)` |
| `MongoBackupErrorCode` | `'SNAPSHOT_TOO_OLD' \| 'CHANGING' \| 'HISTORY_LOST' \| 'UNSUPPORTED' \| 'EXISTS' \| 'MALFORMED' \| 'NOT_FOUND'` |

Everything else — `bindBackup`, `create`, `restore`, `verify`, `prune`,
keys, repositories — is `@nxgt/backup`'s.

## Errors

`MongoBackupError` has a `code`, and a message that says what went wrong
**without quoting a document, a collection name or a value**: a backup error
ends up in logs. The server's error, when there is one, is its `cause`.

| `code` | When | |
| --- | --- | --- |
| `SNAPSHOT_TOO_OLD` | a full backup took longer than the server keeps snapshot history | `mongoSource: the snapshot outlived the history the server keeps; raise minSnapshotHistoryWindowInSeconds, or back up fewer collections at a time` |
| `CHANGING` | a full backup found the collections, their options or their indexes different before and after pinning its snapshot, five times running | `mongoSource: the collections or their indexes kept changing while the snapshot was taken; try again when they settle` |
| `HISTORY_LOST` | the oplog no longer reaches back to where the last backup stopped | `mongoSource: the change stream cannot resume where the last backup stopped: the oplog no longer reaches back there; make a full backup` |
| `UNSUPPORTED` | a time-series collection; an update to a dotted or numeric field name without post-images; a rename into the collections the chain follows; more collections created, renamed or dropped since the full backup than a position records; a server that is not a replica set or a sharded cluster | `mongoSource: a collection was renamed into those backed up, with documents an incremental backup never read; make a full backup` |
| `EXISTS` | a collection or view the restore would write is already in the target database — a recorded rename's new name included, when it replaced nothing at the source | `mongoTarget: a collection or view the backup holds is already in the database; restore into another one, or pass replace: true` |
| `EXISTS` | `restoreCollections`, whole, without `replace`: a name it would land under is taken | `restoreCollections: a collection or view to restore is already in the database; restore it under another name, or pass replace: true` |
| `EXISTS` | the `scratch` given to `restoreCollections` is not empty | `restoreCollections: the scratch database holds collections; give an empty one` |
| `MALFORMED` | an entry, a change or a recorded position is not one this version wrote | `mongoTarget: a metadata entry is not one this version wrote` |
| `NOT_FOUND` | a name in `restoreCollections`' `collections` list is not in the backup | `restoreCollections: a collection named in collections is not in the backup` |

Wiring is a bare `TypeError`: `mongoSource: db must be a MongoDB Db`,
`mongoSource: collections must be a list of names or a function`,
`mongoSource: a collection named in collections is not in the database`,
`mongoTarget: db must be a MongoDB Db`,
`mongoTarget: tmpDir must be an absolute path`, and `restoreCollections`'
own — `db` or `scratch` not a `Db`, `scratch` the same database as `db`
or on another client, a malformed `documents`, `replace` with `documents`,
an `as` that gives a name MongoDB refuses or one name twice, or whose key
names nothing restored — listed in
[errors](docs/guide/errors.md#the-bare-typeerrors). Every `@nxgt/backup` error
passes through as it is, and so does an error from the driver — an
`E11000` duplicate key during a restore, a server error — **whose message
may quote collection names and values**: only `MongoBackupError` and the
bare `TypeError`s quote none. Every message is in
[troubleshooting](docs/troubleshooting.md); a handler is in
[errors](docs/guide/errors.md).

## Traps

- **A full backup holds the collections and indexes of its snapshot**: an
  index built while it runs arrives in the next incremental, and a
  collection dropped meanwhile is still read. One that keeps changing fails
  `CHANGING`; run it again when migrations and index builds have settled —
  [one cluster time](docs/guide/getting-started.md#one-cluster-time).
- **A full backup must finish inside the server's snapshot window** —
  `minSnapshotHistoryWindowInSeconds`, 300 seconds by default — or it fails
  `SNAPSHOT_TOO_OLD`. Raise it for a large database:
  `db.adminCommand({ setParameter: 1, minSnapshotHistoryWindowInSeconds: 3600 })` —
  [getting started](docs/guide/getting-started.md#a-long-snapshot).
- **Time-series collections are not backed up**: a full backup that meets
  one, or an incremental that sees one created among the collections it
  takes, fails `UNSUPPORTED`. Leave them out — a collection left out is
  passed over before its events are translated: `collections: (name) => name !== 'metrics'`.
- **The oplog must outlast the interval between backups**, or the next
  incremental fails `HISTORY_LOST` and the next backup must be full. Check
  the window with `rs.printReplicationInfo()` and schedule well inside it —
  [the oplog window](docs/guide/incremental.md#the-oplog-window).
- **An incremental that fails `UNSUPPORTED` or `HISTORY_LOST` fails again
  the next time**: the change it stopped on is still there. Make a full
  backup: `await backups.create(source)`.
- **A change to `collections` waits for the next full backup**: a wider
  filter does not take in an existing collection halfway through a chain,
  and a narrower one does not drop one. Make a full backup after changing
  it — [the collections a chain follows](docs/guide/incremental.md#the-collections-a-chain-follows).
- **After restoring into the database you back up, make a full backup**:
  the restore's own renames from `nxgt-restore-<uuid>` look like renames
  into the followed collections, and the next incremental fails
  `UNSUPPORTED` — [restore](docs/guide/restore.md#restoring-into-the-database-you-back-up).
- **Indexes are built after the documents**, on the staging collection: a
  large collection's restore spends a while on them, and the collection
  appears only once they are done.
- **Documents are restored with `bypassDocumentValidation`**: invalid ones
  come back as they were, and the restoring user needs that privilege (the
  built-in `restore` and `dbAdmin` roles have it).
- **A restore is whole per collection, not per backup**: a failure keeps
  the collections already restored and the changes already applied. Restore
  into a fresh database, then point the application at it —
  [restore](docs/guide/restore.md#what-a-failure-leaves).
- **A recorded `dropDatabase` drops the database restored into**, whatever
  else it holds. Restore into a database of its own.

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/getting-started.md](docs/guide/getting-started.md) — a first
  full backup and restore, `mongoSource`'s options, choosing collections,
  the snapshot, how its collections and indexes are read, its window, and
  a nightly job.
- [docs/guide/incremental.md](docs/guide/incremental.md) — what the change
  stream records, post-images and dotted fields, the collections a chain
  follows, renames, a dropped database, the oplog window, and a schedule.
- [docs/guide/restore.md](docs/guide/restore.md) — `mongoTarget`'s options,
  the order, staging, `EXISTS` and `replace`, changes and renames, one
  collection with `only`, another database, what a failure leaves, and
  restoring into the database you back up, and restoring part of a backup
  with `restoreCollections`.
- [docs/guide/format.md](docs/guide/format.md) — the entries, their names
  and bytes, the position and the collections it records, and reading a
  backup with `bsondump`.
- [docs/guide/errors.md](docs/guide/errors.md) — `MongoBackupError`, every
  code and message, and a handler for a scheduled job.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error, by the
  message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT
