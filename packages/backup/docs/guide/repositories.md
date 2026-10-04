# Repositories

This page covers where backups are kept: the two repositories that ship —
a local folder and an S3 bucket — writing to several at once, and the
`Repository` contract for writing your own.

```ts
import { bindBackup, defineBackup, directorySource, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [
		localRepository({ path: '/mnt/backups', name: 'disk' }),
		localRepository({ path: '/mnt/nas/backups', name: 'nas' }),
	],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const created = await backups.create(directorySource({ path: '/srv/uploads' }));
// created.outcomes: [{ repository: 'disk', stored: true }, { repository: 'nas', stored: true }]
```

## `localRepository`

A repository in a local folder — a disk, a mounted volume, a network share.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `path` | `string` | required | the folder backups are kept in, as an absolute path. Created on the first write |
| `name` | `string` | `'local'` | how it is named in `outcomes`, in errors, and in `from`. Two repositories bound together need different names |

```ts
interface LocalRepositoryOptions {
	path: string;
	name?: string | undefined;
}

function localRepository(options: LocalRepositoryOptions): Repository;
```

```ts
localRepository({ path: 'backups' });
// TypeError: localRepository: path must be an absolute path
```

Use `import.meta.dir` or `path.resolve` to build one from a relative path.

### How it writes

Each `put` is crash-safe:

1. copies the staged file to `<key>.partial-<random>` beside its place;
2. syncs that file to disk;
3. renames it into place;
4. syncs the folder, so the rename itself survives a power cut.

A crash leaves the old bytes or the new ones, never part of them, and a
failed `put` removes its partial file. A file whose name holds `.partial-` is
never listed nor read, which is why `defineBackup` refuses a name holding
`.partial-`.

A key that is absolute, holds `..`, `.`, an empty segment or `.partial-`, or
has a segment with a character outside `A–Z a–z 0–9 . _ -` is refused with a
`TypeError`. `list` walks one folder at a time and never follows a symbolic
link; each folder `put` has to create is synced in its parent, so a crash
cannot take back the folder of a write that resolved. Keys are built by this package, so you see
it only if you call the repository yourself. Listing a folder that does not
exist yet gives nothing, not an error.

On a network share, the syncs are only as good as the share's own: a mount
that acknowledges a write before it is stored makes no promise this package
can keep.

## `s3Repository`

A repository in an S3 bucket — AWS, or any S3-compatible store — through
Bun's own `S3Client`. You build the client, with its bucket, endpoint and
credentials; the repository only uses it, so the credentials stay with you
and nothing here reads or prints them.

```ts
import { S3Client } from 'bun';
import { bindBackup, defineBackup, directorySource, s3Repository } from '@nxgt/backup';

const client = new S3Client({
	bucket: 'backups',
	endpoint: process.env.S3_ENDPOINT as string, // leave it out for AWS
	region: process.env.S3_REGION as string,
	accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
	secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
});

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [s3Repository({ client, prefix: 'nightly' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	tmpDir: '/var/tmp',
});

const created = await backups.create(directorySource({ path: '/srv/uploads' }));
// in the bucket: nightly/uploads/<id>/0.age, …, catalog.age, manifest.json
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `client` | `S3Client` (from `bun`) | required | the bucket, its endpoint and its credentials. Every key is written and read through it |
| `prefix` | `string` | none | a folder in the bucket every key goes under: `nightly`, `backups/eu`. Plain segments of letters, digits, `.`, `_` and `-`, separated by `/` — no leading or trailing `/`, no empty, `.` or `..` segment |
| `name` | `string` | `'s3'` | how it is named in `outcomes`, in errors, and in `from`. Two repositories bound together need different names. **Never a credential, nor an endpoint URL that holds one** — it is in every error message |
| `partSize` | `number` | `16 * 1024 * 1024` (16 MiB) | the part size of a multipart upload, used for an object over 64 MiB. An integer of 5 MiB at least, as S3 requires. S3 takes at most 10 000 parts, so the default stores an object of up to about 156 GiB; raise it for a larger entry |

```ts
interface S3RepositoryOptions {
	client: S3Client;
	prefix?: string | undefined;
	name?: string | undefined;
	partSize?: number | undefined;
}

function s3Repository(options: S3RepositoryOptions): Repository;
```

What could never work is a bare `TypeError` when you call it, and quotes
nothing you gave:

```ts
s3Repository({ client, prefix: '../backups' });
// TypeError: s3Repository: prefix must be a relative path of plain segments

