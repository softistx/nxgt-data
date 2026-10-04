# Locking

This page covers the single-writer lock `create` takes in every repository
it writes to: what it refuses, how long it lasts, what it leaves behind when
a process dies, and how to clear it by hand.

```ts
import {
	BackupError,
	bindBackup,
	defineBackup,
	directorySource,
	localRepository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	lock: { lease: 5 * 60 * 1000 }, // the default: 5 minutes, renewed every 100 s
});

try {
	await backups.create(directorySource({ path: '/srv/uploads' }));
} catch (error) {
	// Skipped only when nothing was stored and every repository was locked
	// elsewhere: any other failure, or a PARTIAL, is reported.
	const skipped =
		error instanceof BackupError &&
		error.code === 'NOT_STORED' &&
		error.outcomes.every(
			(outcome) =>
				!outcome.stored &&
				outcome.error instanceof BackupError &&
				outcome.error.code === 'LOCKED',
		);
	if (!skipped) throw error;
	console.warn('another run of "uploads" is still going; skipping this one');
}
```

There is nothing to turn on: from 0.4.0, every `create` takes the lock.
`lock.lease` only tunes it.

## What it guards

**Two `create`s of the same definition never write to the same repository at
once.** The second one is refused there with `LOCKED`, before it reads a
byte of its source for that repository. The lock is also what will keep
rotation — `prune`, next on the [roadmap](../roadmap.md) — from deleting a
backup that is still being written; the lock file already has room for it
(`operation: 'prune'`), and a `create` refuses a lock a `prune` holds.

What it does not guard:

- **Reads take no lock.** `list`, `verify` and `restore` run while a `create`
  does, and need no write permission. A backup being written has no manifest
  yet, so they do not see it.
- **Two definitions do not block each other**, even in one repository: the
  lock is per definition — `uploads/locks/`, `database/locks/`.
