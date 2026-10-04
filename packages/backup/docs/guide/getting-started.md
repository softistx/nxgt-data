# Getting started

This page takes a folder through a first backup and back: describe it, bind
it to a repository and a public key, create, list, verify and restore.

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
	recipients: [process.env.BACKUP_RECIPIENT as string], // age1…
});

const created = await backups.create(directorySource({ path: '/srv/uploads' }));
const listing = await backups.list();
const verified = await backups.verify(created.id);
const restored = await backups.restore(
	created.id,
	directoryTarget({ path: '/srv/restore' }),
	{ identities: [process.env.BACKUP_IDENTITY as string] }, // AGE-SECRET-KEY-1…
);
```

You need a key pair first: [encryption](encryption.md#keys) shows how to make
one. The host that runs `create` needs only the public half.

## Describing a backup

`defineBackup` describes and touches nothing. It gives back a frozen object
you can export and share between the job that creates backups and the one
that restores them.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `name` | `string` | required | the first segment of every key it writes, `<name>/<id>/…`. 1 to 100 characters: lowercase ASCII letters, digits, `.`, `_` and `-`, starting with a letter or a digit, and never holding `.partial-` (the marker `localRepository` gives a file being written). Several definitions can share a repository |

```ts
interface BackupDefinition<Name extends string = string> {
	readonly name: Name;
}

function defineBackup<const Name extends string>(
	input: { name: Name },
): BackupDefinition<Name>;
```

A name that could not be a path segment throws a bare `TypeError` that gives
the rule, not the name:

```ts
defineBackup({ name: 'Uploads' });
// TypeError: defineBackup: the name must be 1 to 100 characters, lowercase letters, …
```

The name is kept as a literal type: `backups.definition.name` is `'uploads'`,
not `string`.

## Binding it

`bindBackup` attaches a definition to where it is kept and who can read it.
It does no I/O; what could never work is a bare `TypeError` here, at start-up,
rather than at the first backup.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `repositories` | `[Repository, ...Repository[]]` | required | where backups are kept. `create` writes to every one; the other calls read from the first unless given `from`. Names must differ — [repositories](repositories.md) |
| `recipients` | `[string, ...string[]]` | required | the age public keys every backup is encrypted to: `age1…` or `age1pq1…`. Each is checked here — [encryption](encryption.md) |
| `tmpDir` | `string` | the system's temporary folder | an absolute path where each object is staged between the source and the repositories, and between a repository and a restore. One object at a time, removed as soon as it is done |

```ts
interface BindBackupOptions {
	repositories: readonly [Repository, ...Repository[]];
	recipients: readonly [string, ...string[]];
	tmpDir?: string | undefined;
}

function bindBackup<Name extends string>(
	definition: BackupDefinition<Name>,
	options: BindBackupOptions,
): BoundBackup<Name>;

interface BoundBackup<Name extends string = string> {
	readonly definition: BackupDefinition<Name>;
	readonly repositories: readonly string[]; // their names, in the order given
	create(source: BackupSource): Promise<Created>;
	list(options?: ListOptions): Promise<Listing>;
	verify(id: string, options?: VerifyOptions): Promise<Verified>;
	restore(id: string, target: RestoreTarget, options: RestoreOptions): Promise<Restored>;
}
```

**`tmpDir` needs room for the largest object** — the largest entry,
compressed and encrypted — and every call stages there: `create`, `verify`
and `restore`. Each call makes its own folder in it (`nxgt-backup-…`,
`nxgt-verify-…`, `nxgt-restore-…`) and removes it when it ends, failed or
not.

## Creating a backup

```ts
const created = await backups.create(directorySource({ path: '/srv/uploads' }));
```

`create` reads every entry of the source in turn — never two at once, each
opened once — and for each one compresses it with zstd, encrypts it with age
to every recipient into `tmpDir`, measures it, and puts it into every
repository. Then it writes the catalog the same way, and the manifest
**last**. Nothing is held in memory past a chunk: measured on Bun 1.4.2,
64 MB went through age at a peak RSS of 88 MB.

```ts
interface Created {
	id: string;          // '20261003T221500123Z-9f3a61c0'
	createdAt: Date;     // when it started; the id is that time, in UTC
	entries: number;     // how many entries the source gave
	size: number;        // their bytes, as the source gave them
	storedSize: number;  // the bytes each repository holds for it, manifest apart
	outcomes: RepositoryOutcome[]; // all { repository, stored: true } when it resolves
}
```

It resolves only when **every** repository holds the backup. Otherwise it
rejects with a `BackupError`: `PARTIAL` when some do, `NOT_STORED` when none
does, each with `outcomes` —
[several repositories](repositories.md#several-repositories).

An error from the source itself — a folder that is not there, a stream that
fails — rejects `create` with that error, as it is. The objects stored before
it stay in the repository without a manifest: no call sees them, and cleaning
them up is [on the roadmap](../roadmap.md).

## Listing

```ts
const { repository, backups: held, unreadable } = await backups.list();
const fromNas = await backups.list({ from: 'nas' });
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `from` | `string` | the first repository | the repository to list, by name. A name `bindBackup` was not given rejects with a `TypeError` |

```ts
interface Listing {
	repository: string;
	backups: BackupInfo[]; // oldest first
	unreadable: string[];  // ids whose manifest is there but does not read
}

interface BackupInfo {
	id: string;
	createdAt: Date;
	kind: 'full';
	entries: number;
	storedSize: number; // the bytes the repository holds for it, manifest apart
}
```

`list` reads the manifests alone, so it **needs no key**. A backup whose
manifest was never written — one still being made, one that failed, or a
repository that `PARTIAL` left out — is not listed: it does not exist. An id
in `unreadable` has a manifest that is not one this package wrote, or that
this version cannot read; `verify` on it says why.

