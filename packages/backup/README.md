# @nxgt/backup

Encrypted, verifiable backups on **Bun**. Each entry a source gives — a file,
a database dump — is compressed with **zstd**, then encrypted with
**[age](https://age-encryption.org)** to one or more public keys, and stored
in one or several repositories at once — a local folder, an S3 bucket:

- the backup host needs **only public keys** for a full backup; the secret
  key is needed to restore, and to build an incremental one;
- a clear **manifest**, written **last**, pins the size and SHA-256 of every
  stored object, so `list` and `verify` run without a key, and a backup
  exists once — and only once — its manifest does;
- a restore checks each object against the manifest **before decrypting a
  byte**, and each entry's bytes against what the source gave as they go;
- with a **signing key**, each manifest carries an **Ed25519 signature**, and
  a reader given the public key refuses a backup it did not write;
- **incremental and differential** backups store only what changed, and
  each one still restores whole, with no replay;
- the format is age's and zstd's: a backup opens without this package.

```ts
import {
	bindBackup,
	defineBackup,
	directorySource,
	directoryTarget,
	localRepository,
} from '@nxgt/backup';

const uploads = defineBackup({ name: 'uploads' });

const backups = bindBackup(uploads, {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string], // age1… — a public key
});

const created = await backups.create(directorySource({ path: '/srv/uploads' }));
// { id: '20261003T221500123Z-9f3a61c0', entries: 1204, size: …, storedSize: …, outcomes: […] }

await backups.verify(created.id); // no key needed

await backups.restore(created.id, directoryTarget({ path: '/srv/restore' }), {
	identities: [process.env.BACKUP_IDENTITY as string], // AGE-SECRET-KEY-1…
});
```

> **0.x.** Full, incremental and differential backups, local and S3
> repositories, checked restores, signed manifests, a single-writer lock and
> rotation are here; a MongoDB source is next — see the
> [roadmap](docs/roadmap.md).

## Install

```sh
bun add @nxgt/backup
bun add -d @types/bun typescript
```

- **Bun 1.4 or later, and Bun only.** zstd is Bun's own
  `CompressionStream('zstd')`, hashing is `Bun.CryptoHasher`, and files are
  read with `Bun.file`. On Node, `defineBackup` and `bindBackup` load, and
  the first `create` rejects with `ReferenceError: Bun is not defined`.
- `typescript` `^6.0.3`: required peer, the version every `@nxgt` package
  pins.
- `age-encryption` `~0.3.1` is a **dependency**, installed with it — the
  TypeScript age implementation by Filippo Valsorda, BSD-3-Clause. You never
  hand it an age object, only key strings.
- It depends on no other `@nxgt` package.

## Keys

A backup is encrypted to **recipients** (public keys, `age1…`) and opened
with **identities** (secret keys, `AGE-SECRET-KEY-1…`). Make a pair once,
with the `age-keygen` command or in code:

```ts
// bun add age-encryption — only to generate keys yourself
import { generateIdentity, identityToRecipient } from 'age-encryption';

const identity = await generateIdentity(); // AGE-SECRET-KEY-1… — keep it offline
const recipient = await identityToRecipient(identity); // age1… — give it to the backup host
```

The host that makes backups holds `recipient` only; whoever restores holds
`identity`. Hybrid post-quantum keys (`generateHybridIdentity()`, `age1pq1…`)
work the same way — [encryption](docs/guide/encryption.md).

## Back up

```ts
import { bindBackup, defineBackup, directorySource, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	tmpDir: '/var/tmp', // where each object is staged; the system's temp folder by default
});

const { id, entries, size, storedSize } = await backups.create(
	directorySource({ path: '/srv/uploads' }),
);
```

`create` reads the entries one at a time, never holding more than a chunk in
memory, and writes `/mnt/backups/uploads/<id>/0.age`, `1.age`, …,
`catalog.age`, and `manifest.json` last — with `manifest.sig` just before
it when [signing](#signed-manifests). The
[format](docs/guide/format.md) page has the layout.

## List and verify

```ts
const { backups: listed, unreadable } = await backups.list();
// listed: [{ id, createdAt, kind: 'full', parent: null, entries, storedSize, held }, …], oldest first

const latest = listed.at(-1);
if (latest) {
	await backups.verify(latest.id); // every object's size and SHA-256, no key
	await backups.verify(latest.id, {
		identities: [process.env.BACKUP_IDENTITY as string], // and every entry, decrypted
	});
}
```

`list` reads manifests alone. A backup whose manifest was never written — one
still running, one that failed — is not listed; one whose manifest does not
read, or that no `trusted` key signed, is in `unreadable`, and `verify` on it
says why.

## Restore

```ts
import { directoryTarget } from '@nxgt/backup';

const restored = await backups.restore(
	id,
	directoryTarget({ path: '/srv/restore' }),
	{
		identities: [process.env.BACKUP_IDENTITY as string],
		only: (name) => name.startsWith('avatars/'), // or a list of names; all by default
	},
);
// { id, repository: 'local', entries: ['avatars/1.png', …], size }
```

Each object is copied to `tmpDir` and checked against the manifest before age
reads it; each entry's bytes are checked against the catalog as they stream,
and a damaged one fails with `INTEGRITY` — `directoryTarget` lands nothing
from it.

## Chains

```ts
import { bindBackup, defineBackup, directorySource, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});
const identities = [(await Bun.file('/etc/backup/identity.txt').text()).trim()]; // chmod 600
const source = directorySource({ path: '/srv/uploads' });

const full = await backups.create(source); // Sunday
const next = await backups.create(source, { kind: 'incremental', identities }); // every other day
// { kind: 'incremental', parent: full.id, entries: 1204, reused: 1187, storedSize: …, … }

await backups.verify(next.id); // { chain: [next.id, full.id], … } — every object of both, no key
```

An `incremental` backup builds on the newest backup, a `differential` one on
the newest full one — chosen in `from` (by default the first repository
still in the run), under the lock, with its whole chain there and the same
recipients. It stores only the entries that changed and points to the
others where they are already stored, so `restore` and `verify` of any
backup give its whole view, with no replay, and a removed file is simply
absent. An entry whose source `fingerprint` is the recorded one is not even
read — `directorySource` gives `size:mtimeNs:ctimeNs:ino` — and one whose
bytes are the recorded ones is not stored again. It needs `identities`, to
read what the parent recorded: the host that makes it holds a secret key.
`prune` keeps every parent a kept backup needs —
[chains](docs/guide/chains.md).

## Signed manifests

```ts
import { bindBackup, defineBackup, directorySource, localRepository } from '@nxgt/backup';

const uploads = defineBackup({ name: 'uploads' });
const repositories = [localRepository({ path: '/mnt/backups' })] as const;
const recipients = [process.env.BACKUP_RECIPIENT as string] as const;

// Where backups are made: the private key, PEM (PKCS#8).
const writer = bindBackup(uploads, {
	repositories,
	recipients,
	signing: { key: await Bun.file('/etc/backup/signing.pem').text() },
});
const { id, signed } = await writer.create(directorySource({ path: '/srv/uploads' }));
// signed: true — manifest.sig was put just before manifest.json

// Everywhere else: the public key only, PEM (SPKI).
const reader = bindBackup(uploads, {
	repositories,
	recipients,
	trusted: [await Bun.file('/etc/backup/signing.pub.pem').text()],
});
const { signatureChecked } = await reader.verify(id); // true
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `signing` | `{ key: string }` | none | an Ed25519 private key. `create` signs the exact bytes of each manifest into `manifest.sig` |
| `trusted` | `[string, ...string[]]` | the public half of `signing.key`; none without `signing` | Ed25519 public keys. `list`, `verify` and `restore` refuse a manifest none of them signed — `SIGNATURE`, or an id in `unreadable` — before reading anything else |

`generateSigningKeys()` makes a pair, `{ privateKey, publicKey }`, as PEM;
`openssl genpkey -algorithm ed25519` makes the same. Several `trusted` keys
let the signing key change without a backup becoming unreadable. The
signature proves who wrote a backup; it hides nothing, and it does not stop
someone with write access from deleting backups —
[signing](docs/guide/signing.md).

## Several repositories

```ts
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
});

