# Rotation

This page covers `prune`, which keeps what a retention policy names in one
repository and removes the rest, and `hold` and `unhold`, the legal holds
`prune` always respects.

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const pruned = await backups.prune({ keep: { last: 7, daily: 14, weekly: 8 } });
// { repository: 'local', dryRun: false, kept: […], removed: […], incomplete: [], unreadable: [], overSize: false }

for (const decision of pruned.removed) {
	console.log('removed', decision.id, decision.reasons.join(', ')); // 'no rule keeps it'
}
```

`prune` reads manifests only, so it **needs no key**. It works on one
repository at a time — the first one, or `from` — and holds that
repository's [lock](locking.md) while it removes anything.

## The API

```ts
interface BoundBackup<Name extends string = string> {
	// …create, list, verify, restore
	prune(options: PruneOptions): Promise<Pruned>;
	hold(id: string, options?: HoldOptions): Promise<HoldResult>;
	unhold(id: string, options?: HoldOptions): Promise<HoldResult>;
}

interface PruneOptions {
	keep: KeepPolicy;
	from?: string | undefined;
	dryRun?: boolean | undefined;
	incompleteAfter?: number | undefined;
	now?: Date | undefined;
}

interface Pruned {
	repository: string;
	dryRun: boolean;
	kept: Decision[];        // newest first, each with the rules that keep it
	removed: Decision[];     // newest first, each with why it goes
	incomplete: string[];    // ids that never got a manifest, old enough to go
	unreadable: string[];    // ids whose manifest does not read: never removed
	overSize: boolean;       // keep.maxTotalSize is set, and what is kept is still over it
}

interface Decision {
	id: string;
	createdAt: Date;
	storedSize: number;      // the bytes the repository holds for it, manifest apart
	reasons: string[];
}

interface HoldOptions {
	from?: string | undefined; // one repository; every repository by default
}

