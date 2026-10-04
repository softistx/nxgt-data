# Getting started

This page takes you from a MongoDB database to a first encrypted full
backup and a first restore, with every option of `mongoSource`.

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoSource, mongoTarget } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string); // a replica set
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string], // age1… — a public key
});

const created = await backups.create(mongoSource({ db: client.db('shop') }));
// { id: '20261004T221500123Z-9f3a61c0', kind: 'full', parent: null, entries: 12, … }

await backups.verify(created.id); // every object against the manifest, no key

await backups.restore(created.id, mongoTarget({ db: client.db('shop-restored') }), {
	identities: [process.env.BACKUP_IDENTITY as string], // AGE-SECRET-KEY-1…
});
```

`defineBackup`, `bindBackup`, the keys and the repositories are
`@nxgt/backup`'s; its
[getting started](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/getting-started.md)
covers them. This package gives the source and the target.

## What you need

- **Bun**, as `@nxgt/backup` needs.
- **A replica set.** A full backup is a snapshot read, and an incremental
  reads the change stream: a standalone `mongod` serves neither. A
  single-node replica set is enough — `mongod --replSet rs0`, then
  `rs.initiate()` once. A sharded cluster serves both too, but is untested:
  the specs run against a replica set, and a restore does not shard a
  collection.
- **A `Db` from the `mongodb` driver**, 7.x. Not a database name, and not a
  model: the backup takes the whole database.

```sh
bun add @nxgt/mongo-backup @nxgt/backup mongodb
```

## `mongoSource`

```ts
type CollectionFilter = readonly string[] | ((name: string) => boolean);

interface MongoSourceOptions {
	db: Db;
	collections?: CollectionFilter | undefined;
}

function mongoSource(options: MongoSourceOptions): BackupSource; // kind: 'mongo'
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `db` | `Db` | required | the database to back up. Its client must reach a replica set or a sharded cluster |
| `collections` | `readonly string[] \| ((name: string) => boolean)` | every collection and view but `system.*` | which collections and views to read: their names, or a test on each name |

`mongoSource` checks its options at once, and touches nothing:

```ts
mongoSource({ db: 'shop' as never });
// TypeError: mongoSource: db must be a MongoDB Db

mongoSource({ db: client.db('shop'), collections: 'orders' as never });
// TypeError: mongoSource: collections must be a list of names or a function
```

The types refuse both before they run. The source keeps nothing between
backups — where the next incremental resumes is recorded in the backup
itself — so a new process makes the next backup with a new `mongoSource`.
Give one `create` at a time a given source object: it holds the position of
the backup it is reading until `@nxgt/backup` asks for it.

## What a full backup holds

For each collection, in name order:

| Entry | Holds |
| --- | --- |
| `metadata/<name>` | its options as `listCollections` gives them — validator, collation, capped size, … — and its indexes as `listIndexes` gives them, `_id` apart |
| `documents/<name>` | every document, as concatenated BSON: the bytes `mongodump` writes to a `.bson` file |

- **A view** has its metadata only — `viewOn` and `pipeline` among its
  options — and is created from it on restore.
- **A GridFS bucket** is two plain collections, `<bucket>.files` and
  `<bucket>.chunks`, backed up and restored like the others. With a list,
  name both: `collections: ['orders', 'fs.files', 'fs.chunks']`.
- **`system.*` is never read**, whatever `collections` says: neither
  `system.views` (views come back from their metadata), nor `system.js`, nor
  `system.profile`. Users and roles live in the `admin` database, not in
  the one backed up.
- **Numbers keep their kind.** Documents are read raw and written back raw:
  an `Int32`, a `Long`, a `Double` and a `Decimal128` come back as they
  were, as do dates, binaries and regular expressions.

The byte layout is on the [format](format.md) page.

## Choosing collections

A list names exactly what to back up:

```ts
const source = mongoSource({ db: client.db('shop'), collections: ['orders', 'customers'] });
```

**A name in the list that the database lacks rejects the backup** — a typo
would otherwise back up nothing, and say nothing. The check runs when the
full backup starts reading, so it is `create` that rejects, before any entry
is stored:

```ts
await backups.create(mongoSource({ db: client.db('shop'), collections: ['ordres'] }));
// TypeError: mongoSource: a collection named in collections is not in the database
```

A test picks what it returns `true` for, and never complains about a
collection that is not there — the way to leave something out:

```ts
const source = mongoSource({
	db: client.db('shop'),
	collections: (name) => !name.startsWith('cache.') && name !== 'metrics',
});
```

