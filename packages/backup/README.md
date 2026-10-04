# @nxgt/backup

Encrypted, verifiable backups on **Bun**. Each entry a source gives — a file,
a database dump — is compressed with **zstd**, then encrypted with
**[age](https://age-encryption.org)** to one or more public keys, and stored
in one or several repositories at once:

- the backup host needs **only public keys**; the secret key is needed to
  restore, nowhere else;
- a clear **manifest**, written **last**, pins the size and SHA-256 of every
  stored object, so `list` and `verify` run without a key, and a backup
  exists once — and only once — its manifest does;
- a restore checks each object against the manifest **before decrypting a
  byte**, and each entry's bytes against what the source gave as they go;
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

> **0.x.** Full backups, local repositories and checked restores are here;
> signed manifests, an S3 repository and rotation are next — see the
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
`catalog.age`, and `manifest.json` last. The
[format](docs/guide/format.md) page has the layout.

## List and verify

```ts
const { backups: held, unreadable } = await backups.list();
// held: [{ id, createdAt, kind: 'full', entries, storedSize }, …], oldest first

const latest = held.at(-1);
if (latest) {
	await backups.verify(latest.id); // every object's size and SHA-256, no key
	await backups.verify(latest.id, {
		identities: [process.env.BACKUP_IDENTITY as string], // and every entry, decrypted
	});
}
```

`list` reads manifests alone. A backup whose manifest was never written — one
still running, one that failed — is not listed; one whose manifest does not
read is in `unreadable`, and `verify` on it says why.

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

## Your own source, target or repository

A source is a `kind` and an async iterable of `{ name, open }`:

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
[repositories](docs/guide/repositories.md#writing-a-repository).

## API

| Function | |
| --- | --- |
| `defineBackup({ name })` | describes a backup; touches nothing. Frozen. A name that could not be a path segment is a bare `TypeError` |
| `bindBackup(definition, { repositories, recipients, tmpDir? })` | binds it to where it is kept and who can read it. No I/O; a list or a key that could never work is a bare `TypeError` |
| `localRepository({ path, name? })` | a repository in a local folder — a disk, a mounted volume, a share. `name` is `local` by default |
| `directorySource({ path })` | every regular file under a folder, by relative path, sorted. Symbolic links and empty folders are skipped |
| `directoryTarget({ path, overwrite? })` | writes each entry to a file under a folder. Refuses an unsafe name, and an existing file unless `overwrite: true` |

| `BoundBackup<Name>` | |
| --- | --- |
| `definition`, `repositories` | the definition, and the repository names in the order given |
| `create(source)` | reads every entry and stores a full backup in every repository. Resolves to `Created` once each holds it; rejects with `PARTIAL` or `NOT_STORED` otherwise |
| `list({ from? })` | the backups one repository holds, oldest first, and the ids whose manifest does not read. No key |
| `verify(id, { from?, identities? })` | reads a backup back and checks it — objects against the manifest without `identities`, entries against the catalog with them |
| `restore(id, target, { identities, from?, only? })` | writes the entries, or those `only` picks, to `target` |

| Type | |
| --- | --- |
| `BackupDefinition<Name>`, `BackupDefinitionInput<Name>` | what `defineBackup` gives back, and takes |
| `BindBackupOptions`, `BoundBackup<Name>` | what `bindBackup` takes, and gives back |
| `Created`, `Listing`, `BackupInfo`, `Verified`, `Restored` | what `create`, `list`, `verify` and `restore` resolve to |
| `ListOptions`, `VerifyOptions`, `RestoreOptions` | their options |
| `Repository`, `LocalRepositoryOptions` | where backups are kept, to write your own |
| `BackupSource`, `SourceEntry`, `RestoreTarget` | what a backup reads from and a restore writes to |
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
| `NOT_FOUND` | no backup with that id in that repository — or none with a manifest, which is the same thing — or a name in `only` the backup does not hold | `verify on "uploads": no backup with that id (repository "local")` |
| `INTEGRITY` | what the repository holds is not what was written: an object missing or differing from the manifest, a manifest or catalog that does not read, an entry whose bytes differ. A mismatch against the manifest stops before a byte is decrypted; a mismatch against the catalog fails the entry's stream at its end, so a target that stages, like `directoryTarget`, lands nothing, while one that streams has already seen the bytes | `verify on "uploads": an object differs from its manifest (repository "local")` |
| `DECRYPT` | none of the identities given opens the backup | `restore on "uploads": no identity given opens it (repository "local")` |
| `PARTIAL` | `create` stored it in some repositories and not others; `outcomes` says which. The stored copies are complete | `create on "uploads": stored in 1 of 2 repositories` |
| `NOT_STORED` | `create` stored it nowhere; `outcomes` holds each repository's error | `create on "uploads": stored in 0 of 1 repositories` |

**Wiring is a bare `TypeError`**: a bad name, an empty repository list, two
repositories with one name, a key age refuses, a relative path, an unknown
`from`, a malformed id. An error from your source, your target or a
repository passes through as it is. Every message is in
[troubleshooting](docs/troubleshooting.md); a handler is in
[errors](docs/guide/errors.md).

## What does not compile

Each is a `@ts-expect-error` case in [`test/types/backup.ts`](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/test/types/backup.ts), which the package does not ship.

- `defineBackup` without a name, or with a name that is not a string.
- `bindBackup` with no repository, no recipient, or a recipient that is not
  a string.
- `create` given a path instead of a source.
- `restore` without `identities`, with one key instead of a list, or with an
  `only` that is neither a list of names nor a test on a name; `verify` with
  one key instead of a list.

## Traps

- **Bun only.** On Node the first `create` rejects with
  `ReferenceError: Bun is not defined` — [more](docs/troubleshooting.md#referenceerror-bun-is-not-defined).
- **Lose the identity and the backups are noise.** Keep the secret key
  outside the host it protects, and add a second recipient held elsewhere:
  `recipients: [primary, escrow]` — [encryption](docs/guide/encryption.md#several-recipients).
- **A checked backup is not yet a signed one**: anyone who can write to the
  repository can write a whole backup of their own that verifies and
  restores — the public keys are in every manifest, in the clear. Signed manifests are next — [what it proves](docs/guide/encryption.md#what-it-proves-and-what-it-does-not).
- **`tmpDir` needs room for the largest object**, compressed and encrypted,
  for `create`, `verify` and `restore` alike. `tmpDir: '/var/tmp'` when
  `/tmp` is a small tmpfs — [more](docs/troubleshooting.md#a-backup-or-a-restore-fails-for-lack-of-room).
- **A failed restore keeps what it already wrote**: entries before the
  damaged one stay. Restore into an empty folder, then move it into place —
  [restore](docs/guide/getting-started.md#restore).
- **A source that throws mid-backup leaves objects without a manifest**:
  not listed, not restorable, and not cleaned up yet — [more](docs/troubleshooting.md#a-backup-that-failed-left-objects-in-the-repository).
- **Check `instanceof BackupError` before `code`**: Node's file errors carry
  a `code` too (`ENOENT`) — [errors](docs/guide/errors.md#a-handler).

## Documentation

- [docs/README.md](docs/README.md) — the guide index.
- [docs/guide/getting-started.md](docs/guide/getting-started.md) — define,
  bind, create, list, verify and restore, with a nightly job and a restore
  drill.
- [docs/guide/format.md](docs/guide/format.md) — the repository layout, the
  manifest and the catalog, ids, and opening a backup by hand.
- [docs/guide/encryption.md](docs/guide/encryption.md) — recipients and
  identities, post-quantum keys, and what age does and does not prove.
- [docs/guide/repositories.md](docs/guide/repositories.md) —
  `localRepository`, several repositories, and writing your own.
- [docs/guide/sources-and-targets.md](docs/guide/sources-and-targets.md) —
  `directorySource`, `directoryTarget`, and writing your own.
- [docs/guide/errors.md](docs/guide/errors.md) — `BackupError`, its codes
  and fields, and a handler.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every error this
  package can raise, by the message you will see.
- [docs/roadmap.md](docs/roadmap.md) — what is coming, and what has been
  ruled out.

## License

MIT
