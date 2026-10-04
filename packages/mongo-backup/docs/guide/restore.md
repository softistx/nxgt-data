# Restore

This page covers bringing a database back from a backup with `mongoTarget`:
its options, the order things land in, what `replace` does, how changes
are applied, and what a failure leaves — then bringing back only some
collections, or some documents, with `restoreCollections`.

`mongoBackups(…).restore()` calls one or the other for you — `mongoTarget`
for a whole restore, `restoreCollections` when `collections`, `as` or
`documents` is given — so what this page says of them holds for it too.
Its own options are in [getting started](getting-started.md#restore).

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
| a view where the backup holds a collection | it is dropped once the restored collection is built, just before the rename — the server renames over a collection, never over a view |
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
then creates without their options. To get one collection as an
incremental left it, use `restoreCollections`, which replays the whole
chain apart and takes the collection from there —
[restoring part of a backup](#restoring-part-of-a-backup).

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

## Restoring part of a backup

`restoreCollections` brings back some collections and views — whole, or
only the documents a query takes — from a backup, chain included, under
their own names or others, into a database that already holds other data.

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

const done = await restoreCollections(backups, id, {
	identities,
	db: client.db('shop'),
	collections: ['orders'],
	as: { orders: 'orders-before' },
});
// done.collections: [{ name: 'orders', as: 'orders-before' }]
```

### How it runs

1. It checks its options. A wrong one rejects with a `TypeError` before
   anything is read — but for what only the backup's names can tell,
   below — and a `scratch` that is not empty with `EXISTS`.
2. It **rebuilds the whole backup**, chain included, in a scratch
   database, through `mongoTarget` — every entry `restore` would land,
   every change applied.
3. It takes what was asked for from the scratch database into `db`.
4. It **drops the scratch database**, whether that worked or not.

**The cost is the whole backup's**, even for one document: every
collection is downloaded, decrypted, written to the scratch database and
indexed, and every change applied, before one byte reaches `db`. Plan for
the time, and for the room on the server, of a full restore.

The rebuild is an ordinary `restore`: a `BackupError` from `@nxgt/backup`
or a driver error passes through as it is; a refusal of the `mongoTarget`
behind it is told as `restoreCollections: …`, same class and code, the
`mongoTarget:` original as its `cause` ([errors](errors.md)). The scratch
database is dropped all the same.

### Its signature

```ts
function restoreCollections(
	backups: Restorer,
	id: string,
	options: RestoreCollectionsOptions,
): Promise<RestoredCollections>;

/** What it needs of a bound backup: its `restore`. */
interface Restorer {
	restore(id: string, target: RestoreTarget, options: RestoreOptions): Promise<Restored>;
}

/** Some documents of each collection, merged into what is there. */
interface DocumentSelection {
	filter: Document;
	existing: 'replace' | 'keep';
}

type RestoreCollectionsOptions =
	| (Common & { documents?: undefined; replace?: boolean | undefined }) // whole
	| (Common & { documents: DocumentSelection; replace?: never }); // documents

interface RestoredCollections extends Restored {
	collections: { name: string; as: string; documents?: number }[];
}
```

`backups` is anything with a `restore` of that shape — what `bindBackup`
returns, or a fake in a test. `Common` stands for the options both modes
share, below; it is not exported. `Restorer`, `DocumentSelection`,
`RestoreCollectionsOptions` and `RestoredCollections` are.

### Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `identities` | `readonly string[]` | required | the age secret keys that open the backup, as `restore` takes them |
| `from` | `string` | the first repository | the repository to read from, by name |
| `db` | `Db` | required | the database to restore into |
| `collections` | `readonly string[] \| ((name: string) => boolean)` | every collection and view but `system.*` | what to restore, by its name **at the backup's time** |
| `as` | `Record<string, string> \| ((name: string) => string)` | each keeps its own name | the name each one lands under |
| `scratch` | `Db` | a fresh `nxgt-restore-<uuid>` on `db.client` | where the backup is rebuilt; dropped afterwards |
| `tmpDir` | `string` | the system's temporary folder | where a `changes/<n>` entry is staged during the rebuild — [`mongoTarget`](#mongotarget) |
| `replace` | `boolean` | `false` | whole mode only: replace a collection or view already there |
| `documents` | `DocumentSelection` | none: whole mode | restore only the documents `filter` takes, merged into what is there |

### `collections`: names at the backup's time

The names are those the collections had **when the backup was made**,
after the chain has replayed every rename up to it — not those the source
database has today. A collection renamed from `a` to `orders` before an
incremental is `orders` in that incremental, and `a` in the full backup
before it.

A **list** must name what the backup holds: a name it lacks rejects the
call with `NOT_FOUND`, after the rebuild and before anything reaches `db`.
A typo would otherwise restore nothing, and say nothing.

```ts
await restoreCollections(backups, id, { identities, db, collections: ['a'] });
// MongoBackupError (NOT_FOUND): restoreCollections: a collection named in collections is not in the backup
```

A **function** is asked about each name, and picks what it returns `true`
for; it never fails for a name it does not see. Either way, `system.*` is
never restored, and a view is picked like a collection.

### `as`: the name each one lands under

A **record** renames those it lists; the others keep their own name. A
**function** is asked for every name `collections` picked, views
included:

```ts
await restoreCollections(backups, id, {
	identities,
	db: client.db('shop'),
	collections: ['orders', 'orders-open'], // orders-open is a view on orders
	as: (name) => `${name}-restored`,
});
// orders → orders-restored, and the view orders-open-restored reads orders-restored
```

A name it gives must be one MongoDB takes. Each of these rejects with a
`TypeError` before anything reaches `db`. A map is checked before the
backup is read, for its names and for two of its keys given one name; a
clash with a collection that keeps its own name, a key that names nothing
restored, and anything a function gives, once the rebuild has given the
names:

| `as` gives | Message |
| --- | --- |
| an empty name, a name holding `$` or a NUL, a name starting with `system.`, or not a string | `TypeError: restoreCollections: as must give a collection name` |
| the same name to two collections or views | `TypeError: restoreCollections: as gives two collections one name` |
| a map key that names no collection or view restored — a typo, or a view when `documents` is given | `TypeError: restoreCollections: as names a collection not restored` |

### The scratch database

By default the backup is rebuilt in a fresh database,
`nxgt-restore-<uuid>`, on the same client as `db`. **The user that runs
the restore needs the right to create that database**, write to it and
drop it — and, in whole mode, to rename a collection from it into `db`.

`scratch` names another one — on a server where that user may only use
certain databases, say:

```ts
await restoreCollections(backups, id, {
	identities,
	db: client.db('shop'),
	scratch: client.db('restore-scratch'), // must be empty; it is dropped afterwards
	collections: ['orders'],
	as: { orders: 'orders-before' },
});
```

- It must be **empty** — `system.*` aside — since it is dropped
  afterwards. One that holds a collection is refused before anything is
  read, and left as it is:
  `MongoBackupError (EXISTS): restoreCollections: the scratch database holds collections; give an empty one`.
- It must be **another database than `db`**:
  `TypeError: restoreCollections: scratch must be another database`.
- It must be **on `db`'s client**: a collection moves from it with a
  rename across databases, and documents with a `$merge`, and both name
  `db` on the server they run on — from another client, documents would
  land in a database of that name on the other server:
  `TypeError: restoreCollections: scratch must be on db's client`.

A process killed mid-restore cannot drop it, and a drop that fails — a
lost connection — leaves it without failing the restore: drop any
database named `nxgt-restore-…` once nothing runs.

```ts
const { databases } = await client.db('admin').admin().listDatabases();
for (const { name } of databases) {
	if (name.startsWith('nxgt-restore-')) await client.db(name).dropDatabase();
}
```

### Whole collections

Without `documents`, each collection and view lands whole, as it was at
the backup's time:

- **A collection is moved** from the scratch database into `db` with a
  `renameCollection` across databases, so it keeps its options —
  validator, collation, capped size — and its indexes.
- **A view is made again** in `db`, after the collections. When the
  collection it reads is restored too, it reads that collection's **new
  name**; otherwise it reads the name it had.
- **A name already taken is refused** with `EXISTS`, every one checked
  **before anything moves**. A collection created under one of those names
  in the meantime is refused by the server at its rename, with the same
  `EXISTS`, rather than replaced.
- **With `replace: true`**, what stands under the name is replaced — a
  view too: the server renames over a collection, never over a view, so a
  view there is dropped first.

```ts
import { MongoBackupError, restoreCollections } from '@nxgt/mongo-backup';

try {
	await restoreCollections(backups, id, { identities, db: client.db('shop'), collections: ['orders'] });
} catch (error) {
	if (!(error instanceof MongoBackupError && error.code === 'EXISTS')) throw error;
	// MongoBackupError (EXISTS): restoreCollections: a collection or view to restore is
	// already in the database; restore it under another name, or pass replace: true
}
```

- **`replace: true` replaces instead**: a collection there is dropped by
  the rename itself (`dropTarget`), a view there is dropped and made again.

```ts
await restoreCollections(backups, id, {
	identities,
	db: client.db('shop'),
	collections: ['orders'],
	replace: true, // orders as it was at the backup, in place of today's
});
```

The result says what landed where, in name order:

```ts
// { id, repository, entries, size, collections: [
//   { name: 'ones', as: 'ones' },
//   { name: 'orders', as: 'orders-then' },
// ] }
```

### Some documents

`documents` takes, from each collection picked, the documents `filter`
matches — any query `find` takes: `{ _id: id }`, `{ _id: { $in: ids } }`,
`{ customer: 'c-42' }` — and merges them into the collection `db` has
under its `as` name, matched on `_id` (a `$merge`). Documents there that
the filter does not reach are left alone, and so are those the backup no
longer holds: nothing is deleted.

```ts
const done = await restoreCollections(backups, id, {
	identities,
	db: client.db('shop'),
	collections: ['customers'],
	documents: { filter: { _id: { $in: [1, 2] } }, existing: 'keep' },
});
// done.collections: [{ name: 'customers', as: 'customers', documents: 2 }]
```

`existing` is **required**: it says what a document already in `db` with
the same `_id` becomes.

| `existing` | A document there with the same `_id` | One not there |
| --- | --- | --- |
| `'replace'` | becomes the backup's | is inserted |
| `'keep'` | stays as it is | is inserted |

- **A collection `db` lacks is made first**, with the backup's options and
  indexes, then the documents merged into it.
- **Views are left out**: they hold no documents, and do not appear in
  the result. An `as` map naming one is refused like any name not
  restored.
- **`documents` in the result** is the number of documents the filter
  matched **in the backup**, not the number written: with `'keep'`, a
  document already there counts though it was not touched.
- **Documents are written with `bypassDocumentValidation`**, as a whole
  restore writes them.
- **`replace` has no meaning here**, and is refused: by the types, and at
  runtime with
  `TypeError: restoreCollections: replace is for whole collections; documents says what happens to those there`.

```ts
restoreCollections(backups, id, {
	identities,
	db,
	documents: { filter: {}, existing: 'keep' },
	replace: true, // type error: replace is for whole collections
});
```

A `documents` that is not `{ filter, existing }` — a `filter` that is an
array or a BSON value, an `existing` other than the two — is
`TypeError: restoreCollections: documents must be { filter, existing: 'replace' | 'keep' }`.

### Into the database you back up

Documents merged into the database a `mongoSource` backs up are recorded
by the next incremental like any other write. A whole collection moved
there is too — **unless the chain follows a filter that does not take
`tmpXXXXX.renameCollection`**, as a list of names never does: the server
moves a collection across databases through that temporary one, so the next
incremental refuses the rename into it with `UNSUPPORTED` —
`mongoSource: a collection was renamed into those backed up, with
documents an incremental backup never read; make a full backup`. Make a
full backup after such a restore, or let the chain follow every
collection — measured on mongod 8.2.

### Bringing back one deleted document

A function an admin route or a job calls to restore one customer as the
last backup had them, without touching anything else:

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { MongoBackupError, restoreCollections } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});
const identities = [process.env.BACKUP_IDENTITY as string];