try {
	const { id } = await backups.create(directorySource({ path: '/srv/uploads' }));
	await backups.verify(id, { from: 'nas' }); // reads use the first one unless told
} catch (error) {
	if (error instanceof BackupError && error.code === 'PARTIAL') {
		// error.outcomes: [{ repository: 'disk', stored: true },
		//                  { repository: 'nas', stored: false, error }]
		console.warn(error.message, error.outcomes);
	} else {
		throw error;
	}
}
```

Each object goes to every repository still in the run; one that fails is
left out from then on, and the manifest goes only where everything landed —
[repositories](docs/guide/repositories.md).

## Keep backups in S3

```ts
import { S3Client } from 'bun';
import {
	bindBackup,
	defineBackup,
	directorySource,
	localRepository,
	s3Repository,
} from '@nxgt/backup';

// Your own client: the credentials stay with you.
const client = new S3Client({
	bucket: 'backups',
	endpoint: process.env.S3_ENDPOINT as string, // leave it out for AWS
	accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
	secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
});

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [
		localRepository({ path: '/mnt/backups' }), // named 'local'
		s3Repository({ client, prefix: 'nightly' }), // named 's3'
	],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const { id, outcomes } = await backups.create(directorySource({ path: '/srv/uploads' }));
// outcomes: [{ repository: 'local', stored: true }, { repository: 's3', stored: true }]
await backups.verify(id, { from: 's3' });
```

Up to 64 MiB an object goes in one `PUT`, which S3 shows whole or not at
all; a larger one is streamed from disk in parts of `partSize` (16 MiB by
default, 5 MiB at least). Every write reads the stored size back before it
counts, so a bucket that did not keep an object fails that repository's
outcome at backup time. The writer needs `s3:PutObject`, `s3:GetObject`,
`s3:ListBucket` and `s3:DeleteObject`; a reader, `s3:GetObject` and
`s3:ListBucket` — [repositories](docs/guide/repositories.md#s3repository).

## Concurrent runs: the lock

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
	lock: { lease: 5 * 60 * 1000 }, // the default; renewed every third of it
});

try {
	await backups.create(directorySource({ path: '/srv/uploads' }));
} catch (error) {
	if (!(error instanceof BackupError)) throw error;
	// LOCKED is a repository's outcome, inside PARTIAL or NOT_STORED.
	const locked = error.outcomes.filter(
		(outcome) =>
			!outcome.stored &&
			outcome.error instanceof BackupError &&
			outcome.error.code === 'LOCKED',
	);
	if (error.code === 'NOT_STORED' && locked.length === error.outcomes.length) {
		console.warn('the previous run is still going: skipped');
	} else {
		throw error;
	}
}
```

