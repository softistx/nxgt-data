# @nxgt/mongo-backup

Encrypted, signed, verifiable backups of a MongoDB database, on **Bun**:
`mongoBackups` makes a full backup a week and incrementals in between, reads
each one back, rotates them, and restores a whole database or part of it.
It is built on [`@nxgt/backup`](https://www.npmjs.com/package/@nxgt/backup),
and its lower-level source and target stay there for what it does not do.

- a **full** backup reads every collection in **one snapshot**, at one
  cluster time, so the collections agree with each other however long the
  read takes — their options and indexes included;
- an **incremental** backup reads the **change stream** from where the
  backup it builds on stopped: documents written, updated and deleted,
  collections created, modified, renamed and dropped, indexes built and
  dropped;
- a **restore** lands each collection **whole or not at all**, into the same
  database or another one — or only some collections, under other names, or
  only the documents a query takes;
- documents are kept as `mongodump` writes them, concatenated BSON, so no
  number changes kind: an `Int32` stays an `Int32`, a `Decimal128` a
  `Decimal128`.

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key   # once; keep a copy away from the backups
```

```ts
import { mongoBackups } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string); // a replica set
const backups = mongoBackups({
	db: client.db('shop'),
	repository: '/mnt/backups', // an absolute folder, or @nxgt/backup repositories
	keyFile: '/etc/backup/shop.key',
});

await backups.run(); // hourly: a full backup or an incremental, read back, rotated
await backups.drill(); // daily: the newest restored apart, counted, dropped
await backups.restore({ into: client.db('shop-restored') }); // the newest, whole
```

> **0.x.** Full and incremental backups of one database on a schedule, and
> restores into it or another — whole, or some collections or documents —
> are here. What comes next — and what was ruled out — is in the
> [roadmap](docs/roadmap.md).

## Install

```sh
bun add @nxgt/mongo-backup @nxgt/backup mongodb
bun add -d @types/bun typescript
```

- **Bun only**, as `@nxgt/backup` is: zstd, hashing, the files a restore
  stages and the `nxgt-mongo-backup` bin are Bun's own.
- **Required peers:** `@nxgt/backup` 0.6, `mongodb` `>=7.0.0 <8` (the
  Node.js driver), `typescript` `^6.0.3`.
- **`age-encryption` is a dependency**, installed with it: the key file
  holds an age identity.
- **A replica set.** A snapshot read and a change stream need one; a
  standalone `mongod` cannot serve either. A single-node replica set is
  enough. A sharded cluster serves both too, but is **untested**: the specs
  run against a replica set, and a restore does not shard a collection.
- **MongoDB 6.1 or later** for incremental backups: they read the change
  stream's expanded events (collections and indexes created, modified,
  dropped) and its `disambiguatedPaths`, which 6.0 and 6.1 added. The specs
  run against MongoDB 8.2.
- It does not depend on `@nxgt/mongo`: it takes the driver's `Db`, so an
  application on the plain driver uses it as is.

## Setup

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key
# key file written: /etc/backup/shop.key
# recipient: age1…
# keep a copy of it away from the backups
```

