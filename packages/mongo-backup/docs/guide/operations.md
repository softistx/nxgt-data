# Running it in production

This page puts `mongoBackups` on a schedule: the key file and where it
lives, the job, how you know it works, and the `restore` call to make on
the day you need a backup back. Each method is documented on
[getting started](getting-started.md#what-it-returns). The repository's
[`examples/mongo-backup-job`](https://github.com/softistx/nxgt-data/tree/develop/examples/mongo-backup-job)
is this page as code, with a spec that runs the whole cycle against a
replica set.

```ts
// backup.ts — `bun backup.ts run` hourly, `bun backup.ts drill` daily
import { mongoBackups } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const command = Bun.argv[2];
if (command !== 'run' && command !== 'drill') {
	console.error('usage: bun backup.ts run|drill');
	process.exit(2);
}
const client = await MongoClient.connect(process.env.MONGO_URL as string);
try {
	const backups = mongoBackups({
		db: client.db('shop'),
		repository: '/mnt/backups',
		keyFile: process.env.BACKUP_KEY_FILE as string, // absolute; written by keygen
	});
	const report = command === 'run' ? await backups.run() : await backups.drill();
	console.log(JSON.stringify(report)); // ids, sizes, counts: never a key nor a document
} finally {
	await client.close();
}
```

- [The key file](#the-key-file)
- [The job](#the-job)
- [The schedule](#the-schedule)
- [Knowing it works](#knowing-it-works)
- [Forcing a full backup](#forcing-a-full-backup)
- [The day you need it](#the-day-you-need-it)
- [Moving from a job by hand](#moving-from-a-job-by-hand)

## The key file

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key
# recipient: age1…
```

| It holds | Used for | Needed by |
| --- | --- | --- |
| the age identity (`AGE-SECRET-KEY-1…`) | reading backups: an incremental reads the catalog of the one it builds on, `run` reads each new one back, a restore and a drill read the whole chain | `run`, `restore`, `drill` |
| its recipient (`age1…`) | every backup is encrypted to it — derived from the identity, not stored | `run` |
| the Ed25519 signing key (PEM) | every manifest is signed with it | `run` |
| its public key (PEM) | a manifest is read only when signed by it — derived, not stored | every method, `list` included |

- **The job host holds the identity**, because `run` makes incrementals
  and reads every backup back. Whoever takes that host can read the
  backups.
- **A file, not an environment variable**: mode `0600`, named by the
  environment (`BACKUP_KEY_FILE`). A variable ends up in a process listing
  or a crash report more easily than a file does. `readKeyFile` refuses a
  file others than its owner can read or write, with `KEY_FILE`; nothing this package
  throws or reports quotes a key.
- **Keep a copy away from the backups** — a password manager, a safe. A
  backup whose key file is lost is noise.
- **The same file for the job, the drill and a restore**. A missing one
  rejects with `KEY_FILE` (`mongoBackups on "shop": there is no key file there;
  write one with nxgt-mongo-backup keygen`), and is looked for again on the next
  call: a key file deployed after the process started is picked up without
  a restart.

## The job

`run` is the job: a full backup when none is younger than `fullEvery`, an
incremental otherwise, a full one at once when the oplog no longer reaches
the last backup, the new backup read back with the identity, then the
rotation.

```ts
const report = await backups.run();
// { id, kind: 'incremental', fellBack: false, entries: 13, storedSize: 2048, chain: 4, removed: ['…'] }
```

- **A full backup a week** (`DEFAULT_FULL_EVERY`), incrementals in between.
  A restore reads the full backup and every incremental after it, so a
  short chain is a fast restore; `chain` in the report says how long it is.
  Lower `fullEvery` for a database that changes a lot.
- **`HISTORY_LOST` starts a new chain** at once, with `fellBack: true`:
  until a full backup, every incremental would fail alike —
  [the oplog window](incremental.md#the-oplog-window).
- **Every backup is read back** with the identity — decrypted, every digest
  and the signature checked — before the rotation. A backup never read back
  is not a backup yet.
- **The rotation runs after the backup**, never before, with `keep`
  (`DEFAULT_KEEP`: a day hourly, two weeks daily, two months weekly, a year
  monthly). A kept incremental keeps the backups it builds on, so a
  rotation never breaks a chain —
  [`@nxgt/backup`'s rotation](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/rotation.md).
  `keep: false` leaves the rotation to you.
- **One writer at a time**: `create` and `prune` take the repository's
  lock, so a run that overlaps the last one fails rather than interleave.
  The backup rejects with `BackupError` `NOT_STORED` — `PARTIAL` when
  another repository took it — the `LOCKED` in that repository's outcome;
  the rotation rejects with `LOCKED`, after the backup was made and read
  back —
  [as `@nxgt/backup`'s locking shows](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/locking.md).
  Let the scheduler skip such a run, not retry it in a loop.
- **Anything else is thrown** as it is: `UNSUPPORTED`, `CHANGING`,
  `SNAPSHOT_TOO_OLD`, a driver error. A run that fails while backing up
  pruned nothing — [errors](errors.md).

## The schedule

| What | How often | Why |
| --- | --- | --- |
| `run()` | hourly | an hour is what you can lose |
| `drill()` | daily or weekly | a backup never restored is a hope |
| an off-site copy | with every run | a second repository in `repository`, an S3 bucket — every backup is written to each |

```text
0 * * * *  cd /srv/backup && bun backup.ts run
30 4 * * * cd /srv/backup && bun backup.ts drill
```

Two server settings bound what the job can do:

- **The oplog** must hold more than the time between two runs, with room
  for a burst of writes — or every run falls back to a full backup, and
  `fellBack: true` says so. `rs.printReplicationInfo()` gives its window.
- **`minSnapshotHistoryWindowInSeconds`** (300 by default) must be longer
  than a full backup takes to read, or it fails with `SNAPSHOT_TOO_OLD` —
  [a long snapshot](getting-started.md#a-long-snapshot).

## Knowing it works

- **Exit non-zero on failure**, and let the scheduler alert on it. Print
  the report, one line of JSON per run.
- **Alert on `fellBack: true`** too: the run worked, but stored the whole
  database — the oplog window is shorter than the interval.
- **Alert on silence**: a job that stopped running fails nothing. The
  newest backup older than two runs is an alert. `list()` decrypts
  nothing, but reads the key file, for the key manifests are signed with:

```ts
const newest = (await backups.list()).at(-1);
if (!newest || Date.now() - newest.createdAt.getTime() > 2 * 60 * 60 * 1000) {
	console.error('no backup for two hours');
	process.exit(1);
}
```

- **Drill**: `drill()` restores the newest backup, chain included, into
  `nxgt-drill-<uuid>` on the same client, counts each collection's
  documents, and drops it. Check the counts against what you expect, not
  only that it resolved:

```ts
const { id, collections } = await backups.drill();
const orders = collections.find((c) => c.name === 'orders')?.documents ?? 0;
if (orders === 0) throw new Error(`drill of ${id}: no orders`);
```

A drill costs a whole restore on the cluster backed up: schedule it away
from the busy hours, and give the user the right to create a database. A
process killed mid-drill leaves `nxgt-drill-<uuid>` behind; drop it by
hand.

## Forcing a full backup

An incremental that fails `UNSUPPORTED` — a rename into the backed-up
collections, a dotted-field update without post-images, a time-series
collection created — fails again on every `run` until a full backup: the
change it stopped on is still in the stream. A change to `collections`
waits for one too. Give `run` a `now` a `fullEvery` ahead: it then finds
no full backup young enough, and makes one.

```ts
import { DEFAULT_FULL_EVERY } from '@nxgt/mongo-backup';

await backups.run(new Date(Date.now() + DEFAULT_FULL_EVERY)); // { kind: 'full', chain: 1, … }
```

`now` decides the kind and nothing else: the backup carries the machine's
time, and the rotation goes by the machine's clock too — a later `now`
there would rotate away the backup just made. The full backup is read
back and rotated like any other, with the same `collections`. Pass your own
`fullEvery` if it is not the default.

Through the binding, the same by hand — give `mongoSource` the same
`collections` as `mongoBackups`:

```ts
import { mongoSource } from '@nxgt/mongo-backup';

const { backups: bound, keys } = await backups.binding();
const full = await bound.create(mongoSource({ db: client.db('shop') }));
await bound.verify(full.id, { identities: [keys.identity] });
```

The next `run` builds on it. After a restore into the database you back up,
do the same: the restore's own renames would otherwise fail the next
incremental —
[into the database you back up](restore.md#into-the-database-you-back-up).

## The day you need it

| You need | Run |
| --- | --- |
| the whole database, elsewhere | `backups.restore({ into: client.db('shop-restored') })` |
| the whole database as it was at a time | `backups.restore({ into: client.db('shop-restored'), at: new Date('2026-10-04T09:00:00Z') })` |
| the whole database, in place | `backups.restore({ into: client.db('shop'), replace: true })` — once the application is stopped |
| one collection as it was, beside the live one | `backups.restore({ into: client.db('shop'), collections: ['orders'], as: { orders: 'orders-before' } })` |
| some documents back | `backups.restore({ into: client.db('shop'), collections: ['orders'], documents: { filter: { _id: 'o-1001' }, existing: 'keep' } })` — [some documents](restore.md#some-documents) |

- **Pick the backup by time**: `at: new Date(…)` takes the newest backup
  made at or before it, an incremental included. `list()` gives each one's
  `createdAt` and `id`, and `at` takes an id too.
- **Restore beside, then swap**: restoring into another database and
  checking it costs a little time and leaves the live data untouched until
  you are sure.
- **A partial restore rebuilds the whole backup first**, in a scratch
  database on the same client, then moves what was asked for: it costs a
  full restore, whatever it brings back —
  [restoring part of a backup](restore.md#restoring-part-of-a-backup).
- **After a restore into the database you back up**, make a full backup —
  [forcing a full backup](#forcing-a-full-backup).

## Moving from a job by hand

`mongoBackups` sees only the backups under its `name` — the database's
name by default — whose manifest is signed with its key file's signing
key. A job that called `bindBackup` and `mongoSource` itself, under another
name or with keys of its own, does not hand its chain over: the first
`run` is a full backup, and the old backups are left to the old job's
rotation. Restore those with the lower level and the keys they were made
with — [restore](restore.md).