Every `create` takes a lock in each repository it writes to —
`<backup>/locks/<id>.json`, written before it looks for others, renewed
while it runs, deleted when it ends — so two runs of one definition never
write to one repository at once. A repository whose lock is held elsewhere
fails alone with `LOCKED`, and the others go on; when all of them refuse,
the source is not opened. A run that cannot renew its own lock in time
starts nothing more in that repository, which fails with `LEASE_LOST` —
worth an alert, unlike `LOCKED`. `prune`, `hold` and `unhold` take the same
lock; `list`, `verify`, `restore` and a dry-run `prune` take none —
[locking](docs/guide/locking.md).

## Rotation

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const keep = { last: 7, daily: 14, weekly: 8, monthly: 12, yearly: 3 };

// What would go, and why — nothing removed, no lock taken.
const plan = await backups.prune({ keep, dryRun: true });
for (const d of plan.removed) console.log('would remove', d.id, d.reasons); // ['no rule keeps it']

// Then for real, under the lock.
const pruned = await backups.prune({ keep });
// { repository: 'local', dryRun: false, kept, removed, incomplete, unreadable, overSize }

// A legal hold, in every repository: prune keeps it whatever the policy says, until unhold.
await backups.hold('20260611T221500342Z-77ac1e09'); // { id, repositories: ['local'] }
```

`prune` works on one repository — the first, or `from` — so each can have
its own policy. Rules add up; each kept backup lists the rules that keep it
(`last 1 of 7`, `daily 2026-10-03`, `held`, …). It reads manifests only, so
it needs no key; it removes a backup's manifest first, so a cut prune leaves
no half backup; and it also removes what failed runs left without a
manifest, once older than `incompleteAfter` (a day). A backup whose manifest
does not read is never removed — [rotation](docs/guide/rotation.md).

## Your own source, target or repository

A source is a `kind` and an async iterable of `{ name, open }` — plus, for
incremental backups, an optional `fingerprint` per entry and a `position()`:

```ts
import type { BackupSource } from '@nxgt/backup';