- **A lock is per repository.** With several repositories, a `create` takes
  one in each; a repository whose lock is held elsewhere fails alone, and the
  others go on — [several repositories](repositories.md#several-repositories).

## When it refuses, and when its lease runs out

Two codes come from the lock, and neither is ever what `create` rejects
with: each is one repository's **outcome**, inside the `PARTIAL` or
`NOT_STORED` that `create` rejects with, as any other repository failure is.
The other repositories go on.

| Code | Message | Means | Do |
| --- | --- | --- | --- |
| `LOCKED` | `create on "uploads": another create or prune holds the lock (repository "nas")` | another writer's live lock was there when this one looked. None of the backup was written to that repository; its own lock file was put, then removed | skip, and try later |
| `LEASE_LOST` | `create on "uploads": the lock's lease ran out before it was done (repository "local")` | this run held the lock, then could not renew it in time — the store out of reach for the lock's own writes, or the process paused longer than the lease. It started nothing more there; that repository has no manifest for this id, so it holds no backup | alert: retrying will not help until the store or the host is fixed |

Each `outcome.error` is a `BackupError` with that `code`, `backup` and
`repository`; a `LEASE_LOST` also has the `id` the backup would have had.
Match `LOCKED` alone when you mean "another run holds it":

```ts
import { BackupError, type RepositoryOutcome } from '@nxgt/backup';

/** The repositories `create` skipped because their lock was taken. */
export function lockedIn(error: unknown): string[] {
	if (!(error instanceof BackupError)) return [];
	return error.outcomes
		.filter(
			(outcome: RepositoryOutcome) =>
				!outcome.stored &&
				outcome.error instanceof BackupError &&
				outcome.error.code === 'LOCKED',
		)
		.map((outcome) => outcome.repository);
}
```

Objects put before a lease ran out stay, with no manifest: no call lists or
reads them — [a backup that failed left objects](../troubleshooting.md#a-backup-that-failed-left-objects-in-the-repository).

When **every** repository refuses at the start — `LOCKED`, or a failure
while taking the lock — `create` rejects with `NOT_STORED` and **never opens
the source**: a database dump is not started for nothing.

A repository that fails while taking the lock for another reason — the
bucket unreachable, `AccessDenied` on the lock's `PUT`, a listing of
`<backup>/locks/` that throws — fails with that error in its outcome, as a
failed object would, and **leaves no lock behind**: its own lock file is
removed even when the `put` that wrote it rejected after landing, so the
next run is not held off.

## How it works

For each repository, at the start of `create`:

1. **Write its own lock first**: `<backup>/locks/<lock-id>.json`.
2. **Then list `<backup>/locks/`**. Any other lock still live → delete its
   own, and refuse with `LOCKED`.
3. Otherwise, go on, and **renew** the lock every third of the lease by
   writing it again with a later `expiresAt`.
4. **Before every `put`** — each object, the catalog, the signature, the
   manifest — check that the lease is still held. Once it has run out, start
   nothing more in that repository, which fails with `LEASE_LOST`, and start
   no new renewal — though one already under way may still land, and the lock
   is deleted at the end. A `put` already under way when the lease runs out
   is not cut short, and may land after it.
5. At the end, success or failure, lease held or lost, **delete** the lock.
   A repository whose `delete` throws does not stop the run from ending.

**Why two writers never both go on.** Each one looks for others only after
its own lock is stored, and a repository's `list` shows a key as soon as its
`put` has resolved. So of two writers that start together, the later to
list sees the earlier's lock; at worst both see each other's and both give
up — never both go on. No conditional write is needed, so the same protocol
runs on any store that keeps the one promise it needs.

**The store must list a key as soon as its `put` resolved.** A local folder
does, and so does AWS S3; SeaweedFS's S3 gateway is covered by the package's
own spec. A store whose listing lags behind its writes — a listing served from a
cache, say — would let two writers in. Check yours
before relying on the lock; a repository you write yourself must keep that
promise — [the contract](repositories.md#writing-a-repository).

Both giving up is rare and harmless: run again.

## The lease

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `lock.lease` | `number`, milliseconds | `300000` (5 minutes) | how long a lock lasts unless renewed; it is renewed every third of it while `create` runs. Also how much longer another writer still respects a lock past its `expiresAt`, for clocks that disagree. A whole number from `1000` (1 second) to `86400000` (1 day) |

```ts
interface BindBackupOptions {
	// …repositories, recipients, tmpDir, signing, trusted
	lock?: { lease?: number | undefined } | undefined;
}
```

Anything else is a bare `TypeError` at bind time:

```ts
bindBackup(uploads, { repositories, recipients, lock: { lease: 500 } });
// TypeError: bindBackup: lock.lease must be a whole number of milliseconds, from 1 second to 1 day
```

**When a lock counts as live.** Another writer respects a lock until its
`expiresAt` **plus one lease** — its own `lock.lease` — read against its own
wall clock, and from then on treats it as stale: it ignores it, deletes it,
and goes on. The extra lease is room for the two hosts' clocks to disagree,
so keep them within a lease of each other (NTP does far better).

**When the holder lets go.** The holder does not read `expiresAt` back: it
measures its own deadline on a monotonic clock, from just before it wrote
the lock, and moves it on only when a renewal has landed. A wall clock
stepped back — by NTP, by hand — cannot stretch it, so the holder stops
before anyone else may take over.

**Choosing it:**

- **Longer** means a crashed run blocks the next one for longer: up to two
  leases.
- **Shorter** means more lock writes — one every third of a lease — and less
  room for a store that is briefly unreachable: a run whose renewals fail for
  a whole lease stops there with `LEASE_LOST`.
- A `put` already under way when the lease runs out is not cut short; the
  check is before each one. Keep the lease longer than your slowest single
  upload.
- **Give every binding of a definition the same lease**: a writer judges
  someone else's lock by its own.

The default suits a nightly job. Raise it for a link that drops for minutes
at a time; lower it in specs, as the package's own do (`lock: { lease: 1000 }`).

## What a lock file looks like

```text
/mnt/backups/
  uploads/
    locks/
      20261004T221500123Z-1a2b3c4d.json   ← one per running create
    20261003T221500123Z-9f3a61c0/
      …
```

```json
{"format":"nxgt-backup-lock/1","id":"20261004T221500123Z-1a2b3c4d","operation":"create","expiresAt":"2026-10-04T22:20:00.123Z"}
```

| Field | |
| --- | --- |
| `format` | `nxgt-backup-lock/1` |
| `id` | the lock's own id, shaped like a backup id, and its file name. Not the id of the backup being made |
| `operation` | `create`, or `prune` once rotation ships |
| `expiresAt` | when the lease ends unless renewed, as an ISO date, by the holder's clock |

**A lock file that does not read as one counts as held, forever**: an empty
file, one cut short, one of a later format. Nothing in it says when it ends,
and guessing wrong would let two writers in. Such a file must be removed by
hand. The `locks/` folder is otherwise left alone by `list`: it holds no
manifest. See the [format](format.md) for the rest of the layout.

## After a crash

A run that is killed — `SIGKILL`, the host lost, the container stopped —
cannot delete its lock. Nothing is damaged: the backup it was making has no
manifest, so it does not exist. But **that repository refuses every `create`
of the definition until the lock goes stale**: `expiresAt` plus one lease,
so at most two leases after the crash — 10 minutes with the default. The
first `create` after that deletes it and goes on.

To go on sooner, delete the lock yourself — **only once you are sure no
`create` of that definition is running**, or two writers will:

```sh
# a local folder
cat /mnt/backups/uploads/locks/*.json    # see what holds it, and until when
rm /mnt/backups/uploads/locks/20261004T221500123Z-1a2b3c4d.json

# an S3 bucket, with prefix 'nightly'
aws s3 ls s3://backups/nightly/uploads/locks/
aws s3 rm s3://backups/nightly/uploads/locks/20261004T221500123Z-1a2b3c4d.json
```

The same goes for a lock file that does not parse, which never goes stale.

## Scheduling

A cron job that fires while the last run is still going used to start a
second writer; from 0.4.0 the second one fails with `LOCKED` in every
repository and reads nothing. Treat that as "skip", not "alarm", unless it
keeps happening — then the job takes longer than its interval. A
`LEASE_LOST` is the opposite: this run lost its own lock, which is worth an
alert:

```ts
// backup.ts — run by cron every hour
import {
	BackupError,
	bindBackup,
	defineBackup,
	directorySource,
	localRepository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [
		localRepository({ path: '/mnt/backups', name: 'disk' }),
		localRepository({ path: '/mnt/nas/backups', name: 'nas' }),
	],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	tmpDir: '/var/tmp',
});

try {
	const { id } = await backups.create(directorySource({ path: '/srv/uploads' }));
	console.log(`backup ${id} stored in ${backups.repositories.join(', ')}`);
} catch (error) {
	if (!(error instanceof BackupError)) throw error;
	const failed = error.outcomes.filter((outcome) => !outcome.stored);
	const allLocked = failed.every(
		(outcome) =>
			outcome.error instanceof BackupError && outcome.error.code === 'LOCKED',
	);
	if (error.code === 'NOT_STORED' && allLocked) {
		console.warn('the previous run is still going: skipped');
		process.exit(0);
	}
	const leaseLost = failed.filter(
		(outcome) =>
			outcome.error instanceof BackupError && outcome.error.code === 'LEASE_LOST',
	);
	if (leaseLost.length > 0) {
		// the store dropped out for a whole lease, or the process was paused
		console.error('lease lost in', leaseLost.map((outcome) => outcome.repository));
	}
	console.error(error.message, failed.map((outcome) => outcome.repository));
	process.exit(2);
}
```

Next: [errors](errors.md), for `LOCKED` and `LEASE_LOST` beside the other
codes.
