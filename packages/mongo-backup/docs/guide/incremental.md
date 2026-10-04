# Incremental and differential backups

This page covers backups that store only what changed since an earlier
one: what the change stream records, where it starts and stops, what it
refuses, and how to schedule them.

`mongoBackups(…).run()` makes incrementals for you, and a full backup when
one is due or the oplog has moved on —
[getting started](getting-started.md#run). This page is what happens inside
each one, and how to make them by hand.

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoSource, mongoTarget } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});
const identities = [process.env.BACKUP_IDENTITY as string];
const source = mongoSource({ db: client.db('shop') });

const full = await backups.create(source); // Sunday
const monday = await backups.create(source, { kind: 'incremental', identities });
// { kind: 'incremental', parent: full.id, entries: full.entries + 1, reused: full.entries, … }
const tuesday = await backups.create(source, { kind: 'incremental', identities });
// { kind: 'incremental', parent: monday.id, entries: full.entries + 2, … }

await backups.restore(tuesday.id, mongoTarget({ db: client.db('shop-restored') }), { identities });
// the full backup's collections, then Monday's changes, then Tuesday's
```

Which backup each kind builds on, the key it needs on the host that makes
it, and how `prune` keeps a chain are `@nxgt/backup`'s rules —
[chains](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/chains.md).
This page is about what `mongoSource` adds to them.

## One more entry: `changes/<n>`

An incremental or differential holds every entry of the backup it builds
on — given again by their recorded fingerprints, so none is read or stored
again — and **one more**: `changes/<n>`, the changes since that backup,
numbered after the changes entries it already holds.

| Backup | Builds on | Its entries |
| --- | --- | --- |
| full, Sunday | — | `metadata/*`, `documents/*` |
| incremental, Monday | Sunday | Sunday's, and `changes/000001`: Sunday to Monday |
| incremental, Tuesday | Monday | Monday's, and `changes/000002`: Monday to Tuesday |
| differential, Wednesday | Sunday | Sunday's, and `changes/000001`: Sunday to Wednesday |

A restore writes the collections as the full backup read them, then
applies each `changes/<n>` in order — [restore](restore.md#changes). An
incremental with nothing changed holds an empty `changes/<n>`, and restores
what its parent did.

## What the change stream records

The source watches the whole database, with `showExpandedEvents` so that
changes to collections and indexes come through, and keeps what a restore
needs to apply each change again — nothing more:

| Event | Kept as | Applied on restore as |
| --- | --- | --- |
| `insert`, `replace` | the document, by its `_id` | a `replaceOne` with `upsert` |
| `update` | the fields set and unset, and the arrays cut — or the whole document, with [post-images](#post-images-and-dotted-field-names) | the arrays cut, then a `$set` and an `$unset`; or a `replaceOne` with `upsert` |
| `delete` | the `_id` | a `deleteOne` |
| `create` | the collection's options | `createCollection` — refused with `EXISTS` when it is there, unless `replace` |
| `createIndexes`, `dropIndexes` | the indexes, or their names | `createIndexes`; `dropIndex`, an index already gone ignored |
| `modify` | what `collMod` changed: a validator, an index made hidden, … | `collMod`; a collection gone ignored |
| `rename` in the database | the new name, and whether it replaced a collection there (`dropTarget`) | `renameCollection`; a collection of that name is replaced if the rename replaced one at the source, refused with `EXISTS` otherwise, unless `replace` — [restore](restore.md#changes) |
| `rename` to another database, `drop` | a drop | `dropCollection`; a collection gone ignored |
| `dropDatabase` | a drop of the database | `dropDatabase`, on the database restored into |

Other events — sharding changes, say — are not kept. Numbers keep their
kind: the stream is read without turning BSON numbers into JavaScript ones.

## Where it starts and stops

- **It starts where the parent stopped**: just after the full backup's
  snapshot time, or where the previous incremental stopped — after the last
  change it read, or at the change stream's own position when it had caught
  up. Nothing is read twice, and nothing in between is missed.
- **It stops at the time the backup started.** The cluster's operation time
  is read before the first entry; the stream stops at the first change
  after it, at the first read that comes back empty — it has caught up —
  or at an invalidation, which a dropped database brings; the next one
  resumes after it. A write that lands while the backup runs is in the
  next one:

```ts
await orders.insertOne({ _id: 2 });
const backup = backups.create(source, { kind: 'incremental', identities });
await orders.insertOne({ _id: 3 }); // while it runs: in the next backup, not this one
await backup;
```

- **It records where it stopped** — the last change's resume token, or the
  change stream's own when it caught up — in
  the backup's catalog, encrypted, for the next one. Nothing is kept on the
  host: any process with the key makes the next incremental.

## Post-images and dotted field names

(Only in a collection the chain follows: one it does not follow is
[passed over](#the-collections-a-chain-follows). Narrowing `collections`
mid-chain does not stop following one — that waits for the next full
backup.)

Without post-images, an update is kept as the change stream describes it:
the fields set, the fields removed, the arrays cut. That cannot say an
update to a field **whose name holds a dot or is a number** — `{ 'x.y': 1 }`,
`{ '3': 1 }` — which would be applied as a path instead. The server marks
such an update, and the backup refuses it rather than record it wrong:

```text
MongoBackupError (UNSUPPORTED): mongoSource: an update touched a field whose name
holds a dot or is a number, which a change cannot say without its post-image;
turn on changeStreamPreAndPostImages for that collection, or make a full backup
```

A collection that keeps **post-images** has every update recorded as the
whole document after it — exact whatever the field names, and larger. Turn
them on for the collections that use such names, then make a full backup:
the update already in the stream has no post-image, so the incremental
that met it fails again until a full backup moves past it.

```ts
await db.command({ collMod: 'settings', changeStreamPreAndPostImages: { enabled: true } });
// or when creating it:
await db.createCollection('settings', { changeStreamPreAndPostImages: { enabled: true } });

await backups.create(source); // a full backup: the next incremental starts after the update
```

A post-image the server no longer holds — expired, or never written — falls
back to the update description, as a collection without post-images does.

## The collections a chain follows

An incremental follows **the collections its full backup held**, plus those
created since that `collections` takes. The full backup's `metadata/<name>`
entries give that set; each position records only how it changed since —
`added` and `removed`, carried on from one incremental to the next — and a
change to any other collection is not recorded. An event on a collection
not followed is passed over before it is translated, so an update there
that a change could not say, or a time-series collection created that the
filter leaves out, never fails the backup. Leaving a collection out gets
past `UNSUPPORTED` at once only for a time-series collection not yet
created; a collection already followed stays followed until the next full
backup.

```ts
const source = mongoSource({ db: client.db('shop'), collections: (name) => name !== 'metrics' });
await backups.create(source); // follows every collection but metrics

await client.db('shop').collection('reviews').insertOne({ stars: 5 }); // a new collection
await backups.create(source, { kind: 'incremental', identities }); // follows reviews from its creation
```

**A change to `collections` takes effect at the next full backup**, never
halfway through a chain — the chain stays one database at one set of
collections:

- **a wider filter does not take in an existing collection halfway**: its
  documents were never read, so the incremental keeps following what the
  full backup held, and the newly taken collection waits for the next full
  backup;
- **a narrower filter does not drop one halfway**: the incremental keeps
  recording the changes to every collection the chain follows.

```ts
await backups.create(mongoSource({ db, collections: ['orders'] }));
const next = await backups.create(mongoSource({ db, collections: ['orders', 'customers'] }), {
	kind: 'incremental',
	identities,
});
// next restores orders, with its changes — not customers
await backups.create(mongoSource({ db, collections: ['orders', 'customers'] })); // now both
```

### Renames

A rename crosses the line between followed and not:

| Renamed | Kept as |
| --- | --- |
| from a followed collection to a name the filter takes | a `rename`; the new name is followed from then on |
| from a followed collection to a name the filter leaves out — `orders` to `orders-old`, with `orders-old` left out | a **drop** of `orders` |
| from a collection not followed to a name the filter takes — `import` to `orders` | refused with `UNSUPPORTED`: the incremental never read the documents it brings |
| from a collection not followed to a name the filter leaves out | nothing |
| to another database | a **drop**: it is gone from this one |

```text
MongoBackupError (UNSUPPORTED): mongoSource: a collection was renamed into those
backed up, with documents an incremental backup never read; make a full backup
```

A restore's own renames count too: a restore lands each collection under
`nxgt-restore-<uuid>` and renames it into place, so **after restoring into
the database you back up** — with `replace: true`, say — the next
incremental sees renames into the followed collections and fails
`UNSUPPORTED`. Make a full backup right after such a restore:

```ts
await backups.restore(id, mongoTarget({ db: client.db('shop'), replace: true }), { identities });
await backups.create(mongoSource({ db: client.db('shop') })); // the chain starts again here
```

A time-series collection created since the parent, among those the filter
takes, is refused, as a full backup refuses one —
[choosing collections](getting-started.md#choosing-collections).

## A dropped database

`dropDatabase` on the database backed up is recorded, and the next backup
resumes just after it. A restore applies it as **a drop of the database
restored into** — everything in it, not only what the backup holds — then
the changes after it. Restore into a database of its own.

## The oplog window

The change stream reads the **oplog**, which the server keeps for a size or
a time, not forever. When the position the parent recorded has fallen out
of it, the incremental fails before it stores anything:

```text
MongoBackupError (HISTORY_LOST): mongoSource: the change stream cannot resume where
the last backup stopped: the oplog no longer reaches back there; make a full backup
```

So:

- **Back up more often than the oplog reaches back**, with a margin for a
  busy day — a burst of writes shortens the window. `rs.printReplicationInfo()`
  in `mongosh` shows it as `log length start to end`.
- **Keep the oplog for longer than the interval**, by time rather than by
  size, on every member (every shard, for a sharded cluster):

```ts
await client.db('admin').command({ replSetResizeOplog: 1, minRetentionHours: 48 });
```

- **A differential reads from its full backup**, so the oplog must reach
  back to the full backup, not to the night before. With a weekly full
  backup, that is a week of oplog; incrementals need only a day.
- **After `HISTORY_LOST`, the next backup must be full**: every incremental
  from the same parent fails the same way.

## A weekly schedule

A full backup on Sunday, an incremental every other night, and a full one
whenever an incremental cannot be made:

```ts
// backup.ts — run nightly with `bun run backup.ts`
import { BackupError, bindBackup, type CreateOptions, defineBackup, localRepository } from '@nxgt/backup';
import { MongoBackupError, mongoSource } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
try {
	const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
		repositories: [localRepository({ path: '/mnt/backups' })],
		recipients: [process.env.BACKUP_RECIPIENT as string],
		tmpDir: '/var/tmp',
	});
	const identities = [(await Bun.file('/etc/backup/identity.txt').text()).trim()]; // chmod 600
	const source = mongoSource({ db: client.db('shop'), collections: (name) => name !== 'metrics' });

	const options: CreateOptions =
		new Date().getUTCDay() === 0 ? { kind: 'full' } : { kind: 'incremental', identities };

	let created;
	try {
		created = await backups.create(source, options);
	} catch (error) {
		const startOver =
			// the first night, or the chain pruned away: nothing to build on
			(error instanceof BackupError && error.code === 'NOT_FOUND') ||
			// the oplog moved on, or a change an incremental cannot record
			(error instanceof MongoBackupError &&
				(error.code === 'HISTORY_LOST' || error.code === 'UNSUPPORTED'));
		if (!startOver) throw error;
		console.warn(`incremental refused (${(error as Error).message}); making a full backup`);
		created = await backups.create(source);
	}
	console.log(`${created.kind} ${created.id}: ${created.entries - created.reused} entries stored`);

	await backups.prune({ keep: { daily: 14, weekly: 8 } }); // keeps every parent a kept backup needs
} finally {
	await client.close();
}
```

A full backup made after `UNSUPPORTED` for a time-series collection fails
too, with the same code: leave the collection out with `collections`.

| | `incremental` | `differential` |
| --- | --- | --- |
| Its `changes/<n>` holds | the changes since the night before | the changes since the full backup: more each night |
| The oplog must reach back | to the night before | to the full backup |
| A restore applies | every `changes/<n>` since the full backup, one per night | one |

Either way a restore reads the full backup's collections whole, then
applies changes; what grows with an incremental chain is the number of
backups that must be there, intact — `@nxgt/backup`'s
[chains](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/chains.md#a-typical-schedule).

## Errors

| Thrown | When |
| --- | --- |
| `MongoBackupError` `HISTORY_LOST` | the oplog no longer reaches the parent's position — [above](#the-oplog-window) |
| `MongoBackupError` `UNSUPPORTED` | an update to a dotted or numeric field name without a post-image; a rename into the collections followed — a restore's own included, [above](#renames); more collections created, renamed or dropped since the full backup than a position records; a time-series collection created |
| `MongoBackupError` `MALFORMED`: `mongoSource: the backup built on recorded no position this version reads; make a full backup` | the parent holds no position this version wrote |
| `MongoBackupError` `MALFORMED`: `mongoSource: an entry of the backup built on was asked for again; it has no fingerprint, so make a full backup` | the parent recorded an entry without the fingerprint this source gave it |
| `BackupError` `NOT_FOUND` | nothing to build on — `@nxgt/backup`'s |

Every one is in [errors](errors.md), and each message in
[troubleshooting](../troubleshooting.md).