const settings: BackupSource = {
	kind: 'settings',
	async *entries() {
		yield {
			name: 'settings.json',
			open: async () => {
				const response = await fetch('http://localhost:3000/admin/settings');
				if (!response.ok) throw new Error(`settings: ${response.status}`);
				return response.body as ReadableStream<Uint8Array>;
			},
		};
	},
};
```

`RestoreTarget` and `Repository` are as small —
[sources and targets](docs/guide/sources-and-targets.md),
[a source with fingerprints and a position](docs/guide/chains.md#writing-a-source-with-fingerprints-and-a-position),
[repositories](docs/guide/repositories.md#writing-a-repository).

## API

| Function | |
| --- | --- |
| `defineBackup({ name })` | describes a backup; touches nothing. Frozen. A name that could not be a path segment is a bare `TypeError` |
| `bindBackup(definition, { repositories, recipients, tmpDir?, signing?, trusted?, lock? })` | binds it to where it is kept, who can read it, and who signs it. `lock: { lease }` is the lock's lease in milliseconds: 5 minutes by default, 1 second to 1 day. No I/O; a list, a key or a lease that could never work is a bare `TypeError` |
| `generateSigningKeys()` | a new Ed25519 key pair for `signing` and `trusted`: `{ privateKey, publicKey }`, PEM |
| `localRepository({ path, name? })` | a repository in a local folder — a disk, a mounted volume, a share. `name` is `local` by default |
| `s3Repository({ client, prefix?, name?, partSize? })` | a repository in an S3 bucket, AWS or compatible, through your own Bun `S3Client`. `name` is `s3` by default; `partSize` 16 MiB, 5 MiB at least. A `prefix` or `partSize` that could never work is a bare `TypeError` |
| `directorySource({ path })` | every regular file under a folder, by relative path, sorted, each with a fingerprint, `size:mtimeNs:ctimeNs:ino` — none for a file changed in the last two seconds, which the next backup reads again. Symbolic links and empty folders are skipped |
| `directoryTarget({ path, overwrite? })` | writes each entry to a file under a folder. Refuses an unsafe name, and an existing file unless `overwrite: true` |

| `BoundBackup<Name>` | |
| --- | --- |
| `definition`, `repositories` | the definition, and the repository names in the order given |
| `create(source, { kind?, identities?, from? })` | takes the lock in every repository, reads every entry and stores a backup in each: a full one by default; with `kind: 'incremental'` or `'differential'` and `identities`, one that stores only what changed since the newest backup, or the newest full one, found in `from` — `NOT_FOUND` when there is none, and a repository lacking it is left out with a `NOT_FOUND` outcome. Resolves to `Created` — `kind`, `parent`, `entries` (its whole view), `reused` (the entries pointing to an older backup) — once each holds it; rejects with `PARTIAL` or `NOT_STORED` otherwise — a repository whose lock was held is `LOCKED` in `outcomes`, one whose lease ran out `LEASE_LOST` |
| `list({ from? })` | the backups one repository holds, oldest first — each with `kind`, `parent` (the backup it builds on, `null` for a full one), `entries` (those it stores itself) and `held`, whether it is under a legal hold — and the ids whose manifest does not read. No key |
| `verify(id, { from?, identities? })` | reads a backup back and checks it — without `identities`, every object of it and of every backup it builds on against their manifests; with them, every entry of its view against the catalog, wherever stored. `Verified.chain` lists the backups read, newest first |
| `restore(id, target, { identities, from?, only? })` | writes the entries of its whole view, or those `only` picks, to `target`, each from the backup of its chain that stored it |
| `prune({ keep, from?, dryRun?, incompleteAfter?, now? })` | applies a retention policy to one repository under its lock, and resolves to `Pruned`: `kept` and `removed`, each `Decision` with its `reasons`, the `incomplete` ids it cleaned, the `unreadable` ones it left, and `overSize`. `dryRun` removes nothing and takes no lock. No key. Rejects with `LOCKED` or `LEASE_LOST` itself |
| `hold(id, { from? })` | puts a legal hold on a backup in every repository that has it — or in `from` alone — taking each one's lock in turn: `prune` keeps it until `unhold`. Resolves to `HoldResult` (`{ id, repositories }`, where it landed); `NOT_FOUND` when no repository has the backup, `LOCKED` while another `create`, `prune` or `hold` runs there |
| `unhold(id, { from? })` | lifts it in every repository, or `from`, under each lock; resolves to `HoldResult`. Lifting a hold that is not there is not an error |

| Type | |
| --- | --- |
| `BackupDefinition<Name>`, `BackupDefinitionInput<Name>` | what `defineBackup` gives back, and takes |
| `BindBackupOptions`, `BoundBackup<Name>` | what `bindBackup` takes, and gives back |
| `SigningKeys` | what `generateSigningKeys` gives back |
| `Created`, `Listing`, `BackupInfo`, `Verified`, `Restored` | what `create`, `list`, `verify` and `restore` resolve to |
| `CreateOptions`, `ListOptions`, `VerifyOptions`, `RestoreOptions` | their options |
| `BackupKind` | `'full' \| 'incremental' \| 'differential'`: `Created.kind`, `BackupInfo.kind` |
| `KeepPolicy`, `PruneOptions`, `Pruned`, `Decision`, `HoldOptions`, `HoldResult` | what `prune` takes and resolves to, one backup's fate in it, and what `hold` and `unhold` take and resolve to |
| `Repository`, `LocalRepositoryOptions`, `S3RepositoryOptions` | where backups are kept, the shipped repositories' options, and the contract to write your own |
| `BackupSource`, `SourceEntry`, `RestoreTarget` | what a backup reads from and a restore writes to. `SourceEntry.fingerprint` and `BackupSource.position()` are optional, for incremental backups |
| `Since` | what `BackupSource.entries(since)` gets when the backup builds on another: its `id`, its `position`, and its `entries` by name with their `size`, `sha256` and `fingerprint` |
| `DirectoryOptions`, `DirectoryTargetOptions` | `directorySource`'s and `directoryTarget`'s options |
| `BackupError`, `BackupErrorCode`, `BackupErrorOptions`, `RepositoryOutcome` | the error, its codes, and each repository's outcome |

## Errors

`BackupError` is the one error this package throws of its own, with a
`code`, the `backup` (the definition's name), and the `id`, `repository` or
`outcomes` it is about. Its message names the call, the definition and the
repository — **never a key, an entry's name or anything read from a
source**.

| `BackupErrorCode` | | |
| --- | --- | --- |
| `NOT_FOUND` | no backup with that id in that repository — or none with a manifest, which is the same thing — or a name in `only` the backup does not hold; from an incremental `create`, nothing to build on | `verify on "uploads": no backup with that id (repository "local")` |
| `INTEGRITY` | what the repository holds is not what was written: an object missing or differing from the manifest, a manifest or catalog that does not read, an entry whose bytes differ, a backup an incremental builds on gone. A mismatch against the manifest stops before a byte is decrypted; a mismatch against the catalog fails the entry's stream at its end, so a target that stages, like `directoryTarget`, lands nothing, while one that streams has already seen the bytes | `verify on "uploads": an object differs from its manifest (repository "local")` |
| `DECRYPT` | none of the identities given opens the backup | `restore on "uploads": no identity given opens it (repository "local")` |
| `SIGNATURE` | `trusted` keys are set and the manifest has no signature, or none by a trusted key. Nothing else of the backup was read. `list` puts the id in `unreadable` instead | `restore on "uploads": no trusted key signed the manifest (repository "local")` |
| `PARTIAL` | `create` stored it in some repositories and not others; `outcomes` says which. The stored copies are complete | `create on "uploads": stored in 1 of 2 repositories` |
| `NOT_STORED` | `create` stored it nowhere; `outcomes` holds each repository's error | `create on "uploads": stored in 0 of 1 repositories` |
| `LOCKED` | another `create`, `prune` or `hold` of the definition has that repository's lock: try later. Never thrown by `create` itself: it is one repository's `outcomes[].error`, and the others go on. `prune`, `hold` and `unhold` reject with it | `create on "uploads": another create, prune or hold has the lock (repository "nas")` |
| `LEASE_LOST` | this run held that repository's lock and could not renew it in time — the store out of reach, or the process paused longer than the lease — so it started nothing more there: worth an alert. From `create`, like `LOCKED`, only ever one repository's `outcomes[].error`; `prune`, `hold` and `unhold` reject with it | `create on "uploads": the lock's lease ran out before it was done (repository "local")` |

