# Troubleshooting

This package throws one error of its own, `BackupError`, with a `code` —
`NOT_FOUND`, `INTEGRITY`, `DECRYPT`, `SIGNATURE`, `PARTIAL`, `NOT_STORED`,
`LOCKED` or `LEASE_LOST` — the `backup` it is about, and its `id`,
`repository` or `outcomes` ([errors](guide/errors.md)). A refusal of the way it was called — a name, a
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
  - [`bindBackup: signing.key is not an Ed25519 private key (PEM, PKCS#8)`](#bindbackup-signingkey-is-not-an-ed25519-private-key-pem-pkcs8)
  - [`bindBackup: trusted 0 is a private key; give its public key`](#bindbackup-trusted-0-is-a-private-key-give-its-public-key)
  - [`bindBackup: trusted 0 is not an Ed25519 public key (PEM, SPKI)`](#bindbackup-trusted-0-is-not-an-ed25519-public-key-pem-spki)
  - [`bindBackup: trusted must list at least one public key`](#bindbackup-trusted-must-list-at-least-one-public-key)
  - [`bindBackup: trusted does not hold the public key of signing.key, so this backup could not read what it writes`](#bindbackup-trusted-does-not-hold-the-public-key-of-signingkey-so-this-backup-could-not-read-what-it-writes)
  - [`bindBackup: lock.lease must be a whole number of milliseconds, from 1 second to 1 day`](#bindbackup-locklease-must-be-a-whole-number-of-milliseconds-from-1-second-to-1-day)
  - [`localRepository: path must be an absolute path`](#localrepository-path-must-be-an-absolute-path)
  - [`s3Repository: prefix must be a relative path of plain segments`](#s3repository-prefix-must-be-a-relative-path-of-plain-segments)
  - [`s3Repository: partSize must be 5 MiB at least`](#s3repository-partsize-must-be-5-mib-at-least)
  - [`directorySource: path must be an absolute path`](#directorysource-path-must-be-an-absolute-path)
  - [`directoryTarget: path must be an absolute path`](#directorytarget-path-must-be-an-absolute-path)
- **Calling it**
  - [`list on "app": no repository has that name`](#list-on-app-no-repository-has-that-name)
  - [`verify on "app": the id is not a backup id`](#verify-on-app-the-id-is-not-a-backup-id)
  - [`restore: identities must list at least one age secret key`](#restore-identities-must-list-at-least-one-age-secret-key)
  - [`restore: identity 0 is not an age secret key (AGE-SECRET-KEY-…)`](#restore-identity-0-is-not-an-age-secret-key-age-secret-key-)
  - [`create on "app": trusted keys are set but no signing key, so this backup could not read what it writes`](#create-on-app-trusted-keys-are-set-but-no-signing-key-so-this-backup-could-not-read-what-it-writes)
  - [`create on "app": the source gave an entry name that is empty, over 4096 characters, holds a NUL, or was given twice`](#create-on-app-the-source-gave-an-entry-name-that-is-empty-over-4096-characters-holds-a-nul-or-was-given-twice)
  - [`ENOENT: no such file or directory, scandir '/srv/uploads'`](#enoent-no-such-file-or-directory-scandir-srvuploads)
  - [`directoryTarget: an entry name is not a relative path inside the folder`](#directorytarget-an-entry-name-is-not-a-relative-path-inside-the-folder)
  - [`directoryTarget: a file is already there; pass overwrite: true to replace it`](#directorytarget-a-file-is-already-there-pass-overwrite-true-to-replace-it)
  - [`restore on "app": the target resolved write before reading its stream to the end, so nothing it was given was checked`](#restore-on-app-the-target-resolved-write-before-reading-its-stream-to-the-end-so-nothing-it-was-given-was-checked)
- **Creating**
  - [`create on "app": stored in 1 of 2 repositories`](#create-on-app-stored-in-1-of-2-repositories)
  - [`create on "app": stored in 0 of 1 repositories`](#create-on-app-stored-in-0-of-1-repositories)
  - [`create on "app": another create or prune holds the lock (repository "local")`](#create-on-app-another-create-or-prune-holds-the-lock-repository-local)
  - [`create on "app": the lock's lease ran out before it was done (repository "local")`](#create-on-app-the-locks-lease-ran-out-before-it-was-done-repository-local)
  - [`create on "app": the manifest would be larger than 64 MiB; split the source into several backups`](#create-on-app-the-manifest-would-be-larger-than-64-mib-split-the-source-into-several-backups)
  - [`local repository: a key is not a relative path`](#local-repository-a-key-is-not-a-relative-path)
  - [`s3 repository: a key is not a relative path`](#s3-repository-a-key-is-not-a-relative-path)
  - [`s3 repository: an object was not stored whole`](#s3-repository-an-object-was-not-stored-whole)
  - [`s3 repository: a listing page was cut short with no way to go on`](#s3-repository-a-listing-page-was-cut-short-with-no-way-to-go-on)
  - [`NoSuchKey`, right after a put](#nosuchkey-right-after-a-put)
  - [`AccessDenied`](#accessdenied)
  - [`NoSuchBucket`](#nosuchbucket)
  - [`ConnectionRefused`](#connectionrefused)
- **Reading back**
  - [`verify on "app": no backup with that id (repository "local")`](#verify-on-app-no-backup-with-that-id-repository-local)
  - [`verify on "app": the manifest is larger than 64 MiB (repository "local")`](#verify-on-app-the-manifest-is-larger-than-64-mib-repository-local)
  - [`restore on "app": the manifest is not signed (repository "local")`](#restore-on-app-the-manifest-is-not-signed-repository-local)
  - [`restore on "app": no trusted key signed the manifest (repository "local")`](#restore-on-app-no-trusted-key-signed-the-manifest-repository-local)
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
  - [`list` shows fewer backups than a moment ago](#list-shows-fewer-backups-than-a-moment-ago)
  - [An id is in `unreadable`](#an-id-is-in-unreadable)
  - [Every backup made before signing is in `unreadable`](#every-backup-made-before-signing-is-in-unreadable)
  - [A backup that failed left objects in the repository](#a-backup-that-failed-left-objects-in-the-repository)
  - [A backup or a restore fails for lack of room](#a-backup-or-a-restore-fails-for-lack-of-room)
  - [The bucket bills for storage that `list` does not show](#the-bucket-bills-for-storage-that-list-does-not-show)

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

### `bindBackup: signing.key is not an Ed25519 private key (PEM, PKCS#8)`

**When:** `bindBackup`, with `signing` given.
**Why:** `signing.key` must be the text of an unencrypted Ed25519 private key
in PKCS#8 PEM, `-----BEGIN PRIVATE KEY-----`. The usual causes: the
**public** key given where the private one goes, an RSA or EC key, a
passphrase-protected PEM (`-----BEGIN ENCRYPTED PRIVATE KEY-----`, measured
on Bun 1.4.2: there is no option for the passphrase), a file path instead of
the file's text, or a variable that is unset or lost its line breaks. Node's
own error is dropped, so the key is never quoted and there is no `cause`.
**Fix:** read the PEM from a file, as written by `generateSigningKeys()` or
by `openssl genpkey -algorithm ed25519` (no `-aes256`).

```ts
signing: { key: await Bun.file('/etc/backup/signing.pem').text() }, // -----BEGIN PRIVATE KEY-----
```

To drop a passphrase from a key you already have:
`openssl pkey -in signing.enc.pem -out signing.pem`. The
[keys](guide/signing.md#keys) section has both halves.

### `bindBackup: trusted 0 is a private key; give its public key`

**When:** `bindBackup`; the number is the key's position in `trusted`.
**Why:** that entry holds `PRIVATE KEY` — a private key, encrypted or not,
where its public half goes. It is refused although its public half could be
derived: a reader holding the private key could also sign backups it then
trusts.
**Fix:** give readers the public key only, and keep the private one where
backups are made.

```sh
openssl pkey -in signing.pem -pubout -out signing.pub.pem # -----BEGIN PUBLIC KEY-----
```

```ts
trusted: [await Bun.file('/etc/backup/signing.pub.pem').text()],
```

### `bindBackup: trusted 0 is not an Ed25519 public key (PEM, SPKI)`

**When:** `bindBackup`; the number is the key's position in `trusted`.
**Why:** that entry is not the text of an Ed25519 public key in SPKI PEM,
`-----BEGIN PUBLIC KEY-----`: an RSA or EC key, an age recipient (`age1…`)
given where a signing key goes, a file path instead of the file's text, or a
variable that is unset or lost its line breaks. The key is never quoted.
**Fix:** the public half of the signing key, read from its file.

```ts
bindBackup(uploads, {
	repositories,
	recipients,
	trusted: [await Bun.file('/etc/backup/signing.pub.pem').text()], // -----BEGIN PUBLIC KEY-----
});
```

`generateSigningKeys()` returns it as `publicKey`;
`openssl pkey -in signing.pem -pubout` derives it from the private key.

### `bindBackup: trusted must list at least one public key`

**When:** `bindBackup`, with `trusted` that is empty or not an array —
usually a list built from configuration that came out empty. The types
refuse a literal `trusted: []`.
**Why:** an empty list would trust nothing, and read nothing. "No check" is
said by leaving `trusted` out, not by an empty list.
**Fix:** fail with a message of your own that names the setting — the list
came from somewhere.

```ts
const files = (process.env.BACKUP_TRUSTED_FILES ?? '').split(',').filter(Boolean);
const [first, ...rest] = await Promise.all(files.map((file) => Bun.file(file).text()));
if (first === undefined) throw new Error('BACKUP_TRUSTED_FILES names no public key');

bindBackup(uploads, { repositories, recipients, trusted: [first, ...rest] });
```

Leaving `trusted` out instead turns the check off, so a forged backup reads
like a signed one:
[without `signing` or `trusted`](guide/signing.md#without-signing-or-trusted).

### `bindBackup: trusted does not hold the public key of signing.key, so this backup could not read what it writes`

**When:** `bindBackup`, with both `signing` and `trusted` given.
**Why:** a writer is also a reader: its `list`, `verify` and `restore` check
against `trusted`, so without its own public key there, every backup it made
would come back `SIGNATURE`. Usually the key pair was changed on one side
only, or `trusted` holds another host's key.
**Fix:** add the writer's public key to `trusted` — or leave `trusted` out,
and it is derived from `signing.key`.

```ts
bindBackup(uploads, {
	repositories,
	recipients,
	signing: { key: privateKey },
	trusted: [previousPublicKey, publicKey], // publicKey is signing.key's own half
});
```

[Changing the signing key](guide/signing.md#changing-the-signing-key) gives
the order to do it in.

### `bindBackup: lock.lease must be a whole number of milliseconds, from 1 second to 1 day`

**When:** `bindBackup`, with a `lock.lease` under 1000, over 86 400 000, or
not an integer — often seconds given where milliseconds are expected, or a
value read from the environment that came out `NaN`.
**Why:** the lease is how long a lock lasts unless renewed, and how much
longer another writer still respects it once it is past its end. Under a
second, renewal could not keep up; over a day, a crashed run would block the
next ones for two days.
**Fix:**

```ts
bindBackup(definition, { repositories, recipients, lock: { lease: 15 * 60 * 1000 } }); // 15 minutes
```

Leave `lock` out for the default, 5 minutes.

### `localRepository: path must be an absolute path`

**When:** `localRepository({ path })`.
**Fix:**

```ts
import { resolve } from 'node:path';

localRepository({ path: resolve('backups') });
```

### `s3Repository: prefix must be a relative path of plain segments`

**When:** `s3Repository({ client, prefix })`, with a `prefix` that starts or
ends with `/`, holds an empty, `.` or `..` segment — `/backups`, `backups/`,
`a//b`, `../x` — or a character outside `A–Z a–z 0–9 . _ -` in a segment (a
space, an accent). The prefix is not quoted.
**Why:** the prefix is the folder every key goes under, joined with a `/` of
its own; a key built from it must stay a plain relative path, as for a
[key](#s3-repository-a-key-is-not-a-relative-path).
**Fix:** segments only, without the slashes around them — or no `prefix`.

```ts
import { S3Client } from 'bun';
import { s3Repository } from '@nxgt/backup';

s3Repository({ client: new S3Client({ bucket: 'my-backups' }), prefix: 'nightly/eu' }); // not '/nightly/eu/'
```

### `s3Repository: partSize must be 5 MiB at least`

**When:** `s3Repository({ client, partSize })`, with a `partSize` under
5 MiB (5,242,880 bytes) or not a whole number — often a value given in MiB
where bytes are meant.
**Why:** an object over 64 MiB is uploaded in parts, and S3 refuses a part
under 5 MiB except the last. The default is 16 MiB. S3 also takes at most
10,000 parts, so `partSize` sets the largest object a repository can take:
about 156 GiB at 16 MiB.
**Fix:** a size in bytes.

```ts
s3Repository({ client, partSize: 64 * 1024 * 1024 }); // 64 MiB, for objects up to about 625 GiB
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

### `create on "app": trusted keys are set but no signing key, so this backup could not read what it writes`

**When:** `create`, on a binding given `trusted` and no `signing`. Nothing
is read from the source, and nothing is written.
**Why:** a binding with `trusted` and no `signing` is a reader: it requires a
signature on every manifest, and has no key to make one. A backup it created
would be unsigned, and so `SIGNATURE` for itself and for every other reader.
**Fix:** create from a binding that has `signing` — on the host that makes
backups — and keep `trusted` alone for readers.

```ts
const writer = bindBackup(uploads, {
	repositories,
	recipients,
	signing: { key: await Bun.file('/etc/backup/signing.pem').text() },
});
await writer.create(directorySource({ path: '/srv/uploads' }));
```

`trusted` may be left out on the writer: it defaults to `signing.key`'s
public half ([options](guide/signing.md#options)).

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

### `create on "app": another create or prune holds the lock (repository "local")`

**Code:** `LOCKED`, in that repository's outcome — so `create` rejects with
`PARTIAL` if another repository took the backup, `NOT_STORED` if none did.
**When:** `create`, at the start, before any of the backup is written to
that repository; its own lock file is put, then removed.
**Why:** `create` takes a lock in every repository it writes to, at
`<backup>/locks/<id>.json`, and gives a repository up when another live lock
is there. That lock is one of:

- **another run, still going** — a scheduled job that started again before
  the last one finished, or the same backup run from two machines;
- **a run that crashed, and whose lock is not stale yet** — a lock is
  respected until its `expiresAt` plus one whole lease, for clocks that
  disagree: up to two leases after the crash, 10 minutes by default;
- **a file that does not read as a lock** — truncated, edited, or written by
  something else. Nothing says when it ends, so it is held **for ever**,
  until removed by hand;
- **a second run started at the same moment** — each writes its own lock
  before looking for others, so both can see the other's and both give up.
  Never both go on.

**Fix:** space the schedule so a run ends before the next starts, and treat
`LOCKED` as "skipped, try later" rather than as a failure:

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.create(source);
} catch (error) {
	if (!(error instanceof BackupError) || error.outcomes.length === 0) throw error;
	for (const outcome of error.outcomes) {
		const locked = outcome.error instanceof BackupError && outcome.error.code === 'LOCKED';
		if (!outcome.stored) console.error(outcome.repository, locked ? 'locked, retry later' : outcome.error);
	}
}
```

A `LEASE_LOST` is not this: that run held the lock and lost it — see
[the lock's lease ran out](#create-on-app-the-locks-lease-ran-out-before-it-was-done-repository-local).

If it persists with no run going, look at the locks. In a local folder:

```sh
ls /mnt/backups/app/locks/
cat /mnt/backups/app/locks/*.json # format, id, operation, expiresAt
```

In an S3 bucket, under the repository's `prefix`:

```sh
aws s3 ls s3://my-backups/nightly/app/locks/
aws s3 cp s3://my-backups/nightly/app/locks/<id>.json -
```

A lock with an `expiresAt` in the past clears itself one lease later. One
that does not parse as JSON with those four fields never does: once you are
sure no run is going, remove it (`rm`, or `aws s3 rm`).

### `create on "app": the lock's lease ran out before it was done (repository "local")`

**Code:** `LEASE_LOST`, in that repository's outcome — so `create` rejects
with `PARTIAL` if another repository took the backup, `NOT_STORED` if none
did. The other repositories go on. `error.id` is the backup's id.
**When:** `create`, partway through a long run.
**Why:** the lock is renewed every third of its lease, and before each `put`
the writer checks the lease has not run out — past it, another writer may
already have taken the lock. It ran out because the renewals failed — the
store unreachable for the lock's own writes — or because the process was
paused longer than the lease: a suspended laptop, a stopped container, a long
garbage-collection stall. The writer measures that on its own monotonic
clock, so a wall clock stepped back does not stretch it. From then on it
started nothing more in that repository and no new renewal; a `put` or a
renewal already under way may still have landed after. The lock was removed at the
end, and the repository has no manifest for that id: the backup does not
exist there.
**Fix:** unlike `LOCKED`, this is worth an alert, not just a retry: find out
why the store dropped out or the process stalled. If the store is known to
drop out for minutes at a time, a longer lease rides it out:

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.create(source);
} catch (error) {
	if (!(error instanceof BackupError)) throw error;
	for (const outcome of error.outcomes) {
		if (outcome.stored || !(outcome.error instanceof BackupError)) continue;
		if (outcome.error.code === 'LEASE_LOST') console.error('lease lost in', outcome.repository); // alert
	}
	throw error;
}

// and, for a store that drops out for minutes:
bindBackup(definition, { repositories, recipients, lock: { lease: 30 * 60 * 1000 } });
```

A longer lease also means a crashed run blocks the next ones longer — up to
two leases. The objects put before the lease ran out stay; see
[a backup that failed left objects in the repository](#a-backup-that-failed-left-objects-in-the-repository).

### `create on "app": the manifest would be larger than 64 MiB; split the source into several backups`

**When:** `create`, at the end, with a source of very many entries — 64 MiB
of manifest is about half a million. A bare `TypeError`, not a
`BackupError`.
**Why:** the manifest lists every object, and a reader refuses one over
64 MiB ([the manifest is larger than 64 MiB](#verify-on-app-the-manifest-is-larger-than-64-mib-repository-local)),
so it is not written. It is checked once the objects and the catalog are
stored: they stay in every repository without a manifest, as for any failed
`create` — no call sees them
([a backup that failed left objects](#a-backup-that-failed-left-objects-in-the-repository)).
**Fix:** split the source into several backups, one definition each.

```ts
const avatars = bindBackup(defineBackup({ name: 'uploads-avatars' }), options);
const documents = bindBackup(defineBackup({ name: 'uploads-documents' }), options);

await avatars.create(directorySource({ path: '/srv/uploads/avatars' }));
await documents.create(directorySource({ path: '/srv/uploads/documents' }));
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

### `s3 repository: a key is not a relative path`

**When:** calling an `s3Repository`'s methods yourself with a key (or a
`list` prefix, less its trailing `/`) that
starts with `/`, holds an empty, `.` or `..` segment, or has a segment with a
character outside `A–Z a–z 0–9 . _ -`. Thrown before the bucket is asked. A
backup never builds such a key.
**Why:** a key is joined to the `prefix` as it is; one that could climb out of
it, or that S3 would store under a name no other repository could hold, is
refused.
**Fix:** as for `localRepository`, build keys as the
[Repository contract](guide/repositories.md#writing-a-repository) does.

```ts
await repository.get('uploads/20261003T221500123Z-9f3a61c0/0.age'); // not '/uploads/…' nor 'uploads//…'
```

### `s3 repository: an object was not stored whole`

**When:** `create`, inside an outcome: the create rejects with `PARTIAL`
([stored in 1 of 2](#create-on-app-stored-in-1-of-2-repositories)), or
`NOT_STORED` when that bucket was the only repository
([stored in 0 of 1](#create-on-app-stored-in-0-of-1-repositories)).
**Why:** every `put` reads the stored object's size back before it resolves,
and the bucket holds a size other than the file's: the store, or something
between it and you — a proxy, a gateway — kept a different body than the one
sent. That repository is left out from then on, and gets no manifest, so the
backup is not stored there.
**Fix:** find what in front of the store alters a body, then run the next
backup and verify it from that repository.

```ts
const { id } = await backups.create(source); // the next run, once the cause is found
await backups.verify(id, { from: 's3' });
```

### `s3 repository: a listing page was cut short with no way to go on`

**When:** `list` — or `verify` and `restore` reading through it — on an
`s3Repository`, when the store answers a page of keys marked as truncated
and gives no continuation token to ask for the next one.
**Why:** stopping there would return a listing that looks whole and is
not: backups missing from `list`, and later from rotation. The store, or a
proxy in front of it, broke S3's paging contract.
**Fix:** nothing in your code. Check the endpoint is an S3 API and not a
cache or a gateway that rewrites listings, then retry; on a store that does
this every time, report it to its maintainers.

```ts
// Ask the store for one key: a page marked truncated must carry a token.
const page = await client.list({ maxKeys: 1 });
if (page.isTruncated && !page.nextContinuationToken) {
	console.error('this endpoint breaks S3 paging');
}
```

### `NoSuchKey`, right after a put

**When:** `create`, inside an outcome — `outcome.error.code` is `NoSuchKey` —
for a write the client had reported as done. The create rejects with
`PARTIAL` or `NOT_STORED`.
**Why:** the store answered the upload, and holds nothing under that key: the
read-back of the size found no object. It is caught there rather than on the
day of a restore. Once, against a store that had just stopped, the upload's
end resolved anyway.
**Fix:** check that the store is up and that its disks and quota have room,
then run the backup again and verify it from that repository.

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.create(source);
} catch (error) {
	if (!(error instanceof BackupError)) throw error;
	for (const outcome of error.outcomes) {
		if (!outcome.stored) console.error(outcome.repository, (outcome.error as { code?: string }).code);
	}
}
```

These codes, and the three below, are Bun's: the error is an `S3Error`, with
the store's code in `code`, passed on as it is. The message is the store's
own, and varies with it.

### `AccessDenied`

**When:** `create`, inside an outcome; or `list`, `verify` or `restore` from
that repository, as their rejection.
**Why:** the credentials the `S3Client` was given lack a permission the call
needs. A writer puts, reads back, lists and deletes (a failed large upload is
deleted); a reader reads and lists.
**Fix:** grant, on the bucket and the prefix:

| Binding | Actions |
| --- | --- |
| a writer (`create`) | `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `s3:DeleteObject` |
| a reader (`list`, `verify`, `restore`) | `s3:GetObject`, `s3:ListBucket` |

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
			"Resource": "arn:aws:s3:::my-backups/nightly/*"
		},
		{
			"Effect": "Allow",
			"Action": "s3:ListBucket",
			"Resource": "arn:aws:s3:::my-backups",
			"Condition": { "StringLike": { "s3:prefix": "nightly/*" } }
		}
	]
}
```

`s3:ListBucket` applies to the bucket, not to its objects, hence the second
statement.

### `NoSuchBucket`

**When:** the first call that reaches the store — usually `create`, inside
every outcome for that repository.
**Why:** the bucket the `S3Client` names does not exist at that endpoint: a
misspelt name, an environment variable unset or meant for another
environment, or a bucket created at another endpoint. This package never
creates a bucket.
**Fix:** create the bucket, and check what the client was given.

```ts
import { S3Client } from 'bun';

const client = new S3Client({
	bucket: process.env.S3_BUCKET as string,
	endpoint: process.env.S3_ENDPOINT as string,
	accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
	secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
});
```

### `ConnectionRefused`

**When:** any call to that repository, as soon as it is made — measured on
Bun 1.4.2: an `S3Error` whose `code` is `ConnectionRefused`.
**Why:** nothing listens at the client's endpoint: the store is down, the
port or host is wrong, or a scheme (`http`/`https`) mismatch. With other
repositories beside it, `create` stores the backup there and rejects with
`PARTIAL`.
**Fix:** check the endpoint the client was given, and that the store is up,
before the job starts.

```ts
await client.list({ maxKeys: 1 }); // fails here, early, rather than inside an outcome
```

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

### `verify on "app": the manifest is larger than 64 MiB (repository "local")`

**Code:** `INTEGRITY`. In `list`, the id is in `unreadable` instead.
**When:** `verify` or `restore`, before the signature or anything else is
checked.
**Why:** a repository is not trusted with the manifest's size: at most
64 MiB and one byte of it are read, and a larger one is refused. This
package never writes one that large
([`create` refuses to](#create-on-app-the-manifest-would-be-larger-than-64-mib-split-the-source-into-several-backups)),
so the file was replaced or grown by something else.
**Fix:** another repository's copy, and a look at who can write to this one.

```ts
await backups.verify(id, { from: 'nas' });
```

### `restore on "app": the manifest is not signed (repository "local")`

**Code:** `SIGNATURE`. In `list`, the id is in `unreadable` instead.
**When:** `verify` or `restore`, from a reader with `trusted` keys — given,
or derived from `signing`. Checked before the manifest is parsed and before
any other object is read, so nothing lands in the target.
**Why:** the backup has a `manifest.json` and no `manifest.sig`. Most often
it was made before signing was on — by 0.1, or by a writer without
`signing` — see
[every backup made before signing](#every-backup-made-before-signing-is-in-unreadable).
Otherwise, someone with write access to the repository put a backup of their
own there, or the signature was deleted.
**Fix:** for a backup you know predates signing, read it with a reader that
has no `trusted`; for any other, do not restore it, and find out who wrote
it.

```ts
import { BackupError } from '@nxgt/backup';

try {
	await reader.restore(id, target, { identities });
} catch (error) {
	if (error instanceof BackupError && error.code === 'SIGNATURE') {
		console.error(error.message, error.id, error.repository);
	}
	throw error;
}
```

[Reading](guide/signing.md#reading-list-verify-restore) has what is checked,
and in which order.

### `restore on "app": no trusted key signed the manifest (repository "local")`

**Code:** `SIGNATURE`. In `list`, the id is in `unreadable` instead.
**When:** `verify` or `restore`, from a reader with `trusted` keys; nothing
lands in the target.
**Why:** there is a `manifest.sig`, and none of the `trusted` keys made it
over these exact bytes: the backup was signed with another key — the key
was changed and the reader does not have the new public key, or still lacks
the old one for older backups — or the manifest was edited after it was
signed, even by one byte, or a signature was copied in from another backup.
**Fix:** check which key signed it with OpenSSL 3, then give the reader that
public key beside the current one if it is yours.

```sh
openssl pkeyutl -verify -pubin -inkey signing.pub.pem -rawin \
  -in manifest.json -sigfile manifest.sig
```

```ts
trusted: [oldPublicKey, newPublicKey],
```

The signature covers the manifest's whole content, which names the backup
and the id: a signed manifest and its signature moved together under another
id pass this check and fail the next one,
[the manifest is another backup’s](#verify-on-app-the-manifest-is-another-backups-repository-local)
(`INTEGRITY`). It says nothing about freshness, though: someone with write
access can still delete a backup, or put back an older, genuinely signed
one.

If no key of yours verifies it, treat the backup as forged or tampered with:
restore from another repository's copy. See
[checking a signature by hand](guide/signing.md#checking-a-signature-by-hand)
(macOS's own `openssl` cannot) and
[changing the signing key](guide/signing.md#changing-the-signing-key).

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
replaced it, even with a valid age file written to your public key. A
repository that sends **more** bytes than the manifest's size is cut at that
size: the read stops there, and `tmpDir` never holds more than the object
should. That holds for every repository — local, S3, or one of your own.
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

### `list` shows fewer backups than a moment ago

**When:** `list`, while backups of the same definition are being removed —
by a prune (rotation, [on the roadmap](roadmap.md#next)) or by hand.
**Why:** a backup whose manifest disappears between `list`'s listing of the
repository and its read of that manifest was removed meanwhile; `list` leaves
it out rather than failing, with no error and nothing in `unreadable`.
`list` takes no lock, so it never waits for a writer.
**Fix:** nothing is wrong. An id that went missing was removed; `verify`
says so:

```ts
import { BackupError } from '@nxgt/backup';

const removed = await backups.verify(id).then(
	() => false,
	(error) => error instanceof BackupError && error.code === 'NOT_FOUND',
);
```

### An id is in `unreadable`

**Why:** its manifest is there and does not read as one this version wrote,
or is over 64 MiB — or, for a reader with `trusted` keys, it has no
signature, or one no trusted key made. Size is checked first, then the
signature, then the content.
**Fix:** `verify` it for the reason, then see
[the manifest is not signed](#restore-on-app-the-manifest-is-not-signed-repository-local),
[no trusted key signed the manifest](#restore-on-app-no-trusted-key-signed-the-manifest-repository-local),
[the manifest is unreadable](#verify-on-app-the-manifest-is-unreadable--repository-local)
or [larger than 64 MiB](#verify-on-app-the-manifest-is-larger-than-64-mib-repository-local).

```ts
const { unreadable } = await backups.list();
for (const id of unreadable) await backups.verify(id).catch((error) => console.error(error.message));
```

### Every backup made before signing is in `unreadable`

**When:** `list`, after `trusted` — or `signing`, which implies it — was
given to a `bindBackup` reading a repository that holds backups made by 0.1,
or by 0.2 without `signing`. `verify` and `restore` on those ids reject with
[the manifest is not signed](#restore-on-app-the-manifest-is-not-signed-repository-local).
**Why:** they have no `manifest.sig`, and a reader with `trusted` keys reads
only a signed manifest. Nothing is signed after the fact.
**Fix:** keep a second binding without `trusted`, for those ids only, until
the last of them has expired — it trusts whatever the repository holds — or
re-make them with `signing` on.

```ts
const signedOnly = bindBackup(uploads, { repositories, recipients, trusted: [publicKey] });
const unsigned = bindBackup(uploads, { repositories, recipients }); // ids made before the switch only

const { unreadable } = await signedOnly.list();
for (const id of unreadable) await unsigned.verify(id); // reads them, without a signature check
```

[Upgrading](upgrading.md#backups-made-before-signing-was-on) weighs the two.

### A backup that failed left objects in the repository

**When:** after a `create` that rejected — a source that threw, the process
killed, a lease that ran out, `PARTIAL` for the repository that failed.
**Why:** objects go first and the manifest last, so a run that stopped holds
objects under `<backup>/<id>/` and no `manifest.json`. No call sees them, and
this version does not remove them.
**Fix:** cleaning up incomplete backups is [on the roadmap](roadmap.md#next).
Until then, a folder `<backup>/<id>/` — named like a backup id,
`20261003T221500123Z-9f3a61c0` — with no `manifest.json` and older than your
longest run can be removed by hand. **Never `<backup>/locks/`**: it holds no
manifest either, and removing it while a `create` runs lets a second writer
in. A single stale lock file is removed as
[locking](guide/locking.md#after-a-crash) says.

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

### The bucket bills for storage that `list` does not show

**When:** an `s3Repository` that took objects over 64 MiB, after a `create`
that stopped partway through one — the process killed, the connection lost
during a part.
**Why:** an object over 64 MiB is uploaded in parts, and S3 keeps the parts
of an upload that was never completed. They are no object: no listing shows
them, `list` included, and the bucket still bills for them. Objects up to
64 MiB go in one PUT and leave nothing behind.
**Fix:** a lifecycle rule that aborts incomplete uploads after a day.

```json
{
	"Rules": [
		{
			"ID": "abort-incomplete-multipart-uploads",
			"Status": "Enabled",
			"Filter": { "Prefix": "" },
			"AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
		}
	]
}
```

```sh
aws s3api put-bucket-lifecycle-configuration --bucket my-backups --lifecycle-configuration file://lifecycle.json
aws s3api list-multipart-uploads --bucket my-backups # what is pending now
```

Most S3-compatible stores take the same rule; check that yours does.
