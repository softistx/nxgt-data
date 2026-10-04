# Repositories

This page covers where backups are kept: the local repository that ships,
writing to several at once, and the `Repository` contract for writing your
own.

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
Node's file errors (`ENOSPC`, `EACCES`, …). Log it with care: a repository
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
| `get(key)` | the bytes under `key`, or `undefined` when there are none. `undefined` for the manifest is `NOT_FOUND`; for `manifest.sig`, when `trusted` keys are set, `SIGNATURE`; for an object, `INTEGRITY`. The package reads no more than 65 bytes of `manifest.sig` and 64 MiB and one byte of a manifest, and cancels the rest of the stream |
| `list(prefix)` | every key that starts with `prefix`, in any order, keys of writes in progress left out. The package lists `<backup>/` and keeps the keys that end in `/manifest.json` |
| `delete(key)` | removes `key`; one that is not there is not an error. 0.1 and 0.2 never call it — rotation and clean-up will |

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
fails every `put` after the first `failFrom`, as the package's own spec does:

```ts
import type { Repository } from '@nxgt/backup';

export function failing(inner: Repository, failFrom: number): Repository {
	let puts = 0;
	return {
		name: inner.name,
		async put(key, file) {
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

An S3 repository is [on the roadmap](../roadmap.md).

Next: [sources and targets](sources-and-targets.md), for what goes in and
where it comes back out.
