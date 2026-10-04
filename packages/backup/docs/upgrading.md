# Upgrading

What to change in your code when you move `@nxgt/backup` from one minor to
the next. Each minor is a `0.x` release, so each can ask for something; the
[changelog](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/CHANGELOG.md)
has every change, and this page has only what you have to do.

## 0.3 → 0.4

Two things to change, at most: a `switch` on `BackupErrorCode` with an
exhaustive check, which needs the two new codes `LOCKED` and `LEASE_LOST`,
and anything that ran two `create`s of one definition at once on purpose.
0.4.0 adds a single-writer lock; a 0.3 backup reads as before, and readers
behave as before.

### Lock files appear in the repository

Every `create` now writes `<backup>/locks/<id>.json` in each repository at
its start, rewrites it while it runs, and deletes it when it ends. A 0.3
reader ignores the folder — it holds no manifest — and so does a tool that
looks for `*/manifest.json`. A `create` on S3 uses the permissions it already
had: `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `s3:DeleteObject`.
A `Repository` you wrote yourself must show a key in `list` as soon as its
`put` resolves, and now has `delete` called —
[the contract](guide/repositories.md#writing-a-repository).

### An overlapping run now fails `LOCKED`, a lost lock `LEASE_LOST`

A `create` started while another of the same definition is still writing to
a repository used to run beside it; now it is refused there, with a
`BackupError` of the new code `LOCKED` in that repository's `outcomes`, and
`create` rejects with `PARTIAL` or `NOT_STORED` as for any other repository
that failed. A cron job slower than its interval now skips a run instead of
doubling up — [scheduling](guide/locking.md#scheduling).

A run that holds the lock and cannot renew it in time — the store out of
reach for a whole lease, the process paused longer than one — stops there
with the other new code, `LEASE_LOST`, in that repository's `outcomes`.
Unlike `LOCKED`, it is worth an alert —
[locking](guide/locking.md#when-it-refuses-and-when-its-lease-runs-out).

`BackupErrorCode` has both new members, so a `switch` with an exhaustive
check stops compiling until it has both cases:

```ts
import { BackupError } from '@nxgt/backup';

function shouldAlert(error: unknown): boolean {
	if (!(error instanceof BackupError)) return false;
	switch (error.code) {
		case 'INTEGRITY':
		case 'DECRYPT':
		case 'NOT_FOUND':
		case 'SIGNATURE':
			return true;
		case 'PARTIAL':
		case 'NOT_STORED':
		case 'LOCKED': // 0.4.0: only ever in outcomes, never thrown by create itself
			return false;
		case 'LEASE_LOST': // 0.4.0: only ever in outcomes, too — but worth an alert there
			return true;
		default: {
			const unhandled: never = error.code;
			return unhandled;
		}
	}
}
```

A process that is killed mid-run leaves its lock behind: that repository
refuses the next `create` for up to two leases — 10 minutes by default —
then clears it on its own. To go sooner, or to clear a lock file that does
not parse, which never clears, delete it by hand —
[after a crash](guide/locking.md#after-a-crash).

### New: `lock: { lease }`

`bindBackup` takes `lock: { lease }`, in milliseconds: how long a lock lasts
unless renewed, 5 minutes by default, from 1 second to 1 day. Leave it out
unless a store drops for minutes at a time, or a spec wants a short one:

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	lock: { lease: 15 * 60 * 1000 }, // 0.4.0
});
```

### `list` no longer fails on a backup removed while it runs

A backup whose manifest is gone between `list`'s listing and its read of
that manifest — removed by hand, or by rotation once it ships — is now left
out. Before, `list` rejected with `NOT_FOUND`. Nothing to change.

## 0.2 → 0.3

Nothing breaks: 0.3.0 adds a repository and renames nothing, and a 0.2
backup reads as before.

### New: `s3Repository`

`s3Repository` and its `S3RepositoryOptions` keep backups in an S3 bucket,
AWS or compatible, through your own Bun `S3Client` — beside a local folder
or instead of it. Adding one to a binding you already have is one line:

```ts
import { S3Client } from 'bun';
import { bindBackup, defineBackup, localRepository, s3Repository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [
		localRepository({ path: '/mnt/backups' }),
		s3Repository({ client: new S3Client({ bucket: 'backups' }), prefix: 'nightly' }), // 0.3.0
	],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});
```