s3Repository({ client, partSize: 1024 * 1024 });
// TypeError: s3Repository: partSize must be 5 MiB at least
```

The client itself is not checked here — a wrong bucket or a bad key shows up
at the first call, as Bun's `S3Error`.

### How it writes

Each `put` stores the object whole or not at all, then checks it:

- **Up to 64 MiB, one `PUT`**, from the staged file's bytes. S3 makes such
  an object visible whole or not at all. The bytes are read into memory for
  it: measured on Bun 1.4.2, a 64 MiB object cost about 67 MB of RSS.
- **Above 64 MiB, a multipart upload** through Bun's
  `client.file(key).writer({ partSize })`, one part read from disk at a time
  and each one sent before the next is read — measured at +80 MB of RSS for
  a 256 MiB object with the default 16 MiB parts; memory grows with
  `partSize`, not with the object. S3 shows the object only once the upload
  completes with every part.
- **Then the stored size is read back** with `stat`, before `put` resolves.
  A size that differs rejects with
  `s3 repository: an object was not stored whole`; an object that is not
  there at all rejects with Bun's `S3Error`, code `NoSuchKey`. A write the
  store reported and did not keep is caught at backup time, not on the day
  of a restore.

Either rejection lands in that repository's outcome — `create` goes on with
the others and ends with `PARTIAL` or `NOT_STORED`, as for any repository
([below](#several-repositories)):

```ts
// error.outcomes, when the bucket did not keep an object:
[
	{ repository: 'local', stored: true },
	{ repository: 's3', stored: false, error: /* S3Error, code 'NoSuchKey' */ },
]
```

A large upload the store refuses is retried by Bun, then aborted by Bun, and
`put` rejects. One whose staged file cannot be read half-way has no abort to
call: ending Bun's writer completes the upload with the parts it had, so the
repository deletes that object straight after. For that moment the key holds
part of an object — a key no manifest names, since the manifest goes last and
only to a repository that took everything.

### Abandoned uploads: add a lifecycle rule

A multipart upload that never completes — the process killed mid-upload,
the machine lost — leaves its parts in the bucket. They are not objects: no
listing shows them, this package cannot see nor remove them, and the store
bills for them until they are aborted. Give the bucket a lifecycle rule that
aborts incomplete multipart uploads, after a day for example:

```json
{
	"Rules": [
		{
			"ID": "abort-incomplete-uploads",
			"Status": "Enabled",
			"Filter": { "Prefix": "" },
			"AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
		}
	]
}
```

```sh
aws s3api put-bucket-lifecycle-configuration --bucket backups \
	--lifecycle-configuration file://lifecycle.json
```

On an S3-compatible store, check that it supports the rule, and set it in
that store's own way otherwise. Objects up to 64 MiB never go in parts, so a
backup whose every object is that size or smaller leaves none.

### How it reads

- `get` starts the download and reads its first chunk: a key that is not
  there gives `undefined` — no `HEAD` first, so no extra round trip, and no
  window in which an object deleted between the two calls fails the stream
  instead. Any other error, such as `AccessDenied`, is Bun's `S3Error`, as
  it is.
- `list` follows the listing page after page, so a prefix holding more than
  1000 keys is listed whole.
- Every object read is cut as soon as it runs past the size its manifest
  gives, whatever the repository — a bucket someone else can write to cannot
  fill `tmpDir`.
- A key — or a `list` prefix, less its trailing `/` — that is not a relative
  path of plain segments is refused with
  `TypeError: s3 repository: a key is not a relative path`. Keys are built by
  this package, so you see it only if you call the repository yourself.

### What the credentials need

The host that runs `create` needs `s3:PutObject` (one `PUT` and multipart
uploads alike), `s3:GetObject` (to read the size back, and for its own
`list`, `verify` and `restore`), `s3:ListBucket`, and `s3:DeleteObject` (to
remove a failed large upload, and for rotation when it comes). The
[lock](locking.md) uses the same four: put, list and read under
`<backup>/locks/`, then delete. A host that only lists, verifies or restores
takes no lock, and needs `s3:GetObject` and `s3:ListBucket`.

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
			"Resource": "arn:aws:s3:::backups/nightly/*"
		},
		{
			"Effect": "Allow",
			"Action": "s3:ListBucket",
			"Resource": "arn:aws:s3:::backups",
			"Condition": { "StringLike": { "s3:prefix": "nightly/*" } }
		}
	]
}
```

