# Running it in production

The other pages document each call. This one puts them together as a job
you schedule, the keys it holds, how you know it works, and what to run on
the day you need a backup back. The repository's
[`examples/mongo-backup-job`](https://github.com/softistx/nxgt-data/tree/develop/examples/mongo-backup-job)
is this page as code, with a spec that runs the whole cycle against a
replica set.

- [The keys and where they live](#the-keys-and-where-they-live)
- [The job](#the-job)
- [The schedule](#the-schedule)
- [Knowing it works](#knowing-it-works)
- [The day you need it](#the-day-you-need-it)

## The keys and where they live

| Key | Made with | The backup job holds | A restore holds |
| --- | --- | --- | --- |
| age recipient (`age1…`) | `age-keygen -y identity.txt`, or `identityToRecipient` from `age-encryption` | yes — every backup is encrypted to it | no |
| age identity (`AGE-SECRET-KEY-…`) | `age-keygen -o identity.txt`, or `generateIdentity` | **yes**: an incremental reads the catalog of the backup it builds on | yes |
| Ed25519 signing key (PEM, PKCS#8) | `generateSigningKeys().privateKey` from `@nxgt/backup` | yes — every manifest is signed with it | no |
| Ed25519 public key (PEM, SPKI) | `generateSigningKeys().publicKey` | derived from the private one | yes, as `trusted` |

- **The job host holds the identity**, because `create` with
  `kind: 'incremental'` or `'differential'` needs `identities`. Whoever
  takes that host can read the backups. A job that makes full backups only
  needs no identity — at the cost of storing everything every time.
- **Keep the secrets in files**, mode `0600`, named by the environment
  (`BACKUP_IDENTITY_FILE`, `BACKUP_SIGNING_KEY_FILE`): an environment
  variable ends up in a process listing or a crash report more easily than
  a file does. Never log them; nothing this package throws quotes them.
- **Keep a copy of the identity away from the backups** — a password
  manager, a safe. A backup whose identity is lost is noise.

## The job

One run, from a scheduler:

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { MongoBackupError, mongoSource } from '@nxgt/mongo-backup';

const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [recipient],
	signing: { key: signingKey },
});
const identities = [identity];
const source = mongoSource({ db: client.db('shop') });

const { backups: held } = await backups.list();
const DAY = 24 * 60 * 60 * 1000;
const fullThisWeek = held.some(
	(b) => b.kind === 'full' && Date.now() - b.createdAt.getTime() < 7 * DAY,
);
const created = fullThisWeek
	? await backups
			.create(source, { kind: 'incremental', identities })
			.catch((error) => {
				// The oplog no longer reaches where the chain stopped.
				if (error instanceof MongoBackupError && error.code === 'HISTORY_LOST') {
					return backups.create(source);
				}
				throw error;
			})
	: await backups.create(source);

await backups.verify(created.id, { identities });
await backups.prune({ keep: { last: 24, daily: 14, weekly: 8, monthly: 12 } });
```

- **A full backup a week**, incrementals in between. A restore reads the
  full backup and every incremental after it, so a short chain is a fast
  restore; a full backup a week bounds it to a week of changes.
- **`HISTORY_LOST` starts a new chain** at once: until a full backup, every
  incremental would fail alike —
  [the oplog window](incremental.md#the-oplog-window).
- **`verify` with the identity** reads the new backup back, decrypts it and
  checks every digest and the signature. A backup never read back is not a
  backup yet.
- **`prune` after the backup**, never before: a kept incremental keeps the
  backups it builds on, so a rotation never breaks a chain —
  [`@nxgt/backup`'s rotation](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/rotation.md).
- **One writer at a time**: `create` and `prune` take the repository's
  lock, so a run that overlaps the last one fails with `LOCKED` rather than
  interleave — let the scheduler skip it, not retry it in a loop.

## The schedule

| What | How often | Why |
| --- | --- | --- |
| the job above | hourly | an hour is what you can lose |
| a restore drill | daily or weekly | a backup never restored is a hope |
| an off-site copy | with the job | a second repository in `repositories`, an S3 bucket — every `create` writes to each |

Two server settings bound what the job can do:

- **The oplog** must hold more than the time between two runs, with room
  for a burst of writes — or the next incremental gets `HISTORY_LOST` and
  the job falls back to a full backup. `rs.printReplicationInfo()` gives its
  window.
- **`minSnapshotHistoryWindowInSeconds`** (300 by default) must be longer
  than a full backup takes to read, or it fails with `SNAPSHOT_TOO_OLD` —
  [a long snapshot](getting-started.md#a-long-snapshot).

## Knowing it works

- **Exit non-zero on failure**, and let the scheduler alert on it. Print
  one line of JSON per run — the backup's id, kind, size, what `prune`
  removed — never a document or a key.
- **Alert on silence too**: a job that stopped running fails nothing.
  `backups.list()` needs no key; the newest backup older than two runs is
  an alert.
- **Drill a restore**: the newest backup, chain included, into a database
  of its own, counted, then dropped:

```ts
import { restoreCollections } from '@nxgt/mongo-backup';

const { backups: held } = await backups.list();
const newest = held.at(-1);
const drill = client.db(`drill-${crypto.randomUUID()}`);
try {
	const restored = await restoreCollections(backups, newest.id, { identities, db: drill });
	for (const { as } of restored.collections) {
		console.log(as, await drill.collection(as).countDocuments());
	}
} finally {
	await drill.dropDatabase();
}
```

## The day you need it

| You need | Run |
| --- | --- |
| the whole database, elsewhere | `backups.restore(id, mongoTarget({ db: client.db('shop-restored') }), { identities })` — [restore](restore.md) |
| the whole database, in place | the same with `db: client.db('shop'), replace: true` — once the application is stopped |
| one collection as it was, beside the live one | `restoreCollections(backups, id, { identities, db, collections: ['orders'], as: { orders: 'orders-before' } })` |
| some documents back | `restoreCollections(backups, id, { identities, db, collections: ['orders'], documents: { filter: { _id: id }, existing: 'keep' } })` — [restoring part of a backup](restore.md#restoring-part-of-a-backup) |

- **Pick the backup by time**: `backups.list()` gives each one's
  `createdAt`; an incremental holds the database as it was when it was
  made, its chain included.
- **Restore beside, then swap**: restoring into another database and
  checking it costs a little time and leaves the live data untouched until
  you are sure.
- **After a restore into the database you back up**, make a full backup:
  the next incremental may refuse what the restore moved in —
  [into the database you back up](restore.md#into-the-database-you-back-up).
