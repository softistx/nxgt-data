# Troubleshooting

This package throws one error of its own, `BackupError`, with a `code` —
`NOT_FOUND`, `INTEGRITY`, `DECRYPT`, `PARTIAL` or `NOT_STORED` — the `backup`
it is about, and its `id`, `repository` or `outcomes`
([errors](guide/errors.md)). A refusal of the way it was called — a name, a
path, a key, an id — is a plain `TypeError`. Errors from your source, your
target, a repository or the file system come back as they are.

**No message quotes a key, an entry's name or a value.** The headings below
use `app` for the definition's name and `local` for the repository's, and
the call that failed in front: the same refusal from another call names that
call instead — `verify on "app": …` or `restore on "app": …`.

- **Install and run**
  - [`ReferenceError: Bun is not defined`](#referenceerror-bun-is-not-defined)
- **Configuration**
  - [`defineBackup: the name must be 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"`](#definebackup-the-name-must-be-1-to-100-characters-lowercase-letters-digits--_-and---starting-with-a-letter-or-a-digit-without-partial-)
  - [`bindBackup: the definition did not come from defineBackup`](#bindbackup-the-definition-did-not-come-from-definebackup)
  - [`bindBackup: repositories must list at least one repository`](#bindbackup-repositories-must-list-at-least-one-repository)
  - [`bindBackup: two repositories have the same name`](#bindbackup-two-repositories-have-the-same-name)
  - [`bindBackup: tmpDir must be an absolute path`](#bindbackup-tmpdir-must-be-an-absolute-path)
  - [`bindBackup: recipients must list at least one age public key`](#bindbackup-recipients-must-list-at-least-one-age-public-key)
  - [`bindBackup: recipient 0 is not an age public key (age1… or age1pq1…)`](#bindbackup-recipient-0-is-not-an-age-public-key-age1-or-age1pq1)
  - [`localRepository: path must be an absolute path`](#localrepository-path-must-be-an-absolute-path)
  - [`directorySource: path must be an absolute path`](#directorysource-path-must-be-an-absolute-path)
  - [`directoryTarget: path must be an absolute path`](#directorytarget-path-must-be-an-absolute-path)
- **Calling it**
  - [`list on "app": no repository has that name`](#list-on-app-no-repository-has-that-name)
  - [`verify on "app": the id is not a backup id`](#verify-on-app-the-id-is-not-a-backup-id)
  - [`restore: identities must list at least one age secret key`](#restore-identities-must-list-at-least-one-age-secret-key)
  - [`restore: identity 0 is not an age secret key (AGE-SECRET-KEY-…)`](#restore-identity-0-is-not-an-age-secret-key-age-secret-key-)
  - [`create on "app": the source gave an entry name that is empty, over 4096 characters, holds a NUL, or was given twice`](#create-on-app-the-source-gave-an-entry-name-that-is-empty-over-4096-characters-holds-a-nul-or-was-given-twice)
  - [`ENOENT: no such file or directory, scandir '/srv/uploads'`](#enoent-no-such-file-or-directory-scandir-srvuploads)
  - [`directoryTarget: an entry name is not a relative path inside the folder`](#directorytarget-an-entry-name-is-not-a-relative-path-inside-the-folder)
  - [`directoryTarget: a file is already there; pass overwrite: true to replace it`](#directorytarget-a-file-is-already-there-pass-overwrite-true-to-replace-it)
  - [`restore on "app": the target resolved write before reading its stream to the end, so nothing it was given was checked`](#restore-on-app-the-target-resolved-write-before-reading-its-stream-to-the-end-so-nothing-it-was-given-was-checked)
- **Creating**
  - [`create on "app": stored in 1 of 2 repositories`](#create-on-app-stored-in-1-of-2-repositories)
  - [`create on "app": stored in 0 of 1 repositories`](#create-on-app-stored-in-0-of-1-repositories)
  - [`local repository: a key is not a relative path`](#local-repository-a-key-is-not-a-relative-path)
- **Reading back**
  - [`verify on "app": no backup with that id (repository "local")`](#verify-on-app-no-backup-with-that-id-repository-local)
  - [`restore on "app": an entry asked for is not in the backup (repository "local")`](#restore-on-app-an-entry-asked-for-is-not-in-the-backup-repository-local)
  - [`restore on "app": no identity given opens it (repository "local")`](#restore-on-app-no-identity-given-opens-it-repository-local)
  - [`verify on "app": an object differs from its manifest (repository "local")`](#verify-on-app-an-object-differs-from-its-manifest-repository-local)
  - [`verify on "app": an object is missing (repository "local")`](#verify-on-app-an-object-is-missing-repository-local)
  - [`verify on "app": the manifest is unreadable: … (repository "local")`](#verify-on-app-the-manifest-is-unreadable--repository-local)
  - [`verify on "app": the manifest is another backup’s (repository "local")`](#verify-on-app-the-manifest-is-another-backups-repository-local)
  - [`restore on "app": the catalog is unreadable: … (repository "local")`](#restore-on-app-the-catalog-is-unreadable--repository-local)
  - [`restore on "app": the catalog does not decrypt (repository "local")`](#restore-on-app-the-catalog-does-not-decrypt-repository-local)
  - [`restore on "app": an entry differs from what its source gave (repository "local")`](#restore-on-app-an-entry-differs-from-what-its-source-gave-repository-local)
  - [`restore on "app": an entry does not decrypt (repository "local")`](#restore-on-app-an-entry-does-not-decrypt-repository-local)
- **Symptoms without a message**
  - [A backup is missing from `list`](#a-backup-is-missing-from-list)
  - [An id is in `unreadable`](#an-id-is-in-unreadable)
  - [A backup that failed left objects in the repository](#a-backup-that-failed-left-objects-in-the-repository)
  - [A backup or a restore fails for lack of room](#a-backup-or-a-restore-fails-for-lack-of-room)

## Install and run

### `ReferenceError: Bun is not defined`

**When:** the first `create`, `verify` or `restore`, under Node.
`defineBackup` and `bindBackup` load and run; measured on Node 24.
**Why:** the package runs on Bun 1.4 or later only. zstd is Bun's own
`CompressionStream('zstd')`, hashing is `Bun.CryptoHasher`, and files are
read and written with `Bun.file` and `Bun.write`.
**Fix:** run the job with Bun.

```sh
bun run backup.ts
```

## Configuration

These are thrown once, where the backup is wired — usually at start-up.

### `defineBackup: the name must be 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"`

**When:** `defineBackup({ name })`.
**Why:** the name is the first segment of every key the backup writes, so it
must be a safe path segment everywhere: no capitals, no `/`, no accents, no
leading `.` or `-`, and no `.partial-` — the marker `localRepository` gives
a file being written, which it never lists nor reads. The message gives the
rule, not the name.
**Fix:**

```ts
defineBackup({ name: 'uploads' }); // not 'Uploads', 'my/uploads', '.uploads', 'uploads.partial-1'
```

### `bindBackup: the definition did not come from defineBackup`

**When:** `bindBackup(definition, …)`, with a definition written by hand or
`undefined` — often an import that resolved to nothing.
**Why:** `bindBackup` checks the name again, so a definition that skipped
`defineBackup` is held to the same rule.
**Fix:**

```ts
const uploads = defineBackup({ name: 'uploads' });
bindBackup(uploads, options);
```

### `bindBackup: repositories must list at least one repository`

**When:** `bindBackup`, with `repositories: []` — often a list built from
configuration that came out empty.
**Why:** a backup with nowhere to go could never be stored.
**Fix:**

```ts
repositories: [localRepository({ path: '/mnt/backups' })],
```

### `bindBackup: two repositories have the same name`

**When:** `bindBackup`, with two repositories that share a `name` — two
`localRepository` calls without one both get `local`.
**Why:** outcomes, errors and `from` tell repositories apart by name.
**Fix:**

```ts
repositories: [
	localRepository({ path: '/mnt/backups', name: 'disk' }),
	localRepository({ path: '/mnt/nas/backups', name: 'nas' }),
],
```

### `bindBackup: tmpDir must be an absolute path`

**When:** `bindBackup`, with a relative `tmpDir`.
**Why:** each object is staged there; a relative path would depend on the
directory the job was started from.
**Fix:**

```ts
tmpDir: '/var/tmp',
```

### `bindBackup: recipients must list at least one age public key`

**When:** `bindBackup`, with `recipients: []`.
**Why:** every backup is encrypted; without a recipient nobody could open it.
**Fix:**

```ts
recipients: [process.env.BACKUP_RECIPIENT as string], // age1…
```

### `bindBackup: recipient 0 is not an age public key (age1… or age1pq1…)`

**When:** `bindBackup`; the number is the recipient's position in the list.
**Why:** age refused it. Usual causes: the **secret** key
(`AGE-SECRET-KEY-1…`) given where the public one goes, an environment
variable that is unset or holds quotes or a newline, a key cut short when
copied — a hybrid `age1pq1…` key is about 1,960 characters. The key itself
is never quoted, and age's own message is not passed on.
**Fix:** derive the public key from the secret one, and pass that.

```ts
import { identityToRecipient } from 'age-encryption';

const recipient = await identityToRecipient(identity); // age1… — this goes in recipients
```

### `localRepository: path must be an absolute path`

**When:** `localRepository({ path })`.
**Fix:**

```ts
import { resolve } from 'node:path';

localRepository({ path: resolve('backups') });
```

### `directorySource: path must be an absolute path`

**When:** `directorySource({ path })`.
**Fix:**

```ts
directorySource({ path: resolve('uploads') });
```

### `directoryTarget: path must be an absolute path`

**When:** `directoryTarget({ path })`.
**Fix:**

```ts
directoryTarget({ path: resolve('restore') });
```

## Calling it

These are bare `TypeError`s, as rejections: the call was made wrongly, and
nothing was read or written.

### `list on "app": no repository has that name`

**When:** `list`, `verify` or `restore` with a `from` that is not the name of
a repository given to `bindBackup`.
**Why:** reads go to one repository, picked by name; there is no fallback.
**Fix:** use a name from `backups.repositories`.

```ts
console.log(backups.repositories); // ['disk', 'nas']
await backups.list({ from: 'nas' });
```

### `verify on "app": the id is not a backup id`

**When:** `verify` or `restore`, with something that is not an id —
`'latest'`, an empty string, a path.
**Why:** an id has one shape, `20261003T221500123Z-9f3a61c0`, and becomes a
key segment; anything else is refused before the repository is asked.
**Fix:** take the id from `create` or `list`.

```ts
const latest = (await backups.list()).backups.at(-1);
if (latest) await backups.verify(latest.id);
```

### `restore: identities must list at least one age secret key`

**When:** `restore`, or `verify` with `identities: []`.
**Why:** nothing could open the backup. For `verify`, leave `identities` out
to check without a key.
**Fix:**

```ts
await backups.restore(id, target, { identities: [process.env.BACKUP_IDENTITY as string] });
await backups.verify(id); // no key: objects against the manifest only
```

### `restore: identity 0 is not an age secret key (AGE-SECRET-KEY-…)`

**When:** `restore` or `verify`; the number is the identity's position.
**Why:** age refused it: a public key (`age1…`) where the secret one goes, a
variable that is unset or holds quotes or a newline, a key cut short.
Measured on `age-encryption` 0.3.1, age's own message for this quotes the
whole secret key, so it is dropped — not passed as `cause` — and nothing in
the error holds the key.
**Fix:**

```ts
identities: [(process.env.BACKUP_IDENTITY ?? '').trim()], // AGE-SECRET-KEY-1… or AGE-SECRET-KEY-PQ-1…
```

### `create on "app": the source gave an entry name that is empty, over 4096 characters, holds a NUL, or was given twice`

**When:** `create`, with a source you wrote. Entries before it are already
stored, without a manifest.
**Why:** a name is how a restore finds the entry, so each must be a usable
string, unique within the backup. The message does not say which, since it
would quote it.
**Fix:** make the names unique in the source — prefix them by what they come
from.

```ts
yield { name: `orders/${day}.jsonl`, open };
```

### `ENOENT: no such file or directory, scandir '/srv/uploads'`

**When:** `create` with a `directorySource` whose folder is not there —
measured on Bun 1.4.2. The `code` is `ENOENT`, and no backup is written.
**Why:** the folder is listed when `create` starts; the error is the file
system's own. A mount that did not come up gives the same — on purpose: a
missing folder is never taken for an empty one.
**Fix:** check the path the job runs with — and test `instanceof BackupError`
before reading `code`, which an `ENOENT` has too.

```ts
import { stat } from 'node:fs/promises';

await stat('/srv/uploads'); // fail early, with the path, before create
```

### `directoryTarget: an entry name is not a relative path inside the folder`

**When:** `restore` into a `directoryTarget`. The entries before it are
written.
**Why:** an entry's name comes from the backup, and so from the repository:
one holding `\`, or an empty, `.` or `..` segment — `../x`, `/etc/x`,
`a//b` — would write outside the folder, so it is refused and its stream
cancelled. So is a name whose folder is already in the target as a symbolic
link, or as a file: `a/x.txt` when `a` links elsewhere would land there. `directorySource` never produces such a name; another source can,
and a tampered repository could.
**Fix:** restore that backup with a target of your own that maps names, or
skip the entry:

```ts
await backups.restore(id, directoryTarget({ path: '/srv/restore' }), {
	identities,
	only: (name) => !name.split('/').some((s) => s === '' || s === '.' || s === '..') && !name.includes('\\'),
});
```

For a folder that is a link or a file in the target, the name is fine and
the target is not: remove that link, or restore into an empty folder.

### `directoryTarget: a file is already there; pass overwrite: true to replace it`

**When:** `restore` into a folder that already holds a file of that name —
checked before the entry is read, and again when it lands (by a hard link,
which refuses an existing name), so a file that appears meanwhile is not
replaced either. On a file system without hard links — FAT, some network
mounts — the second check is a look before the move, and leaves that window
open. The entries before it are written.
**Why:** a restore does not replace files unless told to.
**Fix:** restore into an empty folder, or say so.

```ts
directoryTarget({ path: '/srv/uploads', overwrite: true });
```

### `restore on "app": the target resolved write before reading its stream to the end, so nothing it was given was checked`

**When:** `restore` into a target of your own whose `write` resolves before
it has read the stream to its end — it hands the stream to a background
upload, or reads only the first chunk.
**Why:** the checks against the catalog run at the stream's end. A `write`
that resolves sooner has had nothing checked, and the next entry would
reuse the staged file under the stream still reading it.
**Fix:** resolve `write` only once the stream has ended:

```ts
import type { RestoreTarget } from '@nxgt/backup';

declare function upload(name: string, body: ReadableStream<Uint8Array>): Promise<void>;

const target: RestoreTarget = {
	async write(name, stream) {
		await upload(name, stream); // awaits the whole body, not just the start
	},
};
```

## Creating

### `create on "app": stored in 1 of 2 repositories`

**Code:** `PARTIAL`.
**When:** `create`, when some repositories took the whole backup and others
failed.
**Why:** each object goes to every repository still in the run; one that
fails is left out from then on, and gets no manifest. The copies that were
stored are complete and stay.
**Fix:** read `outcomes` for the repository and its error, fix it, and run
the next backup. Check the stored copy if you want proof:

```ts
if (error instanceof BackupError && error.code === 'PARTIAL' && error.id) {
	const failed = error.outcomes.filter((outcome) => !outcome.stored);
	const stored = error.outcomes.find((outcome) => outcome.stored);
	if (stored) await backups.verify(error.id, { from: stored.repository });
}
```

### `create on "app": stored in 0 of 1 repositories`

**Code:** `NOT_STORED`.
**When:** `create`, when no repository took it.
**Why:** every repository failed — a mount gone, a full disk, no permission,
a network store unreachable. Once the last one failed, the source was not
read further.
**Fix:** each outcome holds its repository's error, as it threw it.

```ts
for (const outcome of error.outcomes) {
	if (!outcome.stored) console.error(outcome.repository, outcome.error);
}
```

### `local repository: a key is not a relative path`

**When:** calling a `localRepository`'s methods yourself with a key that is
absolute, holds `..`, `.`, an empty segment or `.partial-`, or has a segment
with a character outside `A–Z a–z 0–9 . _ -` (a space, an accent). A backup never
writes such a key: `defineBackup` refuses a name holding `.partial-`.
**Why:** `localRepository` writes each file as `<key>.partial-<random>`
first, and never lists nor reads a name holding `.partial-`; a key that
holds it, or that would leave the folder, is refused.
**Fix:** build keys as the [Repository contract](guide/repositories.md#writing-a-repository) does —
relative, `/`-separated, each segment a plain name.

## Reading back

`list`, `verify` and `restore` read one repository: the first, or `from`.

### `verify on "app": no backup with that id (repository "local")`

**Code:** `NOT_FOUND`.
**When:** `verify` or `restore`.
**Why:** that repository has no manifest for that id. Either the backup is
in another repository, or it never finished — killed, failed, or the
repository was left out of a `PARTIAL` — or its manifest was deleted. A
backup exists once its manifest does.
**Fix:** list what the repository holds, and try another one.

```ts
for (const name of backups.repositories) {
	const { backups: held } = await backups.list({ from: name });
	console.log(name, held.some((b) => b.id === id));
}
```

### `restore on "app": an entry asked for is not in the backup (repository "local")`

**Code:** `NOT_FOUND`.
**When:** `restore` with `only` as a list, naming an entry the backup does
not hold. Nothing was written.
**Why:** a list of names is taken as exact; a misspelt one would otherwise
restore less than you asked for without a word. The name is not quoted.
**Fix:** check the names against what was backed up, or use a test, which
matches what it matches:

```ts
only: (name) => name.startsWith('avatars/'),
```

### `restore on "app": no identity given opens it (repository "local")`

**Code:** `DECRYPT`. `cause` holds age's error.
**When:** `restore`, or `verify` with identities.
**Why:** the object matched its manifest, so its bytes are as written; none of
the identities given is one of the recipients it was encrypted to. Usually a
key from another environment, or the backup predates a key rotation.
**Fix:** the manifest lists its recipients in the clear; find the identity
for one of them, or pass both the old and the new.

```ts
identities: [currentIdentity, previousIdentity],
```

### `verify on "app": an object differs from its manifest (repository "local")`

**Code:** `INTEGRITY`.
**When:** `verify` — with or without a key — or `restore`, which checks each
object before decrypting a byte; the target got nothing from it.
**Why:** an object's size or SHA-256 is not the one the manifest pins. Media
damage, a copy cut short, a sync tool that rewrote it — or someone who
replaced it, even with a valid age file written to your public key.
**Fix:** restore from another repository, and find out what touched this
one.

```ts
await backups.verify(id, { from: 'nas' });
await backups.restore(id, target, { identities, from: 'nas' });
```

### `verify on "app": an object is missing (repository "local")`

**Code:** `INTEGRITY`.
**When:** `verify` or `restore`.
**Why:** the manifest is there, and an object it lists is not — deleted, or
not copied when the repository was moved.
**Fix:** as above: another repository, and a look at what removed it.

### `verify on "app": the manifest is unreadable: … (repository "local")`

**Code:** `INTEGRITY`. In `list`, the id is in `unreadable` instead.
**When:** `verify` or `restore`.
**Why:** the file is there and is not a manifest this version of the
package reads. The reason after the colon says which check failed:

| Reason | Likely cause |
| --- | --- |
| `it is not JSON`, `it is not a JSON object` | a file cut short, or not a manifest |
| `it is not an nxgt-backup manifest` | a `manifest.json` from something else |
| `its format is one this version does not read` | written by a later version: upgrade to read it |
| `its kind is not one this version reads`, `its compression is not zstd` | a later version's backup, or an edit |
| `its backup name is not one`, `its id is not a backup id`, `its createdAt is not an ISO date`, `its recipients are not age public keys` | an edited or damaged manifest |
| `an object is not a record`, `an object key is not one this format writes`, `an object size is not a whole number of bytes`, `an object sha256 is not 64 hex digits`, `its catalog key is not catalog.age`, `its objects are not a list`, `its objects are not numbered in order` | an edited or damaged manifest |

**Fix:** another repository's copy; and a newer `@nxgt/backup` for a format
it does not read.

```sh
bun add @nxgt/backup@latest
```

### `verify on "app": the manifest is another backup’s (repository "local")`

**Code:** `INTEGRITY`. In `list`, the id is in `unreadable`.
**When:** `verify` or `restore`.
**Why:** the manifest parses, but names another backup or another id than
the folder it sits in — copied over from elsewhere, by hand or by a tool.
**Fix:** put each manifest back with its own objects, or use another
repository's copy.

### `restore on "app": the catalog is unreadable: … (repository "local")`

**Code:** `INTEGRITY`.
**When:** `restore`, or `verify` with identities.
**Why:** the catalog matched the manifest and decrypted, and is not a catalog
this version reads. Since both checks passed, either the manifest and the
catalog were rewritten together — which takes write access and the public
key — or this version cannot read what a later one wrote. The reason after
the colon is one of: `it is not JSON`, `it is not an nxgt-backup catalog`,
`its source has no kind`, `its entries do not match the manifest`, `an entry
is not a record`, `an entry name is not one`, `its entries do not follow the
objects`, `an entry size is not a whole number of bytes`, `an entry sha256 is
not 64 hex digits`, `two entries have the same name`.
**Fix:** another repository's copy, and a look at who can write to this one.

### `restore on "app": the catalog does not decrypt (repository "local")`

**Code:** `INTEGRITY`. `cause` holds age's or zstd's error.
**When:** `restore`, or `verify` with identities.
**Why:** the catalog matched the manifest, an identity opened its header, and
the rest failed age's checks or zstd's — so the manifest was rewritten to
match a damaged or forged catalog.
**Fix:** another repository's copy.

### `restore on "app": an entry differs from what its source gave (repository "local")`

**Code:** `INTEGRITY`.
**When:** `restore` — at the end of that entry's stream, so a target that
waits for the end, as `directoryTarget` does, lands nothing from it; the
entries before it are written — or `verify` with identities.
**Why:** the object matched the manifest and decrypted, but its plain bytes
are not the ones the catalog pins: the object **and** its line in the
manifest were replaced together. age cannot catch that — anyone with the
public key can write a valid age file — and the catalog does.
**Fix:** another repository's copy, and a look at who can write to this one.
[What each check proves](guide/encryption.md#what-it-proves-and-what-it-does-not).

### `restore on "app": an entry does not decrypt (repository "local")`

**Code:** `INTEGRITY`. `cause` holds age's or zstd's error.
**When:** `restore` or `verify` with identities, partway through an entry.
**Why:** as for the catalog: the object matched a manifest that was rewritten
to match it, and its body fails age's or zstd's checks.
**Fix:** another repository's copy.

Two more `INTEGRITY` messages exist as a second line of defence, and the
catalog's own checks make them unreachable: `the catalog names an object the
manifest lacks` and `the catalog misses an entry`. Treat either as the
entries above.

## Symptoms without a message

### A backup is missing from `list`

**Why:** it has no manifest in that repository — still running, failed, left
out of a `PARTIAL`, or its manifest deleted — or it is in another
repository. `list` reads one repository: the first, or `from`.
**Fix:**

```ts
for (const name of backups.repositories) console.log(name, (await backups.list({ from: name })).backups.length);
```

### An id is in `unreadable`

**Why:** its manifest is there and does not read as one this version wrote.
**Fix:** `verify` it for the reason, then see
[the manifest is unreadable](#verify-on-app-the-manifest-is-unreadable--repository-local).

```ts
const { unreadable } = await backups.list();
for (const id of unreadable) await backups.verify(id).catch((error) => console.error(error.message));
```

### A backup that failed left objects in the repository

**When:** after a `create` that rejected — a source that threw, the process
killed, `PARTIAL` for the repository that failed.
**Why:** objects go first and the manifest last, so a run that stopped holds
objects under `<backup>/<id>/` and no `manifest.json`. No call sees them, and
this version does not remove them.
**Fix:** cleaning up incomplete backups is [on the roadmap](roadmap.md#next).
Until then, a folder under `<backup>/` with no `manifest.json`, older than
your longest run, can be removed by hand.

### A backup or a restore fails for lack of room

**When:** `create`, `verify` or `restore` rejects with the file system's
`ENOSPC`.
**Why:** every object is staged whole in `tmpDir` — the system's temporary
folder by default, often a small in-memory `tmpfs` — between the source and
the repositories, and between a repository and the target: a restore checks
each object there before decrypting a byte. It needs room for the largest
object, compressed and encrypted.
**Fix:**

```ts
bindBackup(definition, { repositories, recipients, tmpDir: '/var/tmp' });
```