Either form applies to views as to collections, and to the changes an
[incremental](incremental.md#the-collections-a-chain-follows) backup
records: a change to a collection the chain does not follow is not
recorded. A change to
`collections` takes effect at the **next full backup**: an incremental
follows the collections its full backup held, plus those created since that
the filter takes.

**A time-series collection is refused**, not skipped: a full backup that
meets one rejects with `UNSUPPORTED`, and the way out is to leave it out:

```ts
await backups.create(mongoSource({ db: client.db('shop') }));
// MongoBackupError (UNSUPPORTED): mongoSource: a collection is of a type this version
// does not back up (a time-series one); leave it out with collections

await backups.create(mongoSource({ db: client.db('shop'), collections: (name) => name !== 'metrics' }));
```

## One cluster time

A full backup opens **one snapshot session** before it gives its first
entry, and reads every collection in it. Every document it holds is as it
was at that one cluster time, however long the backup runs: a write that
lands after the snapshot opened is not in it, even in a collection read an
hour later. That is what makes the collections agree with each other — an
order and its customer, a GridFS file and its chunks.

The collections, their options and their indexes are not read in a
snapshot — the server does not serve those reads at a cluster time — so a
full backup reads them **before** it pins the snapshot and **again after**.
The same both times, they are what the snapshot holds; otherwise it pins
again, up to five times, then fails:

```text
MongoBackupError (CHANGING): mongoSource: the collections or their indexes kept
changing while the snapshot was taken; try again when they settle
```

Nothing is stored when it does: run the backup again once whatever was
creating, dropping or indexing collections has finished. Past that point
the metadata entries come from what was read, not from the database, so:

- **an index built while the backup runs** is not in it: it arrives in the
  next incremental, as a `createIndexes` change, and a restore of this
  backup has the collection without it;
- **a collection dropped or renamed while it runs** is still read, at the
  snapshot, as it was.

The next incremental starts **just after** that cluster time, so it replays
nothing the full backup holds, and misses nothing written since. It follows
the collections this backup holds — its `metadata/<name>` entries say
which, and each position records only what changed since, on the
[format](format.md#the-position-and-the-fingerprints) page.

## A long snapshot

The server keeps the history a snapshot reads for
`minSnapshotHistoryWindowInSeconds` — 300 seconds by default. A full
backup reads its collections one at a time, and each entry is compressed,
encrypted and stored in every repository before the next is read, so the
whole backup — slow repositories included — must fit in that window, or it
fails:

```text
MongoBackupError (SNAPSHOT_TOO_OLD): mongoSource: the snapshot outlived the history
the server keeps; raise minSnapshotHistoryWindowInSeconds, or back up fewer
collections at a time
```

Raise the window on every member that may serve the read (on every shard,
for a sharded cluster), to more than your longest full backup:

```ts
await client.db('admin').command({ setParameter: 1, minSnapshotHistoryWindowInSeconds: 3600 });
```

The server keeps more history for it, in its cache and on disk; set it
back once the backup is done if that matters to you. Or split the database
into two definitions with two `collections` lists — at the cost of the one
cluster time, which then holds within each backup, not between them.

## Restore

```ts
import { mongoTarget } from '@nxgt/mongo-backup';

await backups.restore(created.id, mongoTarget({ db: client.db('shop-restored') }), {
	identities: [process.env.BACKUP_IDENTITY as string],
});
```

Each collection lands whole or not at all; one already there is refused
with `EXISTS` unless `replace: true` — [restore](restore.md) has every
option.

## A nightly job

A full backup every night, checked, rotated, run with `bun run`. Once
incrementals make sense, [incremental](incremental.md#a-weekly-schedule) has
the weekly schedule.

```ts
// backup.ts — run with `bun run backup.ts` from cron
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { MongoBackupError, mongoSource } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
try {
	const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
		repositories: [localRepository({ path: '/mnt/backups' })],
		recipients: [process.env.BACKUP_RECIPIENT as string],
		tmpDir: '/var/tmp',
	});

	const created = await backups.create(
		mongoSource({ db: client.db('shop'), collections: (name) => name !== 'metrics' }),
	);
	await backups.verify(created.id);
	await backups.prune({ keep: { daily: 14, weekly: 8 } });
	console.log(`backup ${created.id}: ${created.entries} entries, ${created.storedSize} bytes`);
} catch (error) {
	if (error instanceof MongoBackupError) {
		console.error(`backup failed (${error.code}): ${error.message}`, error.cause);
	}
	throw error;
} finally {
	await client.close();
}
```

## A restore drill in a spec

A backup nobody restored is a hope. A spec that restores the latest backup
into a database of its own and compares counts, with `bun test`:

```ts
import { afterAll, expect, test } from 'bun:test';
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoTarget } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const drill = client.db(`drill-${crypto.randomUUID()}`);
afterAll(async () => {
	await drill.dropDatabase();
	await client.close();
});

test('the latest backup restores', async () => {
	const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
		repositories: [localRepository({ path: '/mnt/backups' })],
		recipients: [process.env.BACKUP_RECIPIENT as string],
	});
	const latest = (await backups.list()).backups.at(-1);
	if (!latest) throw new Error('no backup to restore');

	await backups.restore(latest.id, mongoTarget({ db: drill }), {
		identities: [process.env.BACKUP_IDENTITY as string],
	});

	expect(await drill.collection('orders').countDocuments()).toBeGreaterThan(0);
	const names = (await drill.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
	expect(names.some((name) => name.startsWith('nxgt-restore-'))).toBe(false);
}, 600_000);
```

Next: [incremental](incremental.md), to store only what changed.
