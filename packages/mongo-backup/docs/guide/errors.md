# Errors

This page lists everything `@nxgt/mongo-backup` throws — `MongoBackupError`
and its eight codes, and the bare `TypeError`s — with every message, and a
handler for a scheduled job.

```ts
import { MongoBackupError, mongoBackups } from '@nxgt/mongo-backup';

const backups = mongoBackups({ db, repository: '/mnt/backups', keyFile: '/etc/backup/shop.key' });
try {
	console.log(JSON.stringify(await backups.run())); // HISTORY_LOST is handled inside: a full backup
} catch (error) {
	if (error instanceof MongoBackupError) console.error(`backup failed (${error.code}): ${error.message}`);
	throw error; // exit non-zero: the scheduler alerts
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
	| 'NOT_FOUND'
	| 'KEY_FILE';

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
- **Nor does it quote a key**, nor the content of the key file.
- **`cause` is the server's error**, when there is one — for
  `SNAPSHOT_TOO_OLD` and `HISTORY_LOST` — and the file system's `ENOENT`
  for a missing key file.
- **It passes through `@nxgt/backup` as it is**: `create` and `restore`
  reject with it, never wrapped. Check `instanceof MongoBackupError`
  before `code` — `@nxgt/backup`'s `BackupError` has a `code` too, and so
  does Node's `ENOENT`.

## The codes

### `KEY_FILE`

The key file `mongoBackups` was given cannot be used. It is read on the
first call — `run`, `restore`, `drill`, `list` or `binding` — not by
`mongoBackups` itself. `readKeyFile` throws the same, its messages
starting with `readKeyFile:` rather than `mongoBackups on "shop":`. A failed read is
tried again on the next call, so fixing the file needs no restart —
[the key file](getting-started.md#the-key-file).

| Message | When |
| --- | --- |
| `mongoBackups on "shop": there is no key file there; write one with nxgt-mongo-backup keygen` | nothing at that path; the `ENOENT` is its `cause`. Any other failure to open it — `EACCES`, `ENOTDIR` — is the system's error, as it is |
| `mongoBackups on "shop": others than its owner can read or write the key file; chmod 600 it` | its group or others have any right on it |
| `mongoBackups on "shop": the key file is not one keygen wrote` | it holds no age identity, no Ed25519 private key, or one that does not parse — an identity with a bad checksum, or a private key that is not Ed25519, among them. No `cause`: the parsers' own errors quote the key |

```ts
import { MongoBackupError } from '@nxgt/mongo-backup';

