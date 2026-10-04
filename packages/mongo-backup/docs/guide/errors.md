# Errors

This page lists everything `@nxgt/mongo-backup` throws — `MongoBackupError`
and its seven codes, and the bare `TypeError`s — with every message, and a
handler for a scheduled job.

```ts
import { MongoBackupError, mongoSource } from '@nxgt/mongo-backup';

try {
	await backups.create(mongoSource({ db }), { kind: 'incremental', identities });
} catch (error) {
	if (error instanceof MongoBackupError && error.code === 'HISTORY_LOST') {
		await backups.create(mongoSource({ db })); // the oplog moved on: start a new chain
	} else {
		throw error;
	}
}
```

## `MongoBackupError`

```ts
type MongoBackupErrorCode =
	| 'SNAPSHOT_TOO_OLD'
	| 'CHANGING'
	| 'HISTORY_LOST'
	| 'UNSUPPORTED'
	| 'EXISTS'
	| 'MALFORMED'
	| 'NOT_FOUND';

class MongoBackupError extends Error {
	readonly name: 'MongoBackupError';
	readonly code: MongoBackupErrorCode;
	constructor(message: string, code: MongoBackupErrorCode, options?: { cause?: unknown });
}
```

- **Its message never quotes a document, a collection name or a value.** A
  backup error ends up in logs, and a collection name can say more than it
  should. To know which collection, look at the backup's entries, or at the
  `cause`. That holds for `MongoBackupError` and the bare `TypeError`s
  only: an error from the driver passes through unchanged, and its message
  may quote names and values — [errors that pass through](#errors-that-pass-through).
- **`cause` is the server's error**, when there is one — for
  `SNAPSHOT_TOO_OLD` and `HISTORY_LOST`.
- **It passes through `@nxgt/backup` as it is**: `create` and `restore`
  reject with it, never wrapped. Check `instanceof MongoBackupError`
  before `code` — `@nxgt/backup`'s `BackupError` has a `code` too, and so
  does Node's `ENOENT`.

## The codes

### `SNAPSHOT_TOO_OLD`

A full backup took longer than the server keeps the history its snapshot
reads — [a long snapshot](getting-started.md#a-long-snapshot).

```text
mongoSource: the snapshot outlived the history the server keeps; raise minSnapshotHistoryWindowInSeconds, or back up fewer collections at a time
```

### `CHANGING`

A full backup reads the collections, their options and their indexes
before it pins its snapshot and again after, and pins again while the two
differ. After five attempts it gives up: something kept creating, dropping,
renaming or indexing collections the filter takes. Nothing was stored; run
the backup again once that work has settled —
[one cluster time](getting-started.md#one-cluster-time).

```text
mongoSource: the collections or their indexes kept changing while the snapshot was taken; try again when they settle
```

```ts
async function fullBackup(attempts = 3) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await backups.create(source);
		} catch (error) {
			if (!(error instanceof MongoBackupError && error.code === 'CHANGING') || attempt === attempts) {
				throw error;
			}
			await Bun.sleep(60_000); // let the migration or the index build finish
		}
	}
}
```

### `HISTORY_LOST`

An incremental or differential cannot resume where its parent stopped: the
oplog no longer reaches back there. Every incremental on that parent fails
the same way; the next backup must be full —
[the oplog window](incremental.md#the-oplog-window).

```text
mongoSource: the change stream cannot resume where the last backup stopped: the oplog no longer reaches back there; make a full backup
```

### `UNSUPPORTED`

The database holds something this version does not back up. The first
four repeat until the cause is gone or a full backup moves past it; the
last two come from the deployment.

| Message | When |
| --- | --- |
| `mongoSource: a collection is of a type this version does not back up (a time-series one); leave it out with collections` | a full backup meets a time-series collection, or an incremental sees one created among the collections it takes — [choosing collections](getting-started.md#choosing-collections) |
| `mongoSource: an update touched a field whose name holds a dot or is a number, which a change cannot say without its post-image; turn on changeStreamPreAndPostImages for that collection, or make a full backup` | an incremental meets such an update in a collection the chain follows, without post-images — [post-images](incremental.md#post-images-and-dotted-field-names) |
| `mongoSource: a collection was renamed into those backed up, with documents an incremental backup never read; make a full backup` | a collection the chain does not follow was renamed to a name the filter takes — a restore's own renames from `nxgt-restore-<uuid>`, into the database backed up, among them — [renames](incremental.md#renames) |
| `mongoSource: the collections created, renamed or dropped since the full backup are too many to record; make a full backup` | an incremental whose chain has seen thousands of collections created, renamed or dropped since its full backup — [format](format.md#the-position-and-the-fingerprints) |
| `mongoSource: the server gave no operation time; a backup needs a replica set or a sharded cluster` | an incremental, against a server that is not one |
| `mongoSource: the server gave no snapshot time; a backup needs a replica set or a sharded cluster` | a full backup, against a server that is not one |

Against a standalone `mongod`, the server may refuse the snapshot read or
the change stream with its own error first; either way, the answer is a
replica set — a single-node one is enough.

### `EXISTS`

A collection or view the restore would write is already in the target
database — one the backup holds, one a recorded `create` makes, or the new
name of a recorded rename that replaced nothing at the source. Nothing of
it was touched — [`EXISTS` and `replace`](restore.md#exists-and-replace).

| Message | When |
| --- | --- |
| `mongoTarget: a collection or view the backup holds is already in the database; restore into another one, or pass replace: true` | a `restore` through `mongoTarget`, without `replace` |
| `restoreCollections: a collection or view to restore is already in the database; restore it under another name, or pass replace: true` | `restoreCollections` in whole mode, without `replace`: a name `as` gives is taken in `db`, checked before anything moves, or taken in the meantime and refused at its rename — [whole collections](restore.md#whole-collections) |
| `restoreCollections: the scratch database holds collections; give an empty one` | the `scratch` given is not empty; it is left as it was — [the scratch database](restore.md#the-scratch-database) |

### `MALFORMED`

An entry, a change or a position is not one this version wrote: a backup
made by something else, or by a later version with a format this one does
not read.

| Message | When |
| --- | --- |
| `mongoSource: the backup built on recorded no position this version reads; make a full backup` | an incremental's parent recorded no position, or one this version did not write |
| `mongoSource: an entry of the backup built on was asked for again; it has no fingerprint, so make a full backup` | the parent recorded an entry without a fingerprint |
| `mongoTarget: an entry name is not one this version writes` | an entry named other than `metadata/…`, `documents/…` or `changes/<6 to 9 digits>` |
| `mongoTarget: a metadata entry is larger than 16 MiB` | a metadata entry far larger than options and indexes can be |
| `mongoTarget: a metadata entry is not one this version wrote` | a metadata entry whose `format`, `type`, `options` or `indexes` is not this version's |
| `mongoTarget: a collection’s documents came before its metadata` | `documents/<c>` without `metadata/<c>` before it — `only` picked one and not the other |
| `mongoTarget: an entry is not a sequence of BSON documents` | a `documents/` or `changes/` entry with a length that cannot be a document's, or cut inside one |
| `mongoTarget: a change is not one this version wrote` | a change record this version cannot apply |

The apostrophe in `collection’s` is a typographic one, `’`: search for
`documents came before its metadata`.

### `NOT_FOUND`

A name in the list `restoreCollections` was given as `collections` is not
in the backup — as its collections were named at the backup's time, after
every rename the chain replays. It comes after the backup was rebuilt, and
before anything reaches `db` —
[`collections`](restore.md#collections-names-at-the-backups-time).

```text
restoreCollections: a collection named in collections is not in the backup
```

`@nxgt/backup`'s `BackupError` has a `NOT_FOUND` too — a backup id that is
not there: check `instanceof` before `code`.

## The bare `TypeError`s

Wiring that could never work is a `TypeError`, not a `MongoBackupError`.
`mongoSource` and `mongoTarget` throw theirs at once, but for
`mongoSource: a collection named in collections is not in the database`,
which `create` throws when the full backup lists the collections.
`restoreCollections` rejects with its own before reading anything, but for
the three about `as` it can only tell from the backup's names — anything
a function gives, a map naming a collection after one that keeps its
own, and a map key naming nothing restored: those come after the rebuild,
and before anything reaches `db`.

| Message | When |
| --- | --- |
| `mongoSource: db must be a MongoDB Db` | `db` is missing, or is not a driver `Db` — a name, a client |
| `mongoSource: collections must be a list of names or a function` | `collections` is a string, or a list holding something else |
| `mongoSource: a collection named in collections is not in the database` | a name in the list that the database lacks |
| `mongoTarget: db must be a MongoDB Db` | `db` is missing, or is not a driver `Db` |
| `mongoTarget: tmpDir must be an absolute path` | a relative `tmpDir` |
| `restoreCollections: db must be a MongoDB Db` | `db` is missing, or is not a driver `Db` |
| `restoreCollections: scratch must be a MongoDB Db` | `scratch` is given, and is not a driver `Db` |
| `restoreCollections: scratch must be on db's client` | `scratch` comes from another `MongoClient` |
| `restoreCollections: scratch must be another database` | `scratch` has `db`'s name |
| `restoreCollections: documents must be { filter, existing: 'replace' \| 'keep' }` | a `filter` that is not a query object, or an `existing` other than those two |
| `restoreCollections: replace is for whole collections; documents says what happens to those there` | `replace` given with `documents` |
| `restoreCollections: as must give a collection name` | `as` gives an empty name, one holding `$` or a NUL, one starting with `system.`, or something not a string |
| `restoreCollections: as gives two collections one name` | `as` gives two collections or views the same name |
| `restoreCollections: as names a collection not restored` | a key of an `as` map names no collection or view restored — a typo, or a view when `documents` is given; checked once the backup has been rebuilt |

## Errors that pass through

- **The driver's errors** — a lost connection, an authentication failure, a
  write the server refuses on restore (`E11000 duplicate key error`, say) —
  reject `create` or `restore` unchanged, as the driver threw them. **Their
  messages may quote collection names, index keys and values**: redact them
  before they reach a shared log, or log `error.code` and `error.name` only.
- **`@nxgt/backup`'s** — `NOT_FOUND`, `INTEGRITY`, `DECRYPT`, `LOCKED`,
  `PARTIAL`, … — are its own `BackupError`, documented with it:
  [errors](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/errors.md).

## A handler for a scheduled job

What to do with each failure of a nightly incremental: start a new chain
when the chain cannot go on, and alert on everything else.

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

/** A full backup, tried again while the collections are changing. */
async function fullBackup(attempts = 3) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await backups.create(source);
		} catch (error) {
			const changing = error instanceof MongoBackupError && error.code === 'CHANGING';
			if (!changing || attempt === attempts) throw error;
			await Bun.sleep(60_000);
		}
	}
}

/** Whether a new full backup is the answer to `error`. */
function startsOver(error: unknown): boolean {
	if (error instanceof BackupError) return error.code === 'NOT_FOUND';
	if (!(error instanceof MongoBackupError)) return false;
	switch (error.code) {
		case 'HISTORY_LOST': // the oplog moved on
		case 'MALFORMED': // a parent this version cannot build on
		// A full backup gets past a rename or a dotted update. A time-series
		// collection fails it too, with the same code, and that error reaches you.
		case 'UNSUPPORTED':
			return true;
		default:
			return false; // SNAPSHOT_TOO_OLD and CHANGING come from a full backup; EXISTS and NOT_FOUND from a restore
	}
}

try {
	await backups.create(source, { kind: 'incremental', identities });
} catch (error) {
	if (!startsOver(error)) throw error; // alert: a person must look
	await fullBackup();
} finally {
	await client.close();
}
```
