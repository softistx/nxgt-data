# Restore

This page covers bringing a database back from a backup with `mongoTarget`:
its options, the order things land in, what `replace` does, how changes
are applied, and what a failure leaves.

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
if (!latest) throw new Error('no backup to restore');

const restored = await backups.restore(latest.id, mongoTarget({ db: client.db('shop-restored') }), {
	identities: [process.env.BACKUP_IDENTITY as string],
});
// { id, repository: 'local', entries: ['metadata/customers', 'documents/customers', …], size }
```

`restore` itself — `identities`, `from`, `only`, and the checks it makes on
every object before a byte is decrypted — is `@nxgt/backup`'s.

## `mongoTarget`

```ts
interface MongoTargetOptions {
	db: Db;
	replace?: boolean | undefined;
	tmpDir?: string | undefined;
}

function mongoTarget(options: MongoTargetOptions): RestoreTarget;
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `db` | `Db` | required | the database to restore into: the one backed up, or another |
| `replace` | `boolean` | `false` | replace a collection or view that is already there. By default one there is refused with `EXISTS`, and nothing of it is touched |
| `tmpDir` | `string` | the system's temporary folder | where a `changes/<n>` entry is staged before it is applied. An absolute path |

`mongoTarget` checks its options at once, and touches nothing:

```ts
mongoTarget({ db: client.db('shop'), tmpDir: 'tmp' });
// TypeError: mongoTarget: tmpDir must be an absolute path

mongoTarget({ db: 'shop' as never });
// TypeError: mongoTarget: db must be a MongoDB Db
```

**A target serves one restore.** It remembers the metadata entries it has
read, so that each collection's documents land with their options and
indexes; a second `restore` through the same object would find the first
one's. Make a new `mongoTarget` for each `restore`:

```ts
for (const id of ids) {
	const db = client.db(`drill-${id}`);
	await backups.restore(id, mongoTarget({ db }), { identities }); // a new target each time
}
```

## The order

`restore` gives the target the backup's entries in the backup's order,
one after the other:

1. for each collection, by name, `metadata/<name>` — a **view** is created
   from it there and then — then `documents/<name>`, which lands the
   collection;
2. then, for an incremental or a differential, each `changes/<n>` in turn.