try {
	await backups.run();
} catch (error) {
	if (error instanceof MongoBackupError && error.code === 'KEY_FILE') {
		console.error(error.message); // never the key: safe to log
		process.exit(78); // a configuration error: no point in retrying before someone fixes the file
	}
	throw error;
}
```

### Through `mongoBackups`

**`run`, `restore` and `drill` rename the messages below.** A message that
starts with `mongoSource:` or `mongoTarget:` when you call those directly
starts, through `mongoBackups`, with the call and the backup's name —
`run on "shop":`, `restore on "shop":` or `drill on "shop":` — and the rest
is unchanged. The class and the `code` stay the same, and the original
error, with its own prefix, is the `cause`:

```ts
await backups.restore({ into: client.db('shop') }); // 'shop' already holds a collection
// MongoBackupError (EXISTS): restore on "shop": a collection or view the backup holds is already in the database; restore into another one, or pass replace: true
// error.cause.message: mongoTarget: a collection or view the backup holds is already in the database; …
```

Search for the part after the colon: every message on this page, and on
[troubleshooting](../troubleshooting.md), is quoted with its direct prefix.
A partial `restore` throws `restoreCollections:`'s messages under its own
prefix at once, so those have no `cause`. An error
from the driver or from `@nxgt/backup` is not renamed. `restoreCollections` called directly does the same for the `mongoTarget:`
refusals of the restore it runs into its scratch database: they read
`restoreCollections: …`, the original as `cause`.

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

`mongoBackups`' `restore` and `drill` found no backup to restore. The
message names the call and the backup — `name`, or the database's name;
`shop` here:

| Message | When |
| --- | --- |
| `restore on "shop": the repository holds no backup yet` | `restore` without `at`, before the first `run` |
| `drill on "shop": the repository holds no backup yet` | `drill`, before the first `run` |
| `restore on "shop": no backup was made at or before that time` | `restore` with an `at` date older than every backup the repository holds |

An `at` id the repository does not hold is `@nxgt/backup`'s `BackupError`
`NOT_FOUND`, not this one.

A name in the list `restoreCollections` was given as `collections` is not
in the backup — as its collections were named at the backup's time, after
every rename the chain replays. It comes after the backup was rebuilt, and
before anything reaches `db` —
[`collections`](restore.md#collections-names-at-the-backups-time).

```text
restoreCollections: a collection named in collections is not in the backup
```

`mongoBackups`' `restore` with `collections` goes through
`restoreCollections`, and throws the same, naming its own call:
`restore on "shop": a collection named in collections is not in the backup`.

`@nxgt/backup`'s `BackupError` has a `NOT_FOUND` too — a backup id that is
not there: check `instanceof` before `code`.

## The bare `TypeError`s

Wiring that could never work is a `TypeError`, not a `MongoBackupError`.
**Through `mongoBackups`, the messages name the call and the backup.**
A partial `restore` — `collections`, `as` or `documents` — refuses as
`restoreCollections` does, with `restore on "<name>":` where the table
says `restoreCollections:`: `restore on "shop": as names a collection not
restored`, `restore on "shop": a collection or view to restore is already
in the database; …`. Called directly, `restoreCollections` keeps its own
prefix. `shop` is the backup's name in the examples on this page.

`mongoBackups` throws its own at once, before it reads the key file or
touches the database; `run` rejects with its one, and `restore` with its
three, before reading anything, and the options it hands on are checked by `mongoTarget` and
`restoreCollections`, below.
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
| `mongoBackups: db must be a MongoDB Db` | `db` is missing, or is not a driver `Db` |
| `mongoBackups: keyFile must be an absolute path` | `keyFile` is missing, not a string, or relative |
| `mongoBackups: repository must be an absolute folder, or repositories` | `repository` is a relative path |
| `mongoBackups: keep must be false, or name rules each a whole number, 1 or more` | `keep` names no rule, or a rule that is not a whole number of 1 or more — checked by `mongoBackups(…)`, before any backup is stored |
| `mongoBackups: fullEvery must be a whole number of milliseconds, an hour or more` | `fullEvery` is under 3 600 000, or not a whole number |
| `mongoBackups: repository must list repositories, each under a name of its own` | `repository` is an empty list, or two repositories in it have the same name |
| `mongoBackups: tmpDir must be an absolute path` | a relative `tmpDir` |
| `mongoBackups: name must be 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"` | `name` is given, and is not a backup name; `defineBackup`'s `TypeError` is its `cause` |
| `mongoBackups: the database's name cannot name a backup; give name: 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"` | no `name`, and the database's name is not a backup name — `client.db('MyShop')`: pass `name: 'myshop'`. `defineBackup`'s `TypeError` is its `cause` |
| `restore on "shop": into must be a MongoDB Db` | `restore` with an `into` that is missing, or not a driver `Db`; it rejects before anything is read |
| `restore on "shop": at must be a backup's id or a valid Date` | `restore` with an `at` that is an invalid `Date` — `new Date('yesterday')`; it rejects before anything is read |
| `restore on "shop": replace is for whole collections; documents says what happens to those there` | `restore` with `documents` and `replace` both; the types refuse it too |
| `run on "shop": now must be a valid Date` | `run` with a `now` that is not a valid `Date`; it rejects before anything is read |
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

`mongoBackups` checks what `@nxgt/backup` would refuse — the name, the
repositories, `tmpDir` — when it is called, so none of `defineBackup`'s or
`bindBackup`'s `TypeError`s reaches you from a later call.

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

`run` already starts a new chain on `HISTORY_LOST`. What is left: skip a
run that met another on the repository's lock, make a full backup when the
chain cannot go on, and alert on everything else.

```ts
import { BackupError } from '@nxgt/backup';
import { MongoBackupError, mongoBackups, mongoSource } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const db = client.db('shop');
const backups = mongoBackups({ db, repository: '/mnt/backups', keyFile: '/etc/backup/shop.key' });

/** Whether `error` is another run holding the repository's lock. */
function locked(error: unknown): boolean {
	if (!(error instanceof BackupError)) return false;
	if (error.code === 'LOCKED') return true;
	// NOT_STORED: stored nowhere, each repository's error in `outcomes`.
	// PARTIAL is not skipped: a copy was stored, and the run stopped before verify.
	return (
		error.code === 'NOT_STORED' &&
		error.outcomes.some((o) => !o.stored && o.error instanceof BackupError && o.error.code === 'LOCKED')
	);
}

try {
	console.log(JSON.stringify(await backups.run()));
} catch (error) {
	if (locked(error)) {
		console.warn('another run holds the repository; skipped');
	} else if (error instanceof MongoBackupError && (error.code === 'UNSUPPORTED' || error.code === 'MALFORMED')) {
		// A full backup gets past a rename, a dotted update or a parent this version
		// cannot read. A time-series collection fails it too, and that error reaches you.
		const { backups: bound, keys } = await backups.binding();
		const full = await bound.create(mongoSource({ db }));
		await bound.verify(full.id, { identities: [keys.identity] });
	} else {
		throw error; // KEY_FILE, CHANGING, SNAPSHOT_TOO_OLD, the driver's: a person must look
	}
} finally {
	await client.close();
}
```

### By hand

The same for a job on the lower level — `bindBackup` and `mongoSource` —
that makes its own incrementals: start a new chain when the chain cannot go
on, and alert on everything else.

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