interface HoldResult {
	id: string;
	repositories: string[];  // where the hold was put, or lifted
}
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `keep` | `KeepPolicy` | required | what to keep; everything else goes. At least one rule — [the rules](#the-rules) |
| `from` | `string` | the first repository | the repository to prune, by name. A name `bindBackup` was not given rejects with a `TypeError` |
| `dryRun` | `boolean` | `false` | plan, report, and remove nothing. Takes no lock — [dry run first](#dry-run-first) |
| `incompleteAfter` | `number`, milliseconds | `86400000` (1 day) | how old a backup with no manifest must be before it is removed, counted from when its `create` **started**, by this machine's clock — not by `now`. Longer than your longest `create` plus two lock leases; a whole number, and at least two leases — [incomplete backups](#incomplete-backups) |
| `now` | `Date` | the current time | the moment the policy is applied at: what the rules, `within` and *newer than now* measure from — not `incompleteAfter`. A valid `Date`, or a `TypeError`. For specs, and for asking "what would go next week" with `dryRun` |

## The rules

```ts
interface KeepPolicy {
	last?: number | undefined;
	hourly?: number | undefined;
	daily?: number | undefined;
	weekly?: number | undefined;
	monthly?: number | undefined;
	yearly?: number | undefined;
	within?: number | undefined;       // milliseconds
	maxTotalSize?: number | undefined; // bytes
}
```

**Rules add up: a backup any rule keeps is kept.** Each value is a whole
number, 1 or more; a rule left out does nothing. A backup no rule keeps is
removed with the reason `no rule keeps it`.

The rules look only at backups made **at or before `now`**. One newer than
`now` is kept as `newer than now`, and nothing else: it takes no place in
`last`, in a calendar rule, nor in the size floor, so a backup stamped in the
future by a wrong clock never pushes a real one out.

| Rule | Keeps | Reason it gives |
| --- | --- | --- |
| `last: n` | the `n` newest backups | `last 1 of 3`, `last 2 of 3`, … |
| `hourly: n` | the newest backup of each of the `n` most recent UTC hours that have one | `hourly 2026-10-04T11` |
| `daily: n` | the same, per UTC day | `daily 2026-10-03` |
| `weekly: n` | the same, per ISO week, Monday first, in UTC | `weekly 2026-W40` |
| `monthly: n` | the same, per UTC month | `monthly 2026-10` |
| `yearly: n` | the same, per UTC year | `yearly 2026` |
| `within: ms` | every backup whose `createdAt` is at most `ms` before `now`, and not after it — exactly `ms` old is kept, a millisecond older is not | `within` |
| `maxTotalSize: bytes` | without `last`, the newest backup; then removes the oldest kept backups until the rest fit — [below](#maxtotalsize) | `the newest, under maxTotalSize`; `over maxTotalSize` on what it removes |

A calendar rule counts **periods that have a backup**, not periods on the
calendar: `daily: 7` keeps the newest backup of each of the seven most recent
days a backup was made on, however far back those days go. A week with no
backup does not use up one of `weekly: 8`.

Every period is read in **UTC**. A nightly job at 00:30 in Paris (22:30 UTC
in summer) makes its backup on the previous UTC day; the policy still keeps
one per day, but the day it names is the UTC one.

ISO weeks belong to the year of their Thursday: `2024-12-30`, a Monday, is in
`2025-W01`, and `2027-01-01` is in `2026-W53`.

What the rules keep, whatever they say:

| Reason | When |
| --- | --- |
| `held` | the backup has a [legal hold](#legal-holds) in that repository |
| `newer than now` | its `createdAt` is after `now` — a clock that disagrees, or `now` given in the past. Its only reason: no rule counts it |
| `parent of <id>` | a kept backup builds on it — or an unreadable one, which `prune` never removes — [chains](#chains) |

A backup can have several reasons; all are listed, rules first:

```ts
// keep: { last: 1, hourly: 2, monthly: 2, yearly: 2, within: 6 * 3_600_000 }, at 2026-10-04T12:00Z
[
	{ id: '…', reasons: ['last 1 of 1', 'hourly 2026-10-04T11', 'monthly 2026-10', 'yearly 2026', 'within'] }, // 11:00
	{ id: '…', reasons: ['hourly 2026-10-04T08', 'within'] },                                               // 08:00
	{ id: '…', reasons: ['monthly 2026-09'] },                                                              // 15 September
	{ id: '…', reasons: ['yearly 2025'] },                                                                  // June 2025
]
```

### `maxTotalSize`

`maxTotalSize` caps the bytes kept, counted from each backup's
`storedSize` — its objects and catalog, manifest apart. Once the other rules
have decided, it removes the **oldest** kept backups, one at a time, until
the rest fit. It never removes:

- **the floor** — the newest `last` backups made at or before `now`, or,
  when `last` is not set, the newest one, which it keeps itself with the
  reason `the newest, under maxTotalSize` — so `keep: { maxTotalSize }` alone
  keeps at least the latest backup;
- a **held** backup;
- a backup **newer than `now`**;
- a backup a kept one **builds on**.

After each removal it looks again: a backup kept only as the parent of one
it just removed is no longer needed, and may go in turn — with
`over maxTotalSize` if a rule had kept it, `no rule keeps it` otherwise.

It may stop while still over: then `overSize` is `true`, and nothing tells
you but that flag.

```ts
const pruned = await backups.prune({
	keep: { last: 2, daily: 30, maxTotalSize: 50 * 1024 ** 3 }, // 50 GiB
});
if (pruned.overSize) {
	const total = pruned.kept.reduce((sum, d) => sum + d.storedSize, 0);
	console.warn(`still ${total} bytes kept: the floor, the holds and their parents do not fit`);
}
```

## A typical policy

A nightly job: back up, then prune. Seven backups whatever their age, one a
day for two weeks, one a week for two months, one a month for a year, and
one a year for three.

```ts
// nightly.ts — run by cron once a night
import {
	bindBackup,
	defineBackup,
	directorySource,
	localRepository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	tmpDir: '/var/tmp',
});

const created = await backups.create(directorySource({ path: '/srv/uploads' }));
await backups.verify(created.id);

const pruned = await backups.prune({
	keep: { last: 7, daily: 14, weekly: 8, monthly: 12, yearly: 3 },
});
console.log(
	`backup ${created.id}; kept ${pruned.kept.length}, removed ${pruned.removed.length}` +
		`, cleaned ${pruned.incomplete.length} incomplete`,
);
if (pruned.unreadable.length > 0) {
	console.warn('manifests that do not read, left in place:', pruned.unreadable);
}
```

Prune **after** the backup has landed and been verified: a run whose
`create` threw stops before it removes anything.

## Dry run first

Run the policy with `dryRun: true` before the first real prune, and after
every change to it. It reads exactly what a real run reads and removes
nothing:

```ts
const plan = await backups.prune({
	keep: { last: 7, daily: 14, weekly: 8, monthly: 12, yearly: 3 },
	dryRun: true,
});

for (const decision of plan.kept) {
	console.log('keep  ', decision.id, decision.reasons.join(', '));
}
for (const decision of plan.removed) {
	console.log('remove', decision.id, decision.reasons.join(', '));
}
console.log('incomplete', plan.incomplete, 'unreadable', plan.unreadable);
```

```text
keep   20261004T221500123Z-9f3a61c0 last 1 of 7, daily 2026-10-04, weekly 2026-W40, monthly 2026-10, yearly 2026
keep   20261003T221500087Z-03be44d1 last 2 of 7, daily 2026-10-03
…
remove 20260611T221500342Z-77ac1e09 no rule keeps it
```

A dry run **takes no lock**: it runs beside a `create`, and needs only read
access. So its plan is what the repository held when it looked — a `create`
that finishes, or a `hold` put, before the real run changes it. Read the real
run's own `kept` and `removed`, not the dry run's.

`now` lets a dry run look ahead:

```ts
const nextWeek = new Date(Date.now() + 7 * 86_400_000);
const later = await backups.prune({ keep: { daily: 14 }, dryRun: true, now: nextWeek });
```

## A policy per repository

`prune` works on one repository; call it once per repository, each with its
own policy. A short one on the fast local disk, a long one in the bucket:

```ts
import { S3Client } from 'bun';
import {
	bindBackup,
	defineBackup,
	directorySource,
	localRepository,
	s3Repository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [
		localRepository({ path: '/mnt/backups' }), // named 'local'
		s3Repository({ client: new S3Client({ bucket: 'backups' }), prefix: 'nightly' }), // named 's3'
	],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

await backups.create(directorySource({ path: '/srv/uploads' }));

await backups.prune({ from: 'local', keep: { last: 3, daily: 7 } });
await backups.prune({
	from: 's3',
	keep: { last: 7, daily: 30, weekly: 12, monthly: 24, yearly: 7 },
});
```

Each repository decides on what it holds. A backup `PARTIAL` left out of one
repository is simply not there to keep; the two lists can differ.

## Legal holds

A hold keeps one backup whatever the policy says, until it is lifted. By
default `hold` and `unhold` act in **every repository**; `from` picks one:

```ts
const held = await backups.hold('20260611T221500342Z-77ac1e09');
// { id: '20260611T221500342Z-77ac1e09', repositories: ['local', 's3'] }

const { backups: listed } = await backups.list({ from: 's3' });
// [{ id: '20260611T221500342Z-77ac1e09', …, held: true }, …]

await backups.unhold('20260611T221500342Z-77ac1e09', { from: 's3' });
// { id: '20260611T221500342Z-77ac1e09', repositories: ['s3'] } — still held in 'local'
```

- **A hold lives in each repository.** `hold` puts it in every repository
  that has the backup and **skips** those that do not — a repository a
  `PARTIAL` left out, say; `repositories` in the result says where it
  landed. It rejects with `NOT_FOUND` only when **none** has the backup:
  `hold on "uploads": no repository holds that backup`.
- **`hold` reads the manifest first**, as `verify` does: a backup whose
  manifest does not read rejects with `INTEGRITY`, one no `trusted` key
  signed with `SIGNATURE`.
- **Each repository's lock is taken in turn**, so a hold cannot land between
  a prune's reading of the holds and its deletes. **A hold waits for no
  one**: a `create` or a `prune` running there refuses it with `LOCKED` —
  `hold on "uploads": another create, prune or hold has the lock (repository "local")`,
  `unhold on "uploads": …` for `unhold`. Retry once it ends. The lease is checked
  before the hold is written or deleted, so `LEASE_LOST` can come from either
  too.
- **A refusal stops there.** The repositories before it keep what was done;
  run the call again — holding twice is not an error.
- **`unhold` is idempotent**: it deletes the hold in every repository asked,
  and lifting one that is not there — or on a backup that is gone — is not
  an error. `repositories` lists every repository it went through.
- `list` reports a hold as `held: true` on each `BackupInfo`, and `prune`
  keeps the backup with the reason `held`. `maxTotalSize` never removes it.

A hold is a small file, `<backup>/holds/<id>.json` — [format](format.md#holds).
It protects against `prune`, not against someone who can delete from the
repository.

## Incomplete backups

A `create` that stopped — a source that threw, a process killed, a lease
that ran out, a repository left out of a `PARTIAL` — leaves objects under
`<backup>/<id>/` and no manifest. No call sees them. `prune` removes them,
and lists their ids in `incomplete`, once they are older than
`incompleteAfter`. The age counts from when the `create` **started** — the
time in the id — by this machine's own clock: `now` does not move it.

```ts
const pruned = await backups.prune({
	keep: { last: 7 },
	incompleteAfter: 6 * 60 * 60 * 1000, // 6 hours
});
// pruned.incomplete: ['20261002T221500123Z-1a2b3c4d']
```

**Why wait.** A backup still being written has no manifest either, and its
id dates from its start. So the wait must be longer than **your longest
`create` plus two lock leases**: a `put` already under way when its run's
lease ran out may still land after, and another writer respects a lock until
one lease past its end. Under two leases is refused outright; a wait shorter
than your longest `create` is not caught, and would remove a backup still
being written:

```ts
await backups.prune({ keep: { last: 7 }, incompleteAfter: 1000 });
// TypeError: prune on "uploads": incompleteAfter must be a whole number of milliseconds, two lock leases at least
```

The default, a day, suits a nightly job that takes well under a day, with
the default 5-minute lease. A
`lock.lease` over 12 hours needs `incompleteAfter` given explicitly, since a
day is then less than two leases. Only folders named like a backup id are
considered; `locks/` and `holds/` never are.

## What is never removed

- **A backup whose manifest does not read** goes to `unreadable` and stays —
  damaged, edited, of a later format, or, for a binding with `trusted` keys,
  not signed by one of them. Run `verify` on it for the reason. A binding
  with `trusted` therefore never removes the unsigned backups made before
  signing was on; prune those from a binding without `trusted`, which reads
  them — [upgrading](../upgrading.md#backups-made-before-signing-was-on).
- **A held backup**, and **a backup newer than `now`**.
- **A backup a kept backup builds on.**
- Anything outside `<backup>/`: other definitions in the same repository are
  untouched.

## How it removes

For each backup that goes, `prune` deletes **its manifest first**, then every
other key under its id. The backup stops existing at the first delete — no
call lists it, `verify` and `restore` answer `NOT_FOUND` — before any of its
objects goes. A prune cut short part-way, by a crash or a lost lease, leaves
no half backup: only objects with no manifest, which the next `prune` removes
as `incomplete` once their id is older than `incompleteAfter` — usually at
once, since the id is as old as the backup was.

With `localRepository`, a delete also removes the folders it leaves empty,
up to the repository's root, so a removed backup leaves no folder behind.

## The lock, and `LEASE_LOST`

A real run takes the repository's [lock](locking.md) (`operation: 'prune'`)
before it reads anything, holds it while it plans and removes, renews it
every third of the lease, and releases it at the end. `hold` and `unhold`
take the same lock, one repository at a time, and their lock file records
`operation: 'prune'` too. Unlike `create`, which reports a lock problem in
one repository's outcome, these **reject** with it:

| Code | Message | Do |
| --- | --- | --- |
| `LOCKED` | `prune on "uploads": another create, prune or hold has the lock (repository "local")` — `hold on …`, `unhold on …` alike | nothing was read or removed there. Skip, and prune after the next backup; retry a hold once the run ends |
| `LEASE_LOST` | `prune on "uploads": the lock's lease ran out before it was done (repository "local")` — `hold on …`, `unhold on …` alike | the lease is checked before every delete, and before a hold is written or lifted; it ran out, so the prune stopped. What it removed is gone; the rest stays, with at worst a backup left without its manifest, cleaned up next time. `error.id` is the backup it was removing. Find out why the store dropped out or the process stalled |

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.prune({ keep: { last: 7, daily: 14 } });
} catch (error) {
	if (error instanceof BackupError && error.code === 'LOCKED') {
		console.warn('a backup is running: prune skipped');
	} else {
		throw error;
	}
}
```

A `create` started while a `prune` holds the lock fails `LOCKED` in that
repository, so a prune never removes a backup still being made, and never
races another prune.

## Chains

An [incremental or differential](chains.md) backup points to entries stored
in older backups, so it restores only while each backup it builds on is
there. `prune` reads each manifest's `parent` and keeps a kept backup's
parent, that parent's own, down to the full backup, each with the reason
`parent of <id>` — whether the child was kept by a rule, a hold, or as a
parent itself. A backup whose manifest does not read — damaged, or not
signed by a `trusted` key — stays in `unreadable`, in neither `kept` nor
`removed`, and is never removed; its parent is still kept, with
`parent of <id>`: `prune` reads the `parent` field from the manifest's raw
JSON, as best it can, so a damaged incremental does not cost its chain.
Nothing else keeps a backup alive: one no kept backup builds
on is kept or removed by the rules alone.

```ts
// keep: { last: 1 }, with a full backup on Sunday and an incremental on Monday
const pruned = await backups.prune({ keep: { last: 1 } });
// pruned.kept:
// [
//   { id: '<monday>', reasons: ['last 1 of 1'], … },
//   { id: '<sunday>', reasons: ['parent of <monday>'], … },
// ]
```

So a policy that keeps the last seven days keeps, with daily incrementals,
up to the full backup each of them builds on — `daily: 7` can keep thirteen
backups. `maxTotalSize` never removes a parent a kept backup needs either,
which can leave it [over](#maxtotalsize). A weekly full backup bounds what a
chain holds on to.

**Every process that prunes must be 0.6 or later before the first
incremental is made.** A 0.5 `prune` cannot read an incremental or
differential manifest: it puts the backup in `unreadable` and never removes
it — but, unlike 0.6, it does not look for its `parent`, so it does not
keep the full backup it builds on, and may remove it. The incremental then fails to restore with
`a backup it builds on is missing` —
[upgrading](../upgrading.md#05--06).

## What it needs

| Run | Needs |
| --- | --- |
| `prune`, `hold`, `unhold` | write access: on S3, `s3:GetObject`, `s3:ListBucket`, `s3:PutObject` (the lock, the hold) and `s3:DeleteObject` — [the credentials](repositories.md#what-the-credentials-need) |
| `prune` with `dryRun` | read access: `s3:GetObject`, `s3:ListBucket` |

No age identity, in either case. A real `prune`, `hold` and `unhold` also
need a writable `tmpDir`, as `create` does: the lock and hold files are
staged there. A binding with `trusted` keys checks each
manifest's signature as `list` does.

## Errors

| Thrown | When |
| --- | --- |
| `TypeError: prune on "uploads": keep must name at least one rule` | `keep` is missing, not an object, or names no rule |
| `TypeError: prune on "uploads": keep.daily must be a whole number, 1 or more` | a rule that is `0`, negative, fractional or `NaN`; the message names the rule |
| `TypeError: prune on "uploads": incompleteAfter must be a whole number of milliseconds, two lock leases at least` | [above](#incomplete-backups) |
| `TypeError: prune on "uploads": now must be a valid Date` | `now` is not a `Date`, or is an Invalid Date — `new Date('tomorrow')` |
| `TypeError: prune on "uploads": no repository has that name` | `from` names no repository; `hold on …` and `unhold on …` alike |
| `TypeError: hold on "uploads": the id is not a backup id` | `hold` or `unhold` (`unhold on …`) given something else |
| `BackupError` `LOCKED`, `LEASE_LOST` | `prune`, `hold`, `unhold` — [above](#the-lock-and-lease_lost) |
| `BackupError` `NOT_FOUND`: `hold on "uploads": no repository holds that backup` | `hold` only, when no repository asked has the backup; `id` is set, `repository` is not |
| `BackupError` `INTEGRITY`, `SIGNATURE` | `hold` only: the backup's manifest does not read in a repository |

All are rejections: the calls are `async`. The `TypeError`s come before
anything is read. An error from the repository itself — a `list`, `get` or
`delete` that throws, `AccessDenied` — passes through as it is; the lock is
released. Every message is in [troubleshooting](../troubleshooting.md#pruning).

Next: [locking](locking.md), for the lock `prune` and `hold` share with
`create`; [errors](errors.md), for every code.