The backups already in the local folder stay there and read as before; the
bucket holds the ones made from now on. Before the first large backup, give
the bucket a lifecycle rule for abandoned multipart uploads —
[repositories](guide/repositories.md#abandoned-uploads-add-a-lifecycle-rule).

### An object is cut at its manifest's size

`verify` and `restore` now stop reading an object as soon as it runs past
the size its manifest gives, from any repository — yours included. Before,
the whole of what a repository sent was staged in `tmpDir`, then refused.
The error is the same, `INTEGRITY` with
`an object differs from its manifest`; only the bytes read before it, and
the room it takes in `tmpDir`, are smaller. Nothing to change.

## 0.1 → 0.2

Nothing breaks for callers: 0.2.0 adds signed manifests — the `signing` and
`trusted` options, `generateSigningKeys`, `Created.signed` and
`Verified.signatureChecked` — and renames nothing. Without `signing` or
`trusted`, every call behaves as in 0.1, and a 0.1 backup reads as before —
save one limit that is new in every mode, below. A literal of `Created` or
`Verified` you build yourself (a fake `BoundBackup` in a spec) needs the new
field. Then three things are worth doing.

### A manifest is now at most 64 MiB

0.2.0 reads no more than 64 MiB of a manifest — a repository is not trusted
with its size — and `create` refuses to write a larger one. That is about
half a million entries; a 0.1 backup with more is `INTEGRITY` to
`verify`/`restore` and `unreadable` to `list`, and a `create` that 0.1
finished now throws once its objects are stored. Split such a source into
several backups —
[the read](troubleshooting.md#verify-on-app-the-manifest-is-larger-than-64-mib-repository-local),
[the write](troubleshooting.md#create-on-app-the-manifest-would-be-larger-than-64-mib-split-the-source-into-several-backups).

### Handle the new `SIGNATURE` code

`BackupErrorCode` has a new member, `SIGNATURE`: a reader with `trusted`
keys found a manifest that is not signed, or not by one of them —
[signing](guide/signing.md#reading-list-verify-restore). A `switch` on
`error.code` gets a new case:

```ts
import { BackupError } from '@nxgt/backup';

function shouldAlert(error: unknown): boolean {
	if (!(error instanceof BackupError)) return false;
	switch (error.code) {
		case 'INTEGRITY':
		case 'DECRYPT':
		case 'NOT_FOUND':
		case 'SIGNATURE': // 0.2.0: not written by a key you trust
			return true;
		case 'PARTIAL':
		case 'NOT_STORED':
		case 'LOCKED': // from 0.4.0 — see 0.3 → 0.4
			return false;
		case 'LEASE_LOST': // from 0.4.0 — see 0.3 → 0.4
			return true;
		default: {
			const unhandled: never = error.code;
			return unhandled;
		}
	}
}
```

A switch with an exhaustive check like the `default` above stops compiling
on 0.2.0 until it has the `SIGNATURE` case — which is what it is for. One
without it compiles, and sends `SIGNATURE` wherever its fall-through goes.

### Sign, and give every reader `trusted`

Signing is off unless you turn it on, and a 0.1-style reader — no
`trusted` — still verifies and restores a whole consistent backup written by
anyone who can write to the repository. Make a key pair once, give the
private key to the host that runs `create`, and the public key to every
other:

```ts
import { bindBackup, defineBackup, generateSigningKeys, localRepository } from '@nxgt/backup';

const { privateKey, publicKey } = generateSigningKeys(); // once, then store both

const writer = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	signing: { key: privateKey }, // 0.2.0
});

const reader = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	trusted: [publicKey], // 0.2.0
});
```

[Signing](guide/signing.md) has the keys, `openssl`, and what each side
refuses.

### Backups made before signing was on

A reader with `trusted` keys refuses every backup without a signature, and
the backups made by 0.1 — or by 0.2 before `signing` was set — have none.
For that reader they leave `list`'s `backups` for its `unreadable`, and
`verify` and `restore` reject them with:

```text
restore on "uploads": the manifest is not signed (repository "local")
```

Nothing is signed after the fact. Pick one, per repository:

- **Keep a reader without `trusted`** — a separate `bindBackup` for restoring
  the old backups — until the last unsigned backup has expired, then drop
  it. That reader trusts whatever is in the repository, so use it only for
  ids made before the switch.
- **Re-make them**: run `create` with `signing` on, then remove the unsigned
  backups yourself — the package deletes nothing yet. A new backup holds the
  source as it is now, so this gives up the old points in time.

The writer itself is a reader too: with `signing` alone, its `list` and
`verify` check its own public key, so the old ids land in its `unreadable`
as well.