**Wiring is a bare `TypeError`**: a bad name, an empty repository list, two
repositories with one name, a key age refuses, a signing or trusted key that
is not an Ed25519 key of the right half, a relative path, an S3 `prefix` or
`partSize` that could never work, a `lock.lease` out of range, an unknown `from`,
a malformed id, a `kind` that is not one of the three, empty `identities`,
a source of another kind than the backup it builds on, a source
`fingerprint` over 1024 bytes or `position` over 64 KiB, a parent encrypted
to other recipients, a `keep` with no rule or a rule under 1, an `incompleteAfter`
under two lock leases, a `now` that is not a valid `Date`. None quotes a key.
An error from your source, your target or
a repository passes through as it is. Every message is in
[troubleshooting](docs/troubleshooting.md); a handler is in
[errors](docs/guide/errors.md).

## What does not compile

Each is a `@ts-expect-error` case in [`test/types/backup.ts`](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/test/types/backup.ts), which the package does not ship.

- `defineBackup` without a name, or with a name that is not a string.
- `bindBackup` with no repository, no recipient, or a recipient that is not
  a string; with `signing` given the key itself instead of `{ key }`; with
  `trusted: []`, or one key instead of a list; with a `lock.lease` that is
  not a number (`'5m'`).
- `create` given a path instead of a source; with `kind: 'incremental'` or
  `'differential'` and no `identities`; with `identities` on a full backup;
  with a `kind` that is not one of the three.