A collection's documents need its metadata first: an entry that comes
without it is refused with
`MongoBackupError (MALFORMED): mongoTarget: a collection’s documents came before its metadata`.
That only happens when `only` picks one without the other —
[one collection](#one-collection-with-only).

## Each collection, whole or not at all

A collection is never written in place:

1. its name is checked: **one already there is refused with `EXISTS`**
   before a document is read, unless `replace`;
2. a staging collection, `nxgt-restore-<uuid>`, is created with the
   collection's options — validator, collation, capped size, … ;
3. the documents are inserted into it, in ordered batches of up to 1000
   documents or 8 MiB, with **`bypassDocumentValidation`**;
4. its indexes are built;
5. only once the entry's stream has ended cleanly — `@nxgt/backup` checks
   every byte against what it recorded, and can only say so at the end — it
   is **renamed into place**.

Anything that fails on the way — a damaged entry, a write the server
refuses, an index that cannot be built — drops the staging collection and
lands nothing of that collection.

- **Indexes are built after the documents**, on the staging collection: on
  a large collection that takes a while, and the collection appears only
  once they are done.
- **A document the validator would refuse comes back as it was.** That is
  a backup's job, but it needs the privilege: the restoring user needs the
  `bypassDocumentValidation` action, which the built-in `restore` and
  `dbAdmin` roles have.
- **A view** is created from its metadata — `viewOn` and `pipeline` — at
  once; it holds no documents.

## `EXISTS` and `replace`

```ts
import { MongoBackupError, mongoTarget } from '@nxgt/mongo-backup';

try {
	await backups.restore(id, mongoTarget({ db: client.db('shop') }), { identities });
} catch (error) {
	if (!(error instanceof MongoBackupError && error.code === 'EXISTS')) throw error;
	// MongoBackupError (EXISTS): mongoTarget: a collection or view the backup holds is
	// already in the database; restore into another one, or pass replace: true
}
```

Without `replace`, a collection or view already in the database is refused,
and nothing of it is touched. The check runs before the documents are read,
and again at the rename: a collection created meanwhile is refused there
too. A collection a `create` change would make is refused the same way, and
so is the new name of a recorded rename that **replaced nothing at the
source** — [changes](#changes).

With `replace: true`:

| What is there | What happens |
| --- | --- |
| a collection the backup holds | the restored one is built apart and **replaces it at the rename**: until then the old one is untouched |
| a view the backup holds | it is dropped, then created again from its metadata |
| a collection a `create` change makes | it is dropped, then created with the recorded options |
| a collection a recorded rename lands on | it is replaced by the renamed one |
| a collection the backup does not hold | it is left alone — unless a change drops it, or renames over it |

```ts
await backups.restore(id, mongoTarget({ db: client.db('shop'), replace: true }), { identities });
```

## Changes

A `changes/<n>` entry is not applied as it streams in. It is written to
`<tmpDir>/nxgt-mongo-changes-XXXXXX/changes.bson` — a folder of its own,
made with `mkdtemp` and readable only by the user that runs the restore,
since the changes hold whole documents in the clear — until its stream has
ended cleanly; then it is applied, in order, and the folder removed. A
change applied cannot be taken back, so none is applied before
`@nxgt/backup` has checked the whole entry.

- **Document changes** to one collection go as ordered bulk writes of up
  to 1000, with `bypassDocumentValidation`. An insert or a replace is a
  `replaceOne` with `upsert`; an update cuts arrays first, then sets and
  unsets fields; a delete is a `deleteOne`.
- **Collection changes** apply between them, in their place:
  `createCollection`, `createIndexes`, `dropIndex`, `collMod`,
  `renameCollection`, `dropCollection`, `dropDatabase`. A drop, an index
  drop, a `collMod` or a rename of something already gone is not an error.
- **A rename records whether it replaced a collection at the source**
  (`dropTarget`). One that did replaces the collection of the new name
  here too. One that did not refuses a collection already there under the
  new name with `EXISTS`, and touches nothing of it — unless `replace: true`,
  which replaces it:

```ts
// at the source: orders renamed to orders-2026, where no orders-2026 was
await backups.restore(next.id, mongoTarget({ db: client.db('shop-restored') }), { identities });
// MongoBackupError (EXISTS) if shop-restored already holds an orders-2026
```

- **`dropDatabase` drops the database restored into**, whatever else it
  holds — [incremental](incremental.md#a-dropped-database).
- **`tmpDir` needs room for the largest changes entry**, decrypted and
  decompressed — on top of the room `@nxgt/backup`'s own `tmpDir` needs for
  each object. `tmpDir: '/var/tmp'` when `/tmp` is a small tmpfs.

What each recorded change is is on the
[incremental](incremental.md#what-the-change-stream-records) page.

## One collection with `only`

From a **full** backup, a collection's two entries restore it alone, as the
backup read it:

```ts
await backups.restore(
	full.id,
	mongoTarget({ db: client.db('shop-restored') }),
	{ identities, only: ['metadata/orders', 'documents/orders'] },
);
```

From an incremental, the same two entries give the collection as the
**full** backup read it, without the changes since. A `changes/<n>` entry
holds the changes to every collection the chain follows, so picking one
applies them all — to collections that are not there, too, which an insert
then creates without their options. Restore an incremental whole, into a
database of its own, and copy the collection from there.

## Into another database

The backup does not record the database's name: the same backup restores
into the database it came from, or any other, on the same server or
another one. Restoring into a fresh database, then pointing the
application at it, is the safest way back:

```ts
// restore.ts — `bun run restore.ts <backup id> <database>`
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoTarget } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const [id, database] = Bun.argv.slice(2);
if (!id || !database) throw new TypeError('usage: bun run restore.ts <backup id> <database>');

const client = await MongoClient.connect(process.env.MONGO_URL as string);
try {
	const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
		repositories: [localRepository({ path: '/mnt/backups' })],
		recipients: [process.env.BACKUP_RECIPIENT as string],
		tmpDir: '/var/tmp',
	});
	const db = client.db(database);
	const there = await db.listCollections({}, { nameOnly: true }).toArray();
	if (there.length > 0) throw new Error('restore into an empty database');

	const restored = await backups.restore(id, mongoTarget({ db, tmpDir: '/var/tmp' }), {
		identities: [(await Bun.file('/etc/backup/identity.txt').text()).trim()],
	});
	console.log(`restored ${restored.entries.length} entries into ${database}`);
} finally {
	await client.close();
}
```

## What a failure leaves

A restore stops at its first error, and is whole **per collection**, not
per backup:

- **the collections already restored stay**, and so do the views already
  created;
- **the collection being restored lands nothing**: its staging collection
  is dropped;
- **changes already applied stay applied**: a change entry that fails
  halfway — a write the server refuses — leaves the ones before it.

A process killed mid-restore cannot clean up: it can leave a staging
collection behind, and a staged changes folder in `tmpDir`. Drop them by
name once nothing runs:

```ts
const db = client.db('shop-restored');
for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
	if (name.startsWith('nxgt-restore-')) await db.dropCollection(name);
}
```

```sh
rm -rf /var/tmp/nxgt-mongo-changes-*
```

Then drop the database and restore again — or restore into another one.

## Restoring into the database you back up

A restore lands each collection under `nxgt-restore-<uuid>` and renames it
into place. Into the database a `mongoSource` backs up — with
`replace: true`, say — those renames reach its change stream as renames
into the collections the chain follows, and the next incremental fails
`UNSUPPORTED` ([renames](incremental.md#renames)). Make a full backup right
after such a restore:

```ts
await backups.restore(id, mongoTarget({ db: client.db('shop'), replace: true }), { identities });
await backups.create(mongoSource({ db: client.db('shop') })); // the chain starts again here
```

## Errors

| Thrown | When |
| --- | --- |
| `TypeError: mongoTarget: db must be a MongoDB Db` | `db` is not a driver `Db` |
| `TypeError: mongoTarget: tmpDir must be an absolute path` | a relative `tmpDir` |
| `MongoBackupError` `EXISTS` | a collection or view is already there, or a recorded rename that replaced nothing at the source lands on one, without `replace` |
| `MongoBackupError` `MALFORMED` | an entry, a metadata record or a change this version did not write; documents before their metadata |
| `BackupError` `INTEGRITY`, `DECRYPT`, … | the backup itself — `@nxgt/backup`'s, passed through |
| a driver error — `MongoServerError: E11000 duplicate key error …`, a refused write, a lost connection | passed through unchanged; its message may quote collection names and values |

Every message is in [errors](errors.md) and in
[troubleshooting](../troubleshooting.md).