Credentials that can delete can also remove backups; append-only storage is
on the [roadmap](../roadmap.md).

### Why not `write(key, Bun.file(path))`

It is the obvious call, and it is not used: measured on Bun 1.4.2 against an
S3-compatible store, it held about 700 MB of RSS more for a 256 MiB file.
Feeding Bun's writer the chunks of `Bun.file(path).stream()` held as much,
flushed or not; one `slice` of `partSize` at a time, each flushed, held
+80 MB. Keep it in mind if you write your own repository on Bun's
`S3Client`.

### Beside a local folder

Bound together, each repository has its own outcome, and every read names
the one it reads from:

```ts
import { S3Client } from 'bun';
import {
	BackupError,
	bindBackup,
	defineBackup,
	directorySource,
	localRepository,
	s3Repository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [
		localRepository({ path: '/mnt/backups' }), // 'local'
		s3Repository({ client: new S3Client({ bucket: 'backups' }), prefix: 'nightly' }), // 's3'
	],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	tmpDir: '/var/tmp',
	signing: { key: await Bun.file('/etc/backup/signing.pem').text() },
});

try {
	const created = await backups.create(directorySource({ path: '/srv/uploads' }));
	// created.outcomes: [{ repository: 'local', stored: true }, { repository: 's3', stored: true }]
	await backups.verify(created.id, { from: 's3' }); // reads the bucket back, no key
} catch (error) {
	if (error instanceof BackupError && error.code === 'PARTIAL') {
		console.error(error.message, error.outcomes.filter((outcome) => !outcome.stored));
		process.exit(2);
	}
	throw error;
}

const { backups: held } = await backups.list({ from: 's3' });
```

`new S3Client({ bucket })` alone takes its endpoint, region and credentials
from the environment, as Bun documents: `S3_ENDPOINT`, `S3_REGION`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, or their `AWS_` forms.

## Several repositories

Give `bindBackup` more than one and `create` writes to every one of them at
once:

- **Each object goes to every repository still in the run**, in parallel,
  and the next object starts when all of them have taken it. The object is
  staged once in `tmpDir`, whatever the number of repositories.
- **A repository that fails is left out from then on**: the others go on, and
  it is sent nothing more.
- **The manifest goes only where everything landed** — and, with `signing`,
  its signature just before it, the same way. A repository that missed one
  object, or the signature, never gets a manifest, so it holds no backup —
  only objects nobody lists.
- **When every repository has failed, the source is not read further**: there
  is nowhere left to put it.
- **Each repository has its own [lock](locking.md)**: one whose lock another
  `create` holds fails at the start with `LOCKED` in its outcome, and the
  others go on. When all of them are locked, the source is not opened. One
  whose lease runs out part-way fails with `LEASE_LOST`, and is sent nothing
  more from then on.

`create` resolves only when every repository holds the backup. Otherwise:

| Code | When | `error.outcomes` | `error.id` |
| --- | --- | --- | --- |
| `PARTIAL` | some repositories hold it, some do not | one per repository, in the order given | the backup's id: the copies that were stored are complete, and stay |
| `NOT_STORED` | none holds it | one per repository, each with its error | the id it would have had |

