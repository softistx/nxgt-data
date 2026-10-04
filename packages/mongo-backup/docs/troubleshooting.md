# Troubleshooting

This package throws one error of its own, `MongoBackupError`, told apart by
its `code`: `SNAPSHOT_TOO_OLD`, `CHANGING`, `HISTORY_LOST`, `UNSUPPORTED`,
`EXISTS`, `MALFORMED`, `NOT_FOUND` or `KEY_FILE`. A refusal of the way
`mongoBackups`, `mongoSource`, `mongoTarget` or `restoreCollections` was
called is a plain `TypeError`. Errors from the driver or the server come back as
they are; when one is the cause of a `MongoBackupError`, it is its `cause`.
A key file that is not there is a `KEY_FILE` too, the file system's
`ENOENT` as its `cause`.

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
  - [`mongoBackups: db must be a MongoDB Db`](#mongobackups-db-must-be-a-mongodb-db)
  - [`mongoBackups: keyFile must be an absolute path`](#mongobackups-keyfile-must-be-an-absolute-path)
  - [`mongoBackups: repository must be an absolute folder, or repositories`](#mongobackups-repository-must-be-an-absolute-folder-or-repositories)
  - [`mongoBackups: keep must be false, or name rules each a whole number, 1 or more`](#mongobackups-keep-must-be-false-or-name-rules-each-a-whole-number-1-or-more)
  - [`mongoBackups: fullEvery must be a whole number of milliseconds, an hour or more`](#mongobackups-fullevery-must-be-a-whole-number-of-milliseconds-an-hour-or-more)
  - [`mongoBackups: the database's name cannot name a backup; give name: 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"`](#mongobackups-the-databases-name-cannot-name-a-backup-give-name-1-to-100-characters-lowercase-letters-digits--_-and---starting-with-a-letter-or-a-digit-without-partial-)
  - [`mongoBackups: name must be 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"`](#mongobackups-name-must-be-1-to-100-characters-lowercase-letters-digits--_-and---starting-with-a-letter-or-a-digit-without-partial-)
  - [`mongoBackups: repository must list repositories, each under a name of its own`](#mongobackups-repository-must-list-repositories-each-under-a-name-of-its-own)
  - [`mongoBackups: tmpDir must be an absolute path`](#mongobackups-tmpdir-must-be-an-absolute-path)
  - [`run on "app": now must be a valid Date`](#run-on-app-now-must-be-a-valid-date)
  - [`mongoSource: db must be a MongoDB Db`](#mongosource-db-must-be-a-mongodb-db)
  - [`mongoSource: collections must be a list of names or a function`](#mongosource-collections-must-be-a-list-of-names-or-a-function)
  - [`mongoTarget: db must be a MongoDB Db`](#mongotarget-db-must-be-a-mongodb-db)
  - [`mongoTarget: tmpDir must be an absolute path`](#mongotarget-tmpdir-must-be-an-absolute-path)
- **The key file**
  - [`usage: nxgt-mongo-backup keygen <path>`](#usage-nxgt-mongo-backup-keygen-path)
  - [`<path> is already there: it is never overwritten`](#path-is-already-there-it-is-never-overwritten)
  - [`keygen failed: <message>`](#keygen-failed-message)
  - [`mongoBackups on "app": there is no key file there; write one with nxgt-mongo-backup keygen`](#mongobackups-on-app-there-is-no-key-file-there-write-one-with-nxgt-mongo-backup-keygen)
  - [`mongoBackups on "app": others than its owner can read or write the key file; chmod 600 it`](#mongobackups-on-app-others-than-its-owner-can-read-or-write-the-key-file-chmod-600-it)
  - [`mongoBackups on "app": the key file is not one keygen wrote`](#mongobackups-on-app-the-key-file-is-not-one-keygen-wrote)
- **Choosing the backup to restore**
  - [`restore on "app": the repository holds no backup yet`](#restore-on-app-the-repository-holds-no-backup-yet)
  - [`drill on "app": the repository holds no backup yet`](#drill-on-app-the-repository-holds-no-backup-yet)
  - [`restore on "app": no backup was made at or before that time`](#restore-on-app-no-backup-was-made-at-or-before-that-time)
  - [`restore on "app": into must be a MongoDB Db`](#restore-on-app-into-must-be-a-mongodb-db)
  - [`restore on "app": at must be a backup's id or a valid Date`](#restore-on-app-at-must-be-a-backups-id-or-a-valid-date)
  - [`restore on "app": replace is for whole collections; documents says what happens to those there`](#restore-on-app-replace-is-for-whole-collections-documents-says-what-happens-to-those-there)
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
- **Restoring some collections**
  - [`restoreCollections: db must be a MongoDB Db`](#restorecollections-db-must-be-a-mongodb-db)
  - [`restoreCollections: scratch must be a MongoDB Db`](#restorecollections-scratch-must-be-a-mongodb-db)
  - [`restoreCollections: scratch must be on db's client`](#restorecollections-scratch-must-be-on-dbs-client)
  - [`restoreCollections: scratch must be another database`](#restorecollections-scratch-must-be-another-database)
  - [`restoreCollections: documents must be { filter, existing: 'replace' | 'keep' }`](#restorecollections-documents-must-be--filter-existing-replace--keep-)
  - [`restoreCollections: replace is for whole collections; documents says what happens to those there`](#restorecollections-replace-is-for-whole-collections-documents-says-what-happens-to-those-there)
  - [`restoreCollections: the scratch database holds collections; give an empty one`](#restorecollections-the-scratch-database-holds-collections-give-an-empty-one)
  - [`restoreCollections: a collection named in collections is not in the backup`](#restorecollections-a-collection-named-in-collections-is-not-in-the-backup)
  - [`restoreCollections: as must give a collection name`](#restorecollections-as-must-give-a-collection-name)
  - [`restoreCollections: as gives two collections one name`](#restorecollections-as-gives-two-collections-one-name)
  - [`restoreCollections: as names a collection not restored`](#restorecollections-as-names-a-collection-not-restored)
  - [`restoreCollections: a collection or view to restore is already in the database; restore it under another name, or pass replace: true`](#restorecollections-a-collection-or-view-to-restore-is-already-in-the-database-restore-it-under-another-name-or-pass-replace-true)

**Through `mongoBackups`, the prefix names the call.** Every
`mongoSource:`, `mongoTarget:` and `restoreCollections:` message below is
quoted as the function throws it when you call it directly. `run`,
`restore` and `drill` replace that prefix with `run on "<name>":`,
`restore on "<name>":` or `drill on "<name>":`, `<name>` being the
backup's name — `restore on "shop": a collection or view the backup holds
is already in the database; …` for the `mongoTarget:` one. The class and
the `code` are the same; a `mongoSource:` or `mongoTarget:` one keeps the
original as its `cause`; `restoreCollections`'s own refusals are thrown
under the call's prefix directly and have none. Search for the part after the colon.
`restoreCollections` called directly does the same for the `mongoTarget:`
refusals of the restore it runs into its scratch database: they read
`restoreCollections: …`, the original as `cause`.

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

These are thrown by `mongoBackups(…)`, `mongoSource(…)` or `mongoTarget(…)`
themselves, where the backup is wired — or, for `now`, by `run` before it
starts: nothing was read or written, and `mongoBackups` has not read the
key file yet.

### `mongoBackups: db must be a MongoDB Db`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself.
**When:** `mongoBackups({ db, … })` with something that is not a driver
`Db` — a `MongoClient`, a database name, or a Mongoose connection's `db`
read before it connected.
**Why:** the backups are of one database: its name is the backup's name by
default, and `drill` restores into a database on its client.
**Fix:** give the database, not the client.

```ts
import { MongoClient } from 'mongodb';
import { mongoBackups } from '@nxgt/mongo-backup';

const client = await MongoClient.connect(process.env.MONGO_URL!);
const backups = mongoBackups({
	db: client.db('shop'),
	repository: '/var/backups/shop',
	keyFile: '/etc/backup/shop.key',
});
```

### `mongoBackups: keyFile must be an absolute path`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself.
**When:** `mongoBackups({ keyFile })` with a relative path, or with
something that is not a string — most often an environment variable that is
not set, read as `undefined`.
**Why:** a relative path would depend on the folder the job was started
from, and a backup job is started from wherever its scheduler likes.
**Fix:** an absolute path; check the variable before the call.

```ts
const keyFile = process.env.BACKUP_KEY_FILE;
if (!keyFile) throw new Error('BACKUP_KEY_FILE is not set');
const backups = mongoBackups({ db, repository: '/var/backups/shop', keyFile });
```

### `mongoBackups: repository must be an absolute folder, or repositories`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself.
**When:** `mongoBackups({ repository })` with a relative folder, such as
`'backups'` or `'./backups'`.
**Why:** a string is a local folder, and as for `keyFile`, a relative one
would move with the folder the job was started from.
**Fix:** an absolute folder — or one or more repositories of
`@nxgt/backup`, such as `localRepository` or `s3Repository`.

```ts
import { join } from 'node:path';
import { localRepository } from '@nxgt/backup';

mongoBackups({ db, keyFile, repository: join(import.meta.dir, 'backups') });
mongoBackups({ db, keyFile, repository: [localRepository({ path: '/var/backups/shop' })] });
```

### `mongoBackups: keep must be false, or name rules each a whole number, 1 or more`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself, before
any backup is stored.
**When:** `mongoBackups({ keep })` with an empty policy (`{}`), a rule with
`0`, a fraction or a string, or something that is not a policy at all.
**Why:** `keep` is what `run` keeps after each backup: `@nxgt/backup`'s
`KeepPolicy` — `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`,
`within`, `maxTotalSize` — each a whole number of 1 or more. A policy that
names no rule would keep nothing, so it is refused here rather than by
`prune` after every backup.
**Fix:** name at least one rule, leave `keep` out for `DEFAULT_KEEP`, or
pass `false` to keep everything.

```ts
mongoBackups({ db, repository, keyFile, keep: { daily: 14, weekly: 8 } });
mongoBackups({ db, repository, keyFile, keep: false });
```

### `mongoBackups: fullEvery must be a whole number of milliseconds, an hour or more`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself.
**When:** `mongoBackups({ fullEvery })` with a number of days or hours
rather than milliseconds, a fraction, or less than an hour.
**Why:** `fullEvery` is how old the newest full backup may grow before
`run` makes another, in milliseconds — a week by default,
`DEFAULT_FULL_EVERY`. Under an hour, every run would be a full backup.
**Fix:**

```ts
const DAY = 24 * 60 * 60 * 1000;
mongoBackups({ db, repository, keyFile, fullEvery: 3 * DAY });
```

### `mongoBackups: the database's name cannot name a backup; give name: 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself; its
`cause` is `@nxgt/backup`'s `defineBackup` `TypeError`.
**When:** `mongoBackups({ db })` without `name`, on a database whose name is
not a backup name: `client.db('MyShop')`, `client.db('shop_EU')`, a name
over 100 characters.
**Why:** the backup is named after the database by default, and a backup
name becomes a folder and a key prefix in every repository: lowercase
letters, digits, `.`, `_` and `-` only.
**Fix:** give the backup a name of its own — and keep it: a new name starts
a new chain, and the old backups stay under the old one.

```ts
mongoBackups({ db: client.db('MyShop'), name: 'myshop', repository, keyFile });
```

### `mongoBackups: name must be 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself; its
`cause` is `@nxgt/backup`'s `defineBackup` `TypeError`.
**When:** `mongoBackups({ name })` with capitals, spaces, `/`, an empty
string, or more than 100 characters.
**Why:** as for [the database's name](#mongobackups-the-databases-name-cannot-name-a-backup-give-name-1-to-100-characters-lowercase-letters-digits--_-and---starting-with-a-letter-or-a-digit-without-partial-):
the name becomes a folder and a key prefix.
**Fix:**

```ts
mongoBackups({ db, name: 'shop-eu', repository, keyFile });
```

### `mongoBackups: repository must list repositories, each under a name of its own`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself.
**When:** `mongoBackups({ repository: [] })`, or a list holding two
repositories with the same `name` — two `s3Repository`s left at their
default name `s3`, say.
**Why:** every backup is written to each repository, and each one's outcome
is reported under its name; two under one name could not be told apart.
**Fix:** name each one.

```ts
import { s3Repository } from '@nxgt/backup';
import { S3Client } from 'bun';

mongoBackups({
	db,
	keyFile,
	repository: [
		s3Repository({ client: new S3Client({ bucket: 'backups-eu' }), name: 's3-eu' }),
		s3Repository({ client: new S3Client({ bucket: 'backups-us' }), name: 's3-us' }),
	],
});
```

### `mongoBackups: tmpDir must be an absolute path`

**Code:** none — a `TypeError`, thrown by `mongoBackups(…)` itself.
**When:** `mongoBackups({ tmpDir })` with a relative path.
**Why:** objects and changes are staged there; a relative path would
depend on the folder the job was started from.
**Fix:** an absolute path, or leave it out for the system's temporary
folder.

```ts
mongoBackups({ db, repository, keyFile, tmpDir: '/var/tmp' });
```

### `run on "app": now must be a valid Date`

**Code:** none — a `TypeError`; `run` rejects with it before reading
anything, the key file included. `app` is the backup's name.
**When:** `run(now)` with something that is not a `Date`, or an invalid
one — `new Date('tomorrow')`, a date parsed from an empty variable.
**Why:** `now` decides whether a full or an incremental backup is due;
with no time, it could decide neither. It decides nothing else: the
backup and the rotation go by the machine's clock, since a later `now`
given to the rotation would remove the backup just made.
**Fix:** leave it out on a schedule; pass a valid `Date` in a spec, or to
force a full backup.

```ts
import { DEFAULT_FULL_EVERY } from '@nxgt/mongo-backup';

await backups.run(); // the machine's time
await backups.run(new Date(Date.now() + DEFAULT_FULL_EVERY)); // a full backup now
```

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

## The key file

`mongoBackups` reads every key it needs from one file, written by
`nxgt-mongo-backup keygen`. It reads it at the first call that needs it —
`run`, `restore`, `drill`, `list` or `binding` — and not in
`mongoBackups(…)` itself. A read that failed is tried again at the next
call, so a file put right needs no restart.

### `usage: nxgt-mongo-backup keygen <path>`

**Exit code:** 2; nothing was written.
**When:** `nxgt-mongo-backup` run without a command, with a command other
than `keygen`, or with `keygen` and no path.
**Why:** the bin has one command, and it takes the path of the file to
write.
**Fix:**

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key
```

A relative path is taken from the current folder. The command prints the
path, and the recipient — the public half; never a secret.

### `<path> is already there: it is never overwritten`

**Exit code:** 1; the file there is untouched.
**When:** `nxgt-mongo-backup keygen <path>` on a path that already holds a
file — a second run of a setup script, say.
**Why:** every backup is encrypted to the key in that file and signed with
it; writing a new one over it would make every backup made with it
unreadable.
**Fix:** keep the file there — it is the one the job reads — or write the
new one to another path.

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop-2.key
```

Retire an old key file only once no backup made with it is kept, and keep
its copy away from the backups until then.

### `keygen failed: <message>`

**Exit code:** 1.
**When:** `nxgt-mongo-backup keygen <path>` could not write the file for
any reason other than one already there: a folder that does not exist, one
you cannot write to, a full disk. `<message>` is the system's, such as
`ENOENT: no such file or directory, open '/etc/backup/shop.key'`.
**Why:** the file and its folder are written and synced before the command
says it is done; a write that fails halfway removes the file it created,
so nothing half-written is left at the path.
**Fix:** make the folder, or run as a user who can write to it, and run the
same command again — it is not refused as already there.

```sh
mkdir -p /etc/backup && bunx nxgt-mongo-backup keygen /etc/backup/shop.key
```

### `mongoBackups on "app": there is no key file there; write one with nxgt-mongo-backup keygen`

**Code:** `KEY_FILE`; the file system's `ENOENT` is its `cause`, and it
names the path, never a key. Called directly, `readKeyFile` says
`readKeyFile: there is no key file there; …`. Any other failure to open
the file — `EACCES`, `ENOTDIR` — is the system's error, as it is.
**When:** the first `run`, `restore`, `drill`, `list` or `binding` of a
`mongoBackups` whose `keyFile` is not there: a typo, a secret not mounted
yet, a file written on another machine.
**Why:** `mongoBackups(…)` only checks that the path is absolute; the file
is read when a key is first needed. The failed read is not kept: the next
call reads the file again.
**Fix:** write it there once, or point `keyFile` at the one you have.

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key
```

If backups were already made, do not write a new file in place of a lost
one — it cannot read them. Put back the copy kept away from the backups.

### `mongoBackups on "app": others than its owner can read or write the key file; chmod 600 it`

**Code:** `KEY_FILE`. Called directly, `readKeyFile` says
`readKeyFile: others than its owner can read or write the key file; …`.
**When:** the first call that reads the key file, when its mode gives
anything to its group or to others — reading, or writing: a copy made under a loose `umask`, a
file put there by a deployment tool, a mounted secret with its default
mode.
**Why:** the file holds the key that decrypts every backup and the one that
signs them, so — as `ssh` does with a private key — it is refused rather
than used while others can read it, or write a key of their own into
it. `keygen` writes it with mode `600`.
**Fix:**

```sh
chmod 600 /etc/backup/shop.key
```

For a mounted secret, give it mode `0400` or `0600` where it is mounted.

### `mongoBackups on "app": the key file is not one keygen wrote`

**Code:** `KEY_FILE`, without a `cause`: the parsers' own errors quote the
key. Called directly, `readKeyFile` says
`readKeyFile: the key file is not one keygen wrote`.
**When:** the first call that reads the key file, when it holds no age
identity (`AGE-SECRET-KEY-1…`) or no Ed25519 private key in PEM
(`-----BEGIN PRIVATE KEY-----`), or one that does not parse: the wrong
file, an `age-keygen` identity alone, a public key, a file cut short, an
identity with a character changed (its checksum fails), an RSA or other
private key where the Ed25519 one should be — or one whose line
endings became `\r\n` on its way through an editor or a secret store.
**Why:** one file gives both keys: the identity backups are encrypted to and
read with, and the key their manifests are signed with.
**Fix:** use the file `keygen` wrote, as it wrote it — or, before any backup
was made, write a new one.

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key
```

## Choosing the backup to restore

`mongoBackups`' `restore` takes the backup `at` names — an id as it is, a
time as the newest backup made at or before it, nothing as the newest of
all — and `drill` takes the newest.

### `restore on "app": the repository holds no backup yet`

**Code:** `NOT_FOUND`; nothing was read from the repository but its list.
`app` is the backup's name: `name`, or the database's name by default.
**When:** `restore` without `at` before the first `run` — or
on a repository other than the one the job writes to, or under another
`name`: the backup's name is the database's by default.
**Why:** with no `at`, the newest backup is restored, and there is none.
**Fix:** make one first — or check that `repository` and `name` are the
job's.

```ts
await backups.run();
await backups.restore({ into: client.db('shop-restored') });
```

### `drill on "app": the repository holds no backup yet`

**Code:** `NOT_FOUND`; nothing was restored, and no drill database made.
**When:** `drill` before the first `run`, or on another repository or
`name` than the job's.
**Why:** a drill restores the newest backup, and there is none.
**Fix:** as for
[`restore`](#restore-on-app-the-repository-holds-no-backup-yet): run the
job first, or check `repository` and `name`. A scheduled drill that starts
before the first backup fails this way once.

```ts
await backups.run();
await backups.drill();
```

### `restore on "app": no backup was made at or before that time`

**Code:** `NOT_FOUND`; nothing was read from the repository but its list.
**When:** `restore({ into, at })` with a `Date` older than every backup the
repository still holds: one from before the first backup, one the rotation
of `keep` has pruned since, or a `Date` parsed from a string in another
time zone than meant.
**Why:** a time picks the newest backup made at or before it, and none
was. A later one is never taken in its place: it would hold changes made
after the time asked for.
**Fix:** list what is kept, and restore by id — the oldest, if it will do.

```ts
const [oldest] = await backups.list(); // oldest first
if (oldest) await backups.restore({ into: client.db('shop-restored'), at: oldest.id });
```

### `restore on "app": into must be a MongoDB Db`

**Code:** none — a `TypeError`; `restore` rejects with it before reading
anything, the key file included.
**When:** `restore({ into })` with a database name, a `MongoClient`, or
nothing.
**Why:** `into` is the database the backup lands in, and must be the
driver's `Db`.
**Fix:**

```ts
await backups.restore({ into: client.db('shop-restored') });
```

### `restore on "app": at must be a backup's id or a valid Date`

**Code:** none — a `TypeError`; `restore` rejects with it before reading
anything, the key file included.
**When:** `restore({ into, at })` with a `Date` that is not a time —
`new Date('yesterday')`, say — usually parsed from user input or an
environment variable.
**Why:** an invalid `Date` is no time at all; taken as one, it would pick
a backup nobody asked for.
**Fix:** check the date before the restore, or pass the id `list` gives.

```ts
const at = new Date(Bun.env['RESTORE_AT'] ?? '');
if (Number.isNaN(at.getTime())) throw new Error('RESTORE_AT is not a date');
await backups.restore({ into: client.db('shop-restored'), at });
```

### `restore on "app": replace is for whole collections; documents says what happens to those there`

**Code:** none — a `TypeError`; `restore` rejects with it before reading
anything. The types refuse it first: with `documents`, `replace` is
`never`.
**When:** `restore({ into, documents, replace })` — both at once.
**Why:** `replace` swaps whole collections already there; `documents`
merges some documents into them, and its `existing` already says what
happens to a document there.
**Fix:** keep one of the two.

```ts
await backups.restore({
	into: client.db('shop'),
	collections: ['orders'],
	documents: { filter: { _id: 'o-1001' }, existing: 'replace' }, // the documents, not the collection
});
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

With `mongoBackups`, `run()` does this by itself: when an incremental was
due and fails with `HISTORY_LOST`, it makes a full backup instead and
reports `fellBack: true`. Watch for it — it means the oplog is shorter than
the time between runs.

```ts
const report = await backups.run();
if (report.fellBack) console.warn('backup: the oplog no longer reached the last backup; made a full one');
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
full backup, the `nxgt-restore-<uuid>` collections of a restore into the
database backed up, or the `tmpXXXXX.renameCollection` collection through
which the server moves one a whole `restoreCollections` lands there, when
the chain's filter does not take that name — a list never does.
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

## Restoring some collections

`restoreCollections(backups, id, options)` rebuilds the backup, chain
included, in a scratch database, takes from it what `collections` names,
moves it into `db` — whole, or only the documents `documents` selects —
then drops the scratch database, failed or not — save one you passed that
was not empty, which is refused and left as it was. Of the errors below,
only the last one may leave something in `db`.

`mongoBackups`' `restore` goes through it for a partial restore —
`collections`, `as` or `documents` — and its messages then name that call
and the backup instead: `restore on "app": as names a collection not
restored` where the heading says `restoreCollections: as names a
collection not restored`. Search for the part after the colon.

### `restoreCollections: db must be a MongoDB Db`

**Code:** none — a `TypeError`; nothing was read.
**When:** `restoreCollections` with a `db` that is not a driver `Db` — a
`MongoClient`, a database name, or `undefined`.
**Why:** the collections are moved into one database, and the scratch one
is made on its client.
**Fix:** give the database, not the client.

```ts
import { restoreCollections } from '@nxgt/mongo-backup';

await restoreCollections(backups, id, { identities, db: client.db('shop') });
```

### `restoreCollections: scratch must be a MongoDB Db`

**Code:** none — a `TypeError`; nothing was read.
**When:** `restoreCollections` with a `scratch` that is not a driver `Db`,
such as a database name.
**Why:** `scratch` is where the backup is rebuilt, and it is dropped
afterwards; it must be a database on `db`'s client.
**Fix:** pass a `Db` — or leave `scratch` out for a fresh
`nxgt-restore-<uuid>` on `db`'s client.

```ts
await restoreCollections(backups, id, { identities, db, scratch: client.db('restore-scratch') });
```

### `restoreCollections: scratch must be on db's client`

**Code:** none — a `TypeError`; nothing was read.
**When:** `restoreCollections` with a `scratch` from another `MongoClient`
than `db`'s — even one connected to the same deployment.
**Why:** collections move out of the scratch database with a rename across
databases, and documents with a `$merge`; both run on the scratch's client
and name `db` there. From another server, documents would land in a
database of that name on the wrong cluster, and the restore would look
like it worked.
**Fix:** take both from one client — or leave `scratch` out.

```ts
await restoreCollections(backups, id, { identities, db: client.db('shop'), scratch: client.db('shop-scratch') });
```

### `restoreCollections: scratch must be another database`

**Code:** none — a `TypeError`; nothing was read.
**When:** `restoreCollections` with a `scratch` whose name is `db`'s.
**Why:** the scratch database is dropped when the restore ends, so it can
never be the database restored into.
**Fix:** a database of its own, or none.

```ts
await restoreCollections(backups, id, { identities, db: client.db('shop'), scratch: client.db('shop-scratch') });
```

### `restoreCollections: documents must be { filter, existing: 'replace' | 'keep' }`

**Code:** none — a `TypeError`; nothing was read.
**When:** `restoreCollections` with a `documents` whose `filter` is not a
query object — an array, a string — or whose `existing` is neither
`'replace'` nor `'keep'`, or is left out.
**Why:** a document of the backup whose `_id` is already in the collection
either replaces it or is dropped, and the restore does not pick for you.
**Fix:**

```ts
await restoreCollections(backups, id, {
	identities,
	db,
	collections: ['orders'],
	documents: { filter: { customer: customerId }, existing: 'keep' },
});
```

### `restoreCollections: replace is for whole collections; documents says what happens to those there`

**Code:** none — a `TypeError`; nothing was read.
**When:** `restoreCollections` with both `documents` and `replace`.
**Why:** with `documents`, the selected documents are merged into the
collection there, and `documents.existing` already says what happens to
one with the same `_id`; `replace` drops and moves whole collections.
**Fix:** one or the other.

```ts
await restoreCollections(backups, id, { identities, db, documents: { filter: {}, existing: 'replace' } });
await restoreCollections(backups, id, { identities, db, replace: true });
```

### `restoreCollections: the scratch database holds collections; give an empty one`

**Code:** `EXISTS`; nothing was read, and the scratch database was left as
it was.
**When:** `restoreCollections` with a `scratch` that holds a collection or
view — a database in use, or the scratch of an earlier run that was killed
before it could drop it.
**Why:** the scratch database is dropped when the restore ends; a database
holding something might be one that should not be.
**Fix:** check what it holds, drop it if it is only a leftover, or give
another — or leave `scratch` out.

```ts
const scratch = client.db('restore-scratch');
await scratch.dropDatabase(); // only once you know nothing in it is needed
await restoreCollections(backups, id, { identities, db, scratch });
```

### `restoreCollections: a collection named in collections is not in the backup`

**Code:** `NOT_FOUND`; nothing landed in `db`.
**When:** `restoreCollections` with `collections: [...]` listing a name the
backup does not hold, once the backup has been rebuilt in the scratch
database: a typo, a collection created after the backup, or one left out
of it by `mongoSource`'s `collections`.
**Why:** names are the backup's, as they were at the time of the backup
`id` — after every rename the chain's incremental backups recorded. A
collection renamed since the full backup is named by its new name; one
renamed after the backup `id`, by its old one. Restoring nothing for a
name, without saying so, would look like success.
**Fix:** name collections as they were at the backup's time — or pass a
function, which takes what it matches and refuses nothing.

```ts
await restoreCollections(backups, id, {
	identities,
	db,
	collections: (name) => ['orders', 'customers'].includes(name),
});
```

### `restoreCollections: as must give a collection name`

**Code:** none — a `TypeError`; nothing landed in `db`.
**When:** `restoreCollections` with an `as` that gives, for one of the
collections restored, something other than a string, an empty string, a
name holding `$` or a NUL character, or a name starting with `system.`.
An `as` map is checked before the backup is read; a function, once the
backup has been rebuilt in the scratch database and the names are known.
**Why:** MongoDB refuses those names, or keeps them for itself.
**Fix:** a map keyed by names restored — one it does not list keeps its
own — or a function that returns a name for every one.

```ts
await restoreCollections(backups, id, { identities, db, as: { orders: 'orders-restored' } });
await restoreCollections(backups, id, { identities, db, as: (name) => `${name}-restored` });
```

### `restoreCollections: as gives two collections one name`

**Code:** none — a `TypeError`; nothing landed in `db`.
**When:** `restoreCollections` with an `as` that sends two of the
collections or views restored to the same name — a function returning a
constant, or a map naming one collection after another that keeps its own.
Two keys of an `as` map given one name are refused before the backup is
read; a clash with a collection that keeps its own name, and anything a
function gives, once the backup has been rebuilt in the scratch database.
**Why:** one would land over the other.
**Fix:** a name per collection; a suffix or a prefix keeps them apart.

```ts
await restoreCollections(backups, id, { identities, db, as: (name) => `${name}-restored` });
```

### `restoreCollections: as names a collection not restored`

**Code:** none — a `TypeError`; nothing landed in `db`.
**When:** `restoreCollections` with an `as` map whose key names no
collection or view restored — a typo, a name `collections` leaves out, a
name the backup does not hold at its time, or a view when `documents` is
given (views hold no documents, so none is restored). It is checked once
the backup has been rebuilt in the scratch database.
**Why:** a key that names nothing would leave the collection meant under
its own name — so with `documents` and `existing: 'replace'`, or with
`replace: true`, over the live one.
**Fix:** key the map by the names the backup holds at its time, after
any rename its chain recorded.

```ts
await restoreCollections(backups, id, { identities, db, collections: ['orders'], as: { orders: 'orders-restored' } });
```

### `restoreCollections: a collection or view to restore is already in the database; restore it under another name, or pass replace: true`

**Code:** `EXISTS`.
**When:** a whole restore — without `documents` — when a collection or
view restored lands on a name `db` already holds: its own name, or the one
`as` gives it.
**Why:** a restore never writes over data without being asked to. Every
name is checked before anything moves, so in the common case nothing
landed. A collection created under one of those names between the check
and the move is refused as well, and left untouched; the collections moved
before it stay restored.
**Fix:** restore under another name, replace what is there — each
collection or view restored is dropped and moved anew, the others are left
as they are — or merge documents into it instead.

```ts
await restoreCollections(backups, id, { identities, db, collections: ['orders'], as: { orders: 'orders-then' } });
await restoreCollections(backups, id, { identities, db, collections: ['orders'], replace: true });
await restoreCollections(backups, id, {
	identities,
	db,
	collections: ['orders'],
	documents: { filter: {}, existing: 'keep' },
});
```