## Verifying

```ts
// Every object's size and SHA-256 against the manifest. No key.
await backups.verify(id);

// The same, then every entry decrypted, decompressed and checked against
// what the source gave.
await backups.verify(id, { identities: [process.env.BACKUP_IDENTITY as string] });
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `from` | `string` | the first repository | the repository to check, by name |
| `identities` | `string[]` | none | age secret keys. Without them, `verify` proves the repository holds exactly the bytes that were written. With them, it also opens the catalog and every entry, and checks each entry's size and SHA-256 as the source gave them |

```ts
interface Verified {
	id: string;
	repository: string;
	objects: number;    // objects checked, the catalog included
	storedSize: number; // their encrypted bytes
	decrypted: boolean; // whether the entries were decrypted and checked too
}
```

`verify` reads the whole backup back, one object at a time through
`tmpDir`, and writes nowhere else. It rejects at the first problem:
`NOT_FOUND` with no manifest, `INTEGRITY` for an object that differs or a
manifest or catalog that does not read, `DECRYPT` when no identity opens it —
[errors](errors.md).

Without a key, it can run where the backups are kept, as often as you like:
the secret key never has to go there.

## Restore

```ts
const restored = await backups.restore(
	id,
	directoryTarget({ path: '/srv/restore' }),
	{ identities: [process.env.BACKUP_IDENTITY as string] },
);
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `identities` | `string[]` | required | age secret keys; at least one must open the backup |
| `from` | `string` | the first repository | the repository to read from, by name |
| `only` | `string[]` or `(name: string) => boolean` | every entry | which entries to take back. A name in the list that the backup does not hold is `NOT_FOUND`, before anything is written |

```ts
await backups.restore(id, target, {
	identities: [identity],
	only: ['a.txt'],                                // these names
});
await backups.restore(id, target, {
	identities: [identity],
	only: (name) => name.startsWith('nested/'),     // or a test on each name
});
```

```ts
interface Restored {
	id: string;
	repository: string;
	entries: string[]; // the names written, in the backup's order
	size: number;      // their bytes, as the source gave them
}
```

For each entry, in the backup's order, `restore` copies its object to
`tmpDir`, checks its size and SHA-256 against the manifest **before a byte of
it is decrypted**, then streams it through age and zstd to the target,
checking the plain bytes against the catalog as they go. A damaged entry
fails its stream at the end with `INTEGRITY`, so a target that waits for the
end — `directoryTarget` does — lands nothing from it; then the restore
stops.

**What was written before the damaged entry stays written.** Restore into an
empty folder, check it, then move it into place:

```ts
import { rename, rm } from 'node:fs/promises';

const staging = '/srv/restore.incoming';
await rm(staging, { recursive: true, force: true });
await backups.restore(id, directoryTarget({ path: staging }), {
	identities: [process.env.BACKUP_IDENTITY as string],
});
await rename(staging, '/srv/restore'); // reached only when every entry checked out
```

## A nightly job

A script for cron or a systemd timer: back up, verify what landed without a
key, and exit non-zero when anything is short, so the scheduler reports it.

```ts
// backup.ts — bun run backup.ts
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
	const created = await backups.create(directorySource({ path: '/srv/uploads' }));
	for (const repository of backups.repositories) {
		await backups.verify(created.id, { from: repository });
	}
	console.log(`backup ${created.id}: ${created.entries} entries, ${created.storedSize} bytes`);
} catch (error) {
	if (error instanceof BackupError && error.code === 'PARTIAL') {
		const failed = error.outcomes.filter((outcome) => !outcome.stored);
		console.error(error.message, failed.map((outcome) => outcome.repository));
		process.exit(2);
	}
	throw error;
}
```

## A restore drill in a spec

A backup nobody has restored is a hope. This spec, lifted from the
package's own, backs up a few entries into a throw-away folder and restores
them into memory, checking every byte — run it in CI with a key made for the
test.

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BackupSource,
	bindBackup,
	defineBackup,
	localRepository,
	type RestoreTarget,
} from '@nxgt/backup';
import { generateIdentity, identityToRecipient } from 'age-encryption';

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'backup-drill-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

function memorySource(entries: Record<string, string>): BackupSource {
	return {
		kind: 'memory',
		async *entries() {
			for (const [name, value] of Object.entries(entries)) {
				yield { name, open: () => new Response(value).body as ReadableStream<Uint8Array> };
			}
		},
	};
}

function memoryTarget(): RestoreTarget & { written: Map<string, string> } {
	const written = new Map<string, string>();
	return {
		written,
		async write(name, stream) {
			written.set(name, await new Response(stream).text());
		},
	};
}

test('a backup comes back byte for byte', async () => {
	const identity = await generateIdentity();
	const backups = bindBackup(defineBackup({ name: 'drill' }), {
		repositories: [localRepository({ path: join(root, 'repo') })],
		recipients: [await identityToRecipient(identity)],
		tmpDir: root,
	});
	const files = { 'a.txt': 'alpha', 'nested/b.txt': 'beta', empty: '' };

	const created = await backups.create(memorySource(files));
	expect(created.entries).toBe(3);
	expect((await backups.verify(created.id, { identities: [identity] })).decrypted).toBe(true);

	const target = memoryTarget();
	const restored = await backups.restore(created.id, target, { identities: [identity] });
	expect(restored.entries).toEqual(['a.txt', 'nested/b.txt', 'empty']);
	expect(Object.fromEntries(target.written)).toEqual(files);
});
```

`age-encryption` is installed with this package; import it directly only
after `bun add -d age-encryption`, so your project names it.

Next: [the format](format.md) of what landed, or
[where else it can land](repositories.md).