/** The customer as the last backup had them, put back unless they are there. Whether the backup held them. */
export async function restoreCustomer(customerId: string): Promise<boolean> {
	const latest = (await backups.list()).backups.at(-1);
	if (!latest) return false;
	try {
		const { collections } = await restoreCollections(backups, latest.id, {
			identities,
			db: client.db('shop'),
			collections: ['customers'],
			documents: { filter: { _id: customerId }, existing: 'keep' },
			tmpDir: '/var/tmp',
		});
		return (collections[0]?.documents ?? 0) > 0;
	} catch (error) {
		if (error instanceof MongoBackupError && error.code === 'NOT_FOUND') return false; // no customers then
		throw error;
	}
}
```

It takes as long as a full restore: call it from a job queue rather than
inside a request when the backup is large.

### What a failure leaves

The scratch database is always dropped — except when a given `scratch`
is refused for not being empty, which leaves it as it was. In `db`:

- a `TypeError` from the options, `NOT_FOUND`, a `TypeError` from `as`, a
  failed rebuild and, in whole mode without `replace`, the `EXISTS` check
  all come **before anything reaches `db`**: it is untouched;
- a failure while landing — a rename the server refuses, a lost
  connection — keeps what landed before it: the collections already
  moved, or the documents already merged. In whole mode the views come
  last, so a failure among the collections leaves none of them made.

### Limits

- **A sharded collection cannot be restored whole**: MongoDB does not
  rename a sharded collection across databases. A sharded cluster is
  untested anyway — [install](../../README.md#install).
- **A view's `$lookup` is not renamed.** A view made again reads its
  restored collection's new name, but a `$lookup`, `$graphLookup` or
  `$unionWith` inside its pipeline still names the collection it named.
- **The whole backup is rebuilt** for any part of it — [how it runs](#how-it-runs).

## Errors

| Thrown | When |
| --- | --- |
| `TypeError: mongoTarget: db must be a MongoDB Db` | `db` is not a driver `Db` |
| `TypeError: mongoTarget: tmpDir must be an absolute path` | a relative `tmpDir` |
| `MongoBackupError` `EXISTS` | a collection or view is already there, or a recorded rename that replaced nothing at the source lands on one, without `replace` |
| `MongoBackupError` `MALFORMED` | an entry, a metadata record or a change this version did not write; documents before their metadata |
| `TypeError: restoreCollections: …` | `restoreCollections` given options it cannot use — [the messages](errors.md#the-bare-typeerrors) |
| `MongoBackupError` `EXISTS`, from `restoreCollections` | a collection or view to restore is already in `db`, without `replace`; or the `scratch` given holds collections — [whole collections](#whole-collections) |
| `MongoBackupError` `NOT_FOUND` | a name in `restoreCollections`' `collections` list is not in the backup — [`collections`](#collections-names-at-the-backups-time) |
| `BackupError` `INTEGRITY`, `DECRYPT`, … | the backup itself — `@nxgt/backup`'s, passed through |
| a driver error — `MongoServerError: E11000 duplicate key error …`, a refused write, a lost connection | passed through unchanged; its message may quote collection names and values |

Every message is in [errors](errors.md) and in
[troubleshooting](../troubleshooting.md).