```ts
type RepositoryOutcome =
	| { repository: string; stored: true }
	| { repository: string; stored: false; error: unknown }; // the repository's own error, as it threw it
```

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.create(directorySource({ path: '/srv/uploads' }));
} catch (error) {
	if (error instanceof BackupError && error.code === 'PARTIAL' && error.id) {
		for (const outcome of error.outcomes) {
			if (!outcome.stored) console.error(`${outcome.repository}:`, outcome.error);
		}
		// The stored copies are whole: check one.
		const stored = error.outcomes.find((outcome) => outcome.stored);
		if (stored) await backups.verify(error.id, { from: stored.repository });
	} else {
		throw error;
	}
}
```

`outcome.error` is whatever the repository threw — for `localRepository`,
Node's file errors (`ENOSPC`, `EACCES`, …); for `s3Repository`, Bun's
`S3Error` (`AccessDenied`, `NoSuchKey`, …) or
`s3 repository: an object was not stored whole`. Log it with care: a repository
you wrote decides what its errors hold.

**Reads use one repository**: `list`, `verify` and `restore` read from the
first one given unless told `from`, by name. They never fall back to another
on their own, so a failure always names the repository it came from.

```ts
await backups.list({ from: 'nas' });
await backups.verify(id, { from: 'nas' });
await backups.restore(id, target, { identities, from: 'nas' });
```

## Writing a repository

A repository is four methods and a name. Keys are relative, `/`-separated
paths that this package builds — `uploads/20261003T221500123Z-9f3a61c0/0.age`
— and a repository stores the bytes it is given under them, as they are.

```ts
interface Repository {
	readonly name: string;
	put(key: string, file: string): Promise<void>;
	get(key: string): Promise<ReadableStream<Uint8Array> | undefined>;
	list(prefix: string): AsyncIterable<string>;
	delete(key: string): Promise<void>;
}
```

| Member | What the rest of the package relies on |
| --- | --- |
| `name` | how it is named in outcomes, errors and `from`: `local`, `s3`, or what you choose. **Never a credential, nor a URL that holds one** — it is in every error message |
| `put(key, file)` | stores the local file at `file` under `key`, **whole or not at all**: a key is never visible holding part of its bytes, and once it resolves the bytes are as durable as the store makes them. Overwrites. The file is removed once every repository has resolved, so read it **before** resolving |
| `get(key)` | the bytes under `key`, or `undefined` when there are none. `undefined` for the manifest is `NOT_FOUND`; for `manifest.sig`, when `trusted` keys are set, `SIGNATURE`; for an object, `INTEGRITY`. The package reads no more than 65 bytes of `manifest.sig` and 64 MiB and one byte of a manifest, and stops reading an object as soon as it runs past the size its manifest gives — so a repository that sends more cannot fill `tmpDir`. It cancels the rest of the stream |
| `list(prefix)` | every key that starts with `prefix`, in any order, keys of writes in progress left out — and **every key whose `put` has resolved**, from that moment on: the [lock](locking.md#how-it-works) is safe only on a store that does this, and a listing that lags behind writes would let two writers in. A local folder and AWS S3 do; SeaweedFS's S3 gateway is covered by the package's own spec. The package lists `<backup>/` and keeps the keys that end in `/manifest.json`, and `<backup>/locks/` for the lock |
| `delete(key)` | removes `key`; one that is not there is not an error. From 0.4, `create` calls it to remove its lock, and a stale one; rotation and clean-up will too. One that throws does not fail the run: the lock it left goes stale on its own |

Whole-or-nothing is the one rule that matters: the manifest is how a backup
comes to exist, so a manifest visible half-written would be a backup that
reads as `unreadable`, and a half-written object one that fails `INTEGRITY`.
Write to a temporary key and rename, or use a store whose writes are atomic
by nature, as an object store's single `PUT` is.

`put` can be called for several keys at once — two `create`s running
together, say — so it must not assume it has the store to itself.

An in-memory repository, for specs:

```ts
import type { Repository } from '@nxgt/backup';

export function memoryRepository(name = 'memory'): Repository & { keys: () => string[] } {
	const stored = new Map<string, Uint8Array<ArrayBuffer>>();
	return {
		name,
		keys: () => [...stored.keys()].sort(),
		async put(key, file) {
			// Read the whole file before resolving: it is removed afterwards.
			stored.set(key, await Bun.file(file).bytes());
		},
		async get(key) {
			const bytes = stored.get(key);
			return bytes ? new Blob([bytes]).stream() : undefined;
		},
		async *list(prefix) {
			for (const key of stored.keys()) if (key.startsWith(prefix)) yield key;
		},
		async delete(key) {
			stored.delete(key);
		},
	};
}
```

Wrapping a repository is how to test what happens when one fails — this one
fails every `put` of a backup after the first `failFrom`, as the package's
own spec does. Lock files pass through, so the failure lands on an object
rather than on the [lock](locking.md):

```ts
import type { Repository } from '@nxgt/backup';

export function failing(inner: Repository, failFrom: number): Repository {
	let puts = 0;
	return {
		name: inner.name,
		async put(key, file) {
			if (key.split('/')[1] === 'locks') return inner.put(key, file); // <backup>/locks/…
			if (puts >= failFrom) throw new Error('the store is unreachable');
			puts += 1;
			await inner.put(key, file);
		},
		get: (key) => inner.get(key),
		list: (prefix) => inner.list(prefix),
		delete: (key) => inner.delete(key),
	};
}
```

Bound beside a working repository, `failing(memoryRepository('bad'), 1)`
makes `create` reject with `PARTIAL`, and the `bad` repository holds one
object and no manifest.

Next: [sources and targets](sources-and-targets.md), for what goes in and
where it comes back out.