- `restore` without `identities`, with one key instead of a list, or with an
  `only` that is neither a list of names nor a test on a name; `verify` with
  one key instead of a list.
- `prune` without `keep`, or with a rule given as a string (`daily: '7'`).

## Traps

- **Bun only.** On Node the first `create` rejects with
  `ReferenceError: Bun is not defined` — [more](docs/troubleshooting.md#referenceerror-bun-is-not-defined).
- **Lose the identity and the backups are noise.** Keep the secret key
  outside the host it protects, and add a second recipient held elsewhere:
  `recipients: [primary, escrow]` — [encryption](docs/guide/encryption.md#several-recipients).
- **Without `signing` or `trusted`, nothing is signed or checked**, as in
  0.1: anyone who can write to the repository can write a whole backup of
  their own that verifies and restores — the public keys are in every
  manifest, in the clear. Give `trusted` to every reader, not only the
  writer `signing`: `trusted: [publicKey]` —
  [signing](docs/guide/signing.md#without-signing-or-trusted).
- **Turning signing on makes the older, unsigned backups `unreadable`** to
  every reader with `trusted`. Keep a reader without it until they expire —
  [upgrading](docs/upgrading.md#01--02).
- **macOS's `openssl` cannot check a signature**: it is LibreSSL, which has
  no Ed25519, and stops at `unable to load Public Key`. Use OpenSSL 3 —
  [by hand](docs/guide/signing.md#checking-a-signature-by-hand).
- **`tmpDir` needs room for the largest object**, compressed and encrypted,
  for `create`, `verify` and `restore` alike. `tmpDir: '/var/tmp'` when
  `/tmp` is a small tmpfs — [more](docs/troubleshooting.md#a-backup-or-a-restore-fails-for-lack-of-room).
- **An S3 upload that is never completed leaves parts the bucket bills for**,
  out of any listing; this package cannot see nor remove them. Give the
  bucket a lifecycle rule:
  `"AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }` —
  [repositories](docs/guide/repositories.md#abandoned-uploads-add-a-lifecycle-rule).
- **A repository's `name` is in every error message**: never a credential,
  nor an endpoint URL that holds one. Keep `name: 's3'`, or call it
  `name: 'offsite'` — [repositories](docs/guide/repositories.md#s3repository).
- **A failed restore keeps what it already wrote**: entries before the
  damaged one stay. Restore into an empty folder, then move it into place —
  [restore](docs/guide/getting-started.md#restore).
- **A source that throws mid-backup leaves objects without a manifest**:
  not listed, not restorable, until `prune` removes them once older than
  `incompleteAfter` — a day, counted from the create's start by this
  machine's clock. Shorter only if every create ends well within it:
  `prune({ keep, incompleteAfter: 6 * 3_600_000 })`, never under two leases — [more](docs/troubleshooting.md#a-backup-that-failed-left-objects-in-the-repository).
- **Rotation's calendar is UTC**: `daily`, `weekly` (ISO, Monday first) and
  the rest cut periods at UTC midnight, not local. A job at 00:30 in Paris
  makes the previous UTC day's backup; schedule by UTC if the day must
  match — [the rules](docs/guide/rotation.md#the-rules).
- **`maxTotalSize` can stay over**: it never removes the newest `last` (or
  the newest one), a held backup or a needed parent, and says so only with
  `overSize: true`. Check it: `if (pruned.overSize) alert()` —
  [more](docs/troubleshooting.md#oversize-is-true).
- **A dry run takes no lock, so its plan can differ from the real run's**: a
  `create` or a `hold` may land in between. Act on the real run's `removed`,
  not the dry run's — [dry run first](docs/guide/rotation.md#dry-run-first).
- **A hold waits for no one, and `unhold` is idempotent**: `hold` during a
  running `create` or `prune` rejects `LOCKED` — retry once it ends — and
  with `from` it holds that repository only. Lifting a hold that is not
  there is not an error, so a wrong id lifts nothing, silently: check the
  result's `repositories` and `list`'s `held` —
  [legal holds](docs/guide/rotation.md#legal-holds).
- **Overlapping runs no longer both run**: from 0.4, a `create` started while
  another of the same definition is still writing fails `LOCKED` in every
  repository and reads nothing. Treat that outcome as "skipped" in a cron
  job — [locking](docs/guide/locking.md#scheduling).
- **A killed run blocks that repository for up to two leases** (10 minutes
  by default): its lock stays until `expiresAt` plus one lease. Delete
  `<backup>/locks/<id>.json` by hand once nothing runs —
  [after a crash](docs/guide/locking.md#after-a-crash).
- **A lock file that does not parse blocks every `create` until removed**:
  nothing in it says when it ends. `rm /mnt/backups/uploads/locks/<id>.json`
  — [locking](docs/guide/locking.md#what-a-lock-file-looks-like).
- **An incremental `create` needs a secret key on the host that makes it**,
  to read what its parent recorded; a full one needs only public keys. Keep
  the key in a file only the job reads — `chmod 600 /etc/backup/identity.txt` —
  or keep to full backups there —
  [chains](docs/guide/chains.md#it-needs-a-key-where-backups-are-made).
- **A 0.5 `prune` does not protect what an incremental builds on**: it
  cannot read incremental manifests, so it leaves them, and may remove their
  full backup — they then fail `a backup it builds on is missing`. Upgrade
  every process that prunes or reads to 0.6 before the first incremental:
  `bun add @nxgt/backup@^0.6.0` — [upgrading](docs/upgrading.md#05--06).
- **After changing `recipients`, the next backup must be full**: an
  incremental refuses a parent encrypted to other recipients —
  `the backup it builds on is encrypted to other recipients; make a full backup first`.
  Run `create(source)` once with the new keys —
  [changing recipients](docs/guide/chains.md#changing-recipients).
- **A source's `fingerprint` must change whenever its bytes do**: an entry
  whose fingerprint is the recorded one is not read, and keeps its old
  bytes. When unsure, give none — the entry is then read, and stored only if
  it changed —
  [writing a source](docs/guide/chains.md#writing-a-source-with-fingerprints-and-a-position).
- **Check `instanceof BackupError` before `code`**: Node's file errors carry
  a `code` too (`ENOENT`) — [errors](docs/guide/errors.md#a-handler).

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/getting-started.md](docs/guide/getting-started.md) — define,
  bind, create, list, verify and restore, with a nightly job and a restore
  drill.
- [docs/guide/format.md](docs/guide/format.md) — the repository layout, the
  manifest, its signature and the catalog, ids, and opening a backup by hand.
- [docs/guide/encryption.md](docs/guide/encryption.md) — recipients and
  identities, post-quantum keys, and what age does and does not prove.
- [docs/guide/signing.md](docs/guide/signing.md) — signed manifests:
  `signing`, `trusted`, `generateSigningKeys`, `SIGNATURE`, changing the key,
  and checking a signature with `openssl`.
- [docs/guide/chains.md](docs/guide/chains.md) — incremental and
  differential backups: what each builds on, the whole-view catalog,
  fingerprints and positions, a schedule, and the key they need.
- [docs/guide/rotation.md](docs/guide/rotation.md) — `prune` and its
  retention rules, the reasons, dry runs, a policy per repository, legal
  holds, and the clean-up of incomplete backups.
- [docs/guide/locking.md](docs/guide/locking.md) — the single-writer lock
  `create`, `prune` and `hold` take: `LOCKED`, `LEASE_LOST`, `lock.lease`, the
  lock file, and clearing one after a crash.
- [docs/guide/repositories.md](docs/guide/repositories.md) —
  `localRepository`, `s3Repository` and the bucket it needs, several
  repositories, and writing your own.
- [docs/guide/sources-and-targets.md](docs/guide/sources-and-targets.md) —
  `directorySource`, `directoryTarget`, and writing your own.
- [docs/guide/errors.md](docs/guide/errors.md) — `BackupError`, its codes
  and fields, and a handler.
- [docs/upgrading.md](docs/upgrading.md) — what to change from one minor to
  the next.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT
