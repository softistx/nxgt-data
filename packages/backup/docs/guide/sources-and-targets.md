# Sources and targets

This page covers what a backup reads from and what a restore writes to: the
folder source and target that ship, and the two small contracts for writing
your own — a database dump, an in-memory target for specs.

```ts
import { bindBackup, defineBackup, directorySource, directoryTarget, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const { id } = await backups.create(directorySource({ path: '/srv/uploads' }));
await backups.restore(id, directoryTarget({ path: '/srv/restore' }), {
	identities: [process.env.BACKUP_IDENTITY as string],
});
```

## `directorySource`

Every regular file under a folder, as one entry each.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `path` | `string` | required | the folder, as an absolute path |

```ts
interface DirectoryOptions {
	path: string;
}

function directorySource(options: DirectoryOptions): BackupSource; // kind: 'directory'
```

- **Names are relative paths with `/`**, whatever the platform —
  `b/c/d.txt` — and the entries come in sorted order.
- **Symbolic links are skipped, not followed** — to a file or to a folder:
  a link could lead anywhere, including back into the folder. A folder holding `z.txt`, `b/c/d.txt` and
  a link `link → /etc/hosts` backs up `b/c/d.txt` and `z.txt`.
- **Empty folders are not recorded**; a restore recreates only the folders
  that hold a file.
- **Only bytes are kept**: no permissions, owner or timestamps. A restored
  file gets the defaults of whoever restores it.
- **Files are read as the backup reaches them**, not all at once, so a file
  that changes during the backup is stored as it was when it was read. For a
  consistent copy of a folder that is being written to, back up a
  file-system snapshot of it. A file removed between the listing and its
  turn, or no longer a regular file then, is left out.
- **Each file has a fingerprint**, `size:mtimeNs:ctimeNs:ino`, from `lstat`
  just before it is read: an [incremental or differential](chains.md)
  backup does not open a file whose fingerprint is the one its parent
  recorded. A file changed in the last two seconds gets none, and the next
  backup reads it again — [the folder's fingerprint](chains.md#the-folders-fingerprint).

The folder is listed when `create` starts reading: one that is not there
rejects `create` with the file system's own `ENOENT` — never an empty
backup — and nothing is written.

```ts
directorySource({ path: './uploads' });
// TypeError: directorySource: path must be an absolute path
```

## `directoryTarget`

Writes each entry to a file under a folder, creating the folders it needs.

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `path` | `string` | required | the folder, as an absolute path. Created if it is not there |
| `overwrite` | `boolean` | `false` | replace a file that is already there. By default that entry is refused |

```ts
interface DirectoryTargetOptions extends DirectoryOptions {
	overwrite?: boolean | undefined;
}

function directoryTarget(options: DirectoryTargetOptions): RestoreTarget;
```

- **A name is not trusted.** It comes from a backup, which comes from a
  repository. A name holding a `\`, or an empty, `.` or `..` segment — `../x`,
  `/etc/x`, `a//b`, `./x` — is refused with a `TypeError` before anything is
  written, and the message does not quote it. So is a name whose folder is
  already there as a symbolic link: `a/x.txt`, with `a` a link, would land
  wherever `a` points.
- **A damaged entry never lands.** Each file is written beside its place, as
  `<file>.partial-<uuid>`, synced, and moved into it only once the stream has
  ended cleanly; a stream that fails — `INTEGRITY` from a restore — removes the
  partial file and lands nothing.
- **An existing file is refused unless `overwrite: true`.**

```ts
await backups.restore(id, directoryTarget({ path: '/srv/uploads' }), { identities });
// TypeError: directoryTarget: a file is already there; pass overwrite: true to replace it

await backups.restore(id, directoryTarget({ path: '/srv/uploads', overwrite: true }), {
	identities,
});
```

A refusal stops the restore with that `TypeError`, and the entries written
before it stay. Restoring into an empty folder avoids both surprises —
[getting started](getting-started.md#restore).

## Writing a source

A source is a `kind`, recorded in the encrypted catalog, and an async
iterable of entries, each a name and a way to open its bytes.

```ts
interface BackupSource {
	readonly kind: string;                             // 'directory', 'pg_dump', …
	entries(since?: Since): AsyncIterable<SourceEntry>; // each opened in turn: never two at once
	position?(): string | undefined | Promise<string | undefined>; // optional; after the last entry
}

interface SourceEntry {
	name: string; // unique within the backup; not empty, at most 4096 characters, no NUL
	open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>; // called once
	fingerprint?: string | undefined; // optional; at most 1024 bytes, UTF-8
}

interface Since {
	id: string;                   // the backup this one builds on
	position: string | undefined; // what that backup's position() returned
	entries: ReadonlyMap<string, { size: number; sha256: string; fingerprint: string | undefined }>;
}
```

`entries`, `name` and `open` are all a full backup needs; a source written
for 0.5 fits as it is. The rest is for [chains](chains.md):

- **`since`** is given to `entries` when the backup builds on another: what
  that one recorded, by name. The source still yields every entry the new
  backup should hold — one it leaves out is not in it.
- **`fingerprint`** is what the source can say of an entry without reading
  it — a version, an ETag, a size and a time. An entry whose fingerprint is
  the recorded one is not opened, and keeps the bytes stored before: **it
  must change whenever the bytes do.** Without one, every entry is read, and
  stored only if its bytes changed. Over 1024 bytes in UTF-8 rejects `create`
  with a `TypeError`.
- **`position()`** is called once, after the last entry: where the source
  stands — a change feed's cursor, a log's offset. It is kept, encrypted, in
  the catalog, and given back as `since.position` to the next backup built
  on this one. Over 64 KiB in UTF-8 rejects `create` with a `TypeError`.

[Chains](chains.md#writing-a-source-with-fingerprints-and-a-position) has a
whole source that uses both.

- `create` asks for the next entry only after the previous one is stored,
  and calls `open` once, when it gets to it — so a source can produce each
  entry lazily, and a dump does not start until its turn.
- A name that is empty, longer than 4096 characters, holds a NUL or was
  given twice rejects `create` with a `TypeError` that does not quote it.
- **A stream that ends is an entry that is whole.** If what feeds it can
  fail after it has started — a process that exits with an error — fail the
  stream; a stream that simply ends is stored as a complete entry.
- Anything a source throws, or a stream errors with, rejects `create` with
  that error, as it is, and the backup gets no manifest.

A source over `pg_dump`, one entry for the whole database, failing the
stream when the dump fails:

```ts
import type { BackupSource } from '@nxgt/backup';

/** pg_dump reads PGHOST, PGUSER, PGPASSWORD and PGDATABASE from the environment. */
export function pgDumpSource(): BackupSource {
	return {
		kind: 'pg_dump',
		async *entries() {
			yield {
				name: 'database.dump',
				open: () => {
					const dump = Bun.spawn(['pg_dump', '--format=custom'], {
						stdout: 'pipe',
						stderr: 'inherit',
					});
					return dump.stdout.pipeThrough(
						new TransformStream<Uint8Array, Uint8Array>({
							// An exit code other than 0 fails the entry, so a truncated
							// dump is never stored as a whole one.
							async flush(controller) {
								const code = await dump.exited;
								if (code !== 0) controller.error(new Error(`pg_dump exited with ${code}`));
							},
						}),
					);
				},
			};
		},
	};
}
```

A logical dump is a backup of one moment; point-in-time recovery for
Postgres is not something this package will do — [roadmap](../roadmap.md#not-planned).

## Writing a target

A target takes each entry back, by name, as a stream.

```ts
interface RestoreTarget {
	write(name: string, stream: ReadableStream<Uint8Array>): Promise<void>;
}
```

`restore` calls `write` once per entry, in the backup's order, and waits for
it before the next. **The stream fails at its end, rather than ending, when
the bytes are not the ones the backup recorded** — the check needs every
byte, so it can only answer at the end. A target that cannot undo a write
keeps it apart until the stream has ended, as `directoryTarget` does. Reject
from `write` and the restore stops with your error. **Resolve `write` only
once the stream has ended**: one that resolves sooner had nothing checked,
and `restore` refuses it with a `TypeError` — [troubleshooting](../troubleshooting.md#restore-on-app-the-target-resolved-write-before-reading-its-stream-to-the-end-so-nothing-it-was-given-was-checked).

An in-memory target for specs, lifted from the package's own:

```ts
import type { RestoreTarget } from '@nxgt/backup';

export function memoryTarget(): RestoreTarget & { written: Map<string, Uint8Array> } {
	const written = new Map<string, Uint8Array>();
	return {
		written,
		async write(name, stream) {
			written.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
		},
	};
}
```

A target that feeds `pg_restore` — and only once the dump has arrived whole,
since a database cannot un-apply half a dump:

```ts
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RestoreTarget } from '@nxgt/backup';

export const pgRestoreTarget: RestoreTarget = {
	async write(name, stream) {
		if (name !== 'database.dump') {
			await stream.cancel();
			throw new TypeError('pgRestoreTarget: this backup holds an entry it does not know');
		}
		const file = join(tmpdir(), `restore-${crypto.randomUUID()}.dump`);
		try {
			await Bun.write(file, new Response(stream)); // rejects with INTEGRITY on a damaged dump
			const restore = Bun.spawn(
				['pg_restore', '--clean', '--if-exists', '--dbname', process.env.PGDATABASE ?? 'postgres', file],
				{ stdout: 'inherit', stderr: 'inherit' },
			);
			const code = await restore.exited;
			if (code !== 0) throw new Error(`pg_restore exited with ${code}`);
		} finally {
			await rm(file, { force: true });
		}
	},
};
```

Next: [errors](errors.md), for everything a restore can stop with.