The key file holds the age identity every backup is encrypted for and the
Ed25519 key every manifest is signed with. It is written with mode `0600`
and never overwritten; the bin prints only the public recipient.
**Without it the backups are noise**: keep a copy where the backups are
not. `generateKeyFile(path)` writes the same file from code —
[the key file](docs/guide/getting-started.md#the-key-file).

## Back up: `run`

```ts
import { mongoBackups } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
try {
	const report = await mongoBackups({
		db: client.db('shop'),
		repository: '/mnt/backups',
		keyFile: '/etc/backup/shop.key',
		collections: (name) => name !== 'metrics', // or a list of names; all by default
	}).run();
	console.log(JSON.stringify(report));
	// {"id":"…","kind":"incremental","fellBack":false,"entries":1,"storedSize":2048,"chain":3,"removed":[]}
} finally {
	await client.close();
}
```

- **A full backup when none is younger than `fullEvery`** (a week by
  default), an incremental otherwise.
- **`HISTORY_LOST` falls back to a full backup** at once, with
  `fellBack: true`: the oplog no longer reaches the last backup. Any other
  error is thrown.
- **The new backup is read back** with the key — decrypted, every digest
  and the signature checked — then the rotation runs, `DEFAULT_KEEP` by
  default, `keep: false` to keep everything.
- The report holds ids, kinds and sizes: never a key nor a document.

## Restore: `restore`

```ts
import { mongoBackups } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = mongoBackups({ db: client.db('shop'), repository: '/mnt/backups', keyFile: '/etc/backup/shop.key' });

// the whole database as it was at 9:00, into another one
await backups.restore({ into: client.db('shop-restored'), at: new Date('2026-10-04T09:00:00Z') });

// orders as it was in the newest backup, beside today's
await backups.restore({ into: client.db('shop'), collections: ['orders'], as: { orders: 'orders-before' } });

// one deleted customer, merged back into the live collection
await backups.restore({
	into: client.db('shop'),
	collections: ['customers'],
	documents: { filter: { _id: 'c-42' }, existing: 'keep' }, // or 'replace'
});
```

- **`at`** is a backup's id, or a `Date`: the newest backup made at or
  before it. The newest of all by default.
- **Whole** when none of `collections`, `as` and `documents` is given: each
  collection lands whole or not at all.
- **Part** otherwise: the whole backup is rebuilt in a scratch database
  first, then what was asked for moves into `into`. The report then has
  `collections`.
- **A collection already there is refused** with `EXISTS` unless
  `replace: true` — whole, or part by `collections` or `as`. With
  `documents`, `existing` says what happens to those there, and `replace`
  is refused, by the types and at run time.

[Restore](docs/guide/restore.md) has the detail of both.

## Drill: `drill`

```ts
const drilled = await backups.drill();
// { id: '…', collections: [{ name: 'customers', documents: 1204 }, { name: 'orders', documents: 98311 }] }
```

The newest backup, chain included, restored into `nxgt-drill-<uuid>` on the
same client, each collection's documents counted (views apart), and the
database dropped, failed or not. A backup never restored is a hope —
[running it in production](docs/guide/operations.md).

## Lower level

`mongoBackups` is built on three exports a consumer can use directly, with
`@nxgt/backup`'s `bindBackup`: for differential backups, keys kept apart
rather than in one file, a restore with `only`, or a schedule of your own.
`mongoBackups(…).binding()` gives the `@nxgt/backup` binding and keys it
uses, so the two levels mix.

### Back up with `mongoSource`

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoSource } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string], // age1… — a public key
});
const identities = [process.env.BACKUP_IDENTITY as string]; // AGE-SECRET-KEY-1…
const source = mongoSource({
	db: client.db('shop'),
	collections: (name) => !name.startsWith('cache.'), // or a list of names; all by default
});

const full = await backups.create(source);
// { kind: 'full', parent: null, entries: …, … } — every collection at one cluster time
const next = await backups.create(source, { kind: 'incremental', identities });
// { kind: 'incremental', parent: full.id, … } — the change stream since `full`
```

A full backup holds, for each collection, `metadata/<name>` — its options
(validator, collation, capped…) and its indexes — then `documents/<name>`,
every document as concatenated BSON. A view has its metadata only, its
pipeline included. A GridFS bucket is two collections like any other,
`<bucket>.files` and `<bucket>.chunks`. `system.*` is never read. Entries
come in collection-name order — [format](docs/guide/format.md).

**Choosing collections.** `collections` — `mongoSource`'s and
`mongoBackups`' alike — is a list of names or a test on each name. A name
in the list that the database lacks rejects the backup with
`TypeError: mongoSource: a collection named in collections is not in the
database` (`run on "shop": …` through `mongoBackups`) — a typo would otherwise back up nothing, and say nothing. A test
picks what it returns `true` for. Either applies to views too, and to the
changes an incremental records. A change to `collections` takes effect at
the next full backup —
[getting started](docs/guide/getting-started.md#choosing-collections).

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
older than the oplog reaches back fails with `HISTORY_LOST` —
[incremental](docs/guide/incremental.md).

### Restore with `mongoTarget`

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
  `replace: true`, which swaps it for the restored one.
- **Changes are staged, then applied.** A `changes/<n>` entry is written to
  `<tmpDir>/nxgt-mongo-changes-XXXXXX/changes.bson`, in a folder only the
  restoring user can read, until its stream has ended cleanly, then applied
  in order, and the folder removed.
- **A target serves one restore**: it remembers the metadata it read. Make
  a new `mongoTarget` for each `restore`.
- **Documents are written with `bypassDocumentValidation`**, so a document
  the validator would refuse today comes back as it was.

### Restore part of a backup with `restoreCollections`

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { restoreCollections } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});
const latest = (await backups.list()).backups.at(-1);

if (latest) {
	await restoreCollections(backups, latest.id, {
		identities: [process.env.BACKUP_IDENTITY as string],
		db: client.db('shop'),
		collections: ['orders'], // names at the backup's time; all by default
		as: { orders: 'orders-before' }, // or (name) => …; its own name by default
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
  whether a document already there is replaced or kept. Views hold no
  documents and are left out.
- A name in `collections` the backup lacks is `NOT_FOUND`; a key of an `as`
  map that names nothing restored is a `TypeError` —
  [restoring part of a backup](docs/guide/restore.md#restoring-part-of-a-backup).

## API

| Export | |
| --- | --- |
| `mongoBackups({ db, repository, keyFile, name?, collections?, fullEvery?, keep?, tmpDir? })` | the main way in: `{ run(now?), restore(options), drill(), list(), binding() }` for one database. `repository` is an absolute folder or `@nxgt/backup` repositories; `name` is `db.databaseName` by default |
| `generateKeyFile(path)` | writes a new key file, mode `0600`, never over another; resolves to `{ recipient }`. The bin `nxgt-mongo-backup keygen <path>` calls it |
| `readKeyFile(path, where?)` | the `BackupKeys` in a key file; refuses with `KEY_FILE` one that is not there, one others than its owner can read or write, or one `keygen` did not write. Its messages start with `readKeyFile:`, or `mongoBackups on "<name>":` through `mongoBackups` |
| `DEFAULT_FULL_EVERY` | `604_800_000`: a week, in milliseconds |
| `DEFAULT_KEEP` | `{ last: 24, daily: 14, weekly: 8, monthly: 12 }` |
| `mongoSource({ db, collections? })` | a `BackupSource` of `kind: 'mongo'` for one database. `collections` is a list of names or a test on each name; every collection and view but `system.*` by default |
| `mongoTarget({ db, replace?, tmpDir? })` | a `RestoreTarget` for one database, the one backed up or another. `replace` is `false` by default; `tmpDir` must be absolute |
| `restoreCollections(backups, id, options)` | some collections and views of a backup, chain included, into `db`: whole, or the documents a filter takes. `backups` is anything with `restore`, such as a `bindBackup` binding; resolves to `RestoredCollections` |
| `MongoBackupError` | what this package throws, with a `code` |

| Type | |
| --- | --- |
| `MongoBackups`, `MongoBackupsOptions` | what `mongoBackups` returns, and what it takes |
| `RestoreAtOptions` | what `restore` takes: `{ into, at?, collections?, as?, replace? }`, or `{ into, at?, collections?, as?, documents }` — `replace` and `documents` never together |
| `RunReport` | `{ id, kind, fellBack, entries, storedSize, chain, removed }` |
| `RestoreReport` | `Restored`, plus `collections` for a partial restore |
| `DrillReport` | `{ id, collections: { name, documents }[] }` |
| `BackupKeys` | `{ identity, recipient, signingKey, publicKey }` |
| `MongoSourceOptions`, `MongoTargetOptions` | what `mongoSource` and `mongoTarget` take |
| `RestoreCollectionsOptions`, `DocumentSelection` | what `restoreCollections` takes, and its `documents: { filter, existing }` |
| `RestoredCollections` | `Restored` plus `collections: { name, as, documents? }[]` |
| `Restorer` | what `restoreCollections` needs of `backups`: its `restore` |
| `CollectionFilter` | `readonly string[] \| ((name: string) => boolean)` |
| `MongoBackupErrorCode` | `'SNAPSHOT_TOO_OLD' \| 'CHANGING' \| 'HISTORY_LOST' \| 'UNSUPPORTED' \| 'EXISTS' \| 'MALFORMED' \| 'NOT_FOUND' \| 'KEY_FILE'` |

Repositories, `bindBackup`, `create`, `verify`, `prune` and `KeepPolicy`
are `@nxgt/backup`'s.

## Errors

`MongoBackupError` has a `code`, and a message that says what went wrong
**without quoting a document, a collection name, a value or a key**: a
backup error ends up in logs. The server's error, when there is one, is its
`cause`.

**Through `mongoBackups`, the prefix names the call.** The `mongoSource:`,
`mongoTarget:` and `restoreCollections:` messages below are quoted as the
lower-level functions throw them. `run`, `restore` and `drill` replace that
prefix with `run on "shop":`, `restore on "shop":` or `drill on "shop":` —
the backup's name — and keep the rest, the class and the `code`; a
`mongoSource:` or `mongoTarget:` one keeps the original error as its
`cause` (and `restoreCollections`, called directly, renames the
`mongoTarget:` ones of its scratch restore the same way):
`restore on "shop": a collection or view the backup holds is already in the database; …`.

| `code` | When | |
| --- | --- | --- |
| `KEY_FILE` | there is no file at `keyFile`; the `ENOENT` is its `cause`, and the file is looked for again on the next call | `mongoBackups on "shop": there is no key file there; write one with nxgt-mongo-backup keygen` |
| `KEY_FILE` | its group or others can read or write the key file | `mongoBackups on "shop": others than its owner can read or write the key file; chmod 600 it` |
| `KEY_FILE` | the key file is not one `keygen` wrote | `mongoBackups on "shop": the key file is not one keygen wrote` |
| `NOT_FOUND` | `restore` or `drill` with no backup in the repository; `shop` is the backup's name | `restore on "shop": the repository holds no backup yet`, `drill on "shop": the repository holds no backup yet` |
| `NOT_FOUND` | `restore` with an `at` older than every backup | `restore on "shop": no backup was made at or before that time` |
| `NOT_FOUND` | a name in `collections` is not in the backup, for a partial restore — `restoreCollections:` when it is called directly | `restore on "shop": a collection named in collections is not in the backup` |
| `SNAPSHOT_TOO_OLD` | a full backup took longer than the server keeps snapshot history | `mongoSource: the snapshot outlived the history the server keeps; raise minSnapshotHistoryWindowInSeconds, or back up fewer collections at a time` |
| `CHANGING` | a full backup found the collections, their options or their indexes different before and after pinning its snapshot, five times running | `mongoSource: the collections or their indexes kept changing while the snapshot was taken; try again when they settle` |
| `HISTORY_LOST` | the oplog no longer reaches back to where the last backup stopped — `run` falls back to a full backup instead | `mongoSource: the change stream cannot resume where the last backup stopped: the oplog no longer reaches back there; make a full backup` |
| `UNSUPPORTED` | a time-series collection; an update to a dotted or numeric field name without post-images; a rename into the collections the chain follows; more collections created, renamed or dropped since the full backup than a position records; a server that is not a replica set or a sharded cluster | `mongoSource: a collection was renamed into those backed up, with documents an incremental backup never read; make a full backup` |
| `EXISTS` | a collection or view the restore would write is already there, without `replace` | `mongoTarget: a collection or view the backup holds is already in the database; restore into another one, or pass replace: true` |
| `EXISTS` | a partial restore, whole, without `replace`: a name it would land under is taken — `restore on "shop":` rather than `restoreCollections:` through `restore` | `restoreCollections: a collection or view to restore is already in the database; restore it under another name, or pass replace: true` |
| `MALFORMED` | an entry, a change or a recorded position is not one this version wrote | `mongoTarget: a metadata entry is not one this version wrote` |

Wiring is a bare `TypeError`, thrown by `mongoBackups` itself:
`mongoBackups: db must be a MongoDB Db`,
`mongoBackups: keyFile must be an absolute path`,
`mongoBackups: repository must be an absolute folder, or repositories`,
`mongoBackups: keep must be false, or name rules each a whole number, 1 or more`,
`mongoBackups: fullEvery must be a whole number of milliseconds, an hour or more`,
`mongoBackups: repository must list repositories, each under a name of its own`,
`mongoBackups: tmpDir must be an absolute path`,
`mongoBackups: name must be 1 to 100 characters, …` and
`mongoBackups: the database's name cannot name a backup; give name: 1 to 100 characters, …`;
by `run` and `restore`, before anything is read, naming the call and the
backup: `run on "shop": now must be a valid Date`,
`restore on "shop": into must be a MongoDB Db`,
`restore on "shop": at must be a backup's id or a valid Date`,
`restore on "shop": replace is for whole collections; documents says what happens to those there`
— and by the lower-level exports. A partial `restore` refuses as
`restoreCollections` does, but with `restore on "shop":` where it says
`restoreCollections:` — `restore on "shop": as names a collection not restored`.
All are listed in
[errors](docs/guide/errors.md#the-bare-typeerrors). Every `@nxgt/backup` error passes through as it is, and so does an
error from the driver — an `E11000` duplicate key during a restore, a
server error — **whose message may quote collection names and values**:
only `MongoBackupError` and the bare `TypeError`s quote none. Every message
is in [troubleshooting](docs/troubleshooting.md); a handler is in
[errors](docs/guide/errors.md).

## Traps

- **A lost key file is lost backups**: nothing reads them without its
  identity. Keep a copy away from the repository, and never commit it.
- **`name` is the database's name by default**, and a backup name is
  lowercase letters, digits, `.`, `_` and `-`: `client.db('MyShop')` throws
  `mongoBackups: the database's name cannot name a backup; …` — pass
  `name: 'myshop'`.
- **A full backup must finish inside the server's snapshot window** —
  `minSnapshotHistoryWindowInSeconds`, 300 seconds by default — or it fails
  `SNAPSHOT_TOO_OLD`. Raise it for a large database:
  `db.adminCommand({ setParameter: 1, minSnapshotHistoryWindowInSeconds: 3600 })` —
  [a long snapshot](docs/guide/getting-started.md#a-long-snapshot).
- **Time-series collections are not backed up**: a backup that meets one
  fails `UNSUPPORTED`. Leave them out:
  `collections: (name) => name !== 'metrics'`.
- **The oplog must outlast the interval between runs**, or every run is a
  full backup (`fellBack: true`). Check the window with
  `rs.printReplicationInfo()` —
  [the oplog window](docs/guide/incremental.md#the-oplog-window).
- **An incremental that fails `UNSUPPORTED` fails again on the next `run`**:
  the change it stopped on is still there. Make a full backup:
  `await backups.run(new Date(Date.now() + DEFAULT_FULL_EVERY))` —
  [forcing a full backup](docs/guide/operations.md#forcing-a-full-backup).
- **A change to `collections` waits for the next full backup** — the same
  way out.
- **After restoring into the database you back up, make a full backup**:
  the restore's own renames look like renames into the followed
  collections, and the next incremental fails `UNSUPPORTED` —
  [restore](docs/guide/restore.md#restoring-into-the-database-you-back-up).
- **`drill` and a partial `restore` rebuild the whole backup on your
  cluster**, in a database of their own: the user needs the right to create
  it, and the server the room for it.
- **A restore is whole per collection, not per backup**: a failure keeps
  the collections already restored. Restore into a fresh database, then
  point the application at it —
  [restore](docs/guide/restore.md#what-a-failure-leaves).
- **A recorded `dropDatabase` drops the database restored into**, whatever
  else it holds. Restore into a database of its own.

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/getting-started.md](docs/guide/getting-started.md) — the key
  file, `mongoBackups` and its options, `run`, `restore`, `drill`, `list`
  and `binding`; then `mongoSource`, choosing collections, the snapshot and
  its window.
- [docs/guide/operations.md](docs/guide/operations.md) — running it in
  production: the key file on the job host, the schedule, the oplog and
  snapshot windows, alerting, drills, forcing a full backup, and the
  `restore` calls for the day you need a backup back.
- [docs/guide/incremental.md](docs/guide/incremental.md) — what the change
  stream records, post-images and dotted fields, the collections a chain
  follows, renames, a dropped database, and the oplog window.
- [docs/guide/restore.md](docs/guide/restore.md) — `mongoTarget` and
  `restoreCollections`: the order, staging, `EXISTS` and `replace`, changes
  and renames, another database, what a failure leaves, and restoring part
  of a backup.
- [docs/guide/format.md](docs/guide/format.md) — the entries, their names
  and bytes, the position, and reading a backup with `bsondump`.
- [docs/guide/errors.md](docs/guide/errors.md) — `MongoBackupError`, every
  code and message, the `TypeError`s, and a handler for a scheduled job.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error, by the
  message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT
