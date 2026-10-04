# Chains

This page covers incremental and differential backups: backups that store
only the entries that changed since an earlier backup, and point to the
others where they are already stored.

```ts
import {
	bindBackup,
	defineBackup,
	directorySource,
	directoryTarget,
	localRepository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string], // age1…
});
const identities = [(await Bun.file('/etc/backup/identity.txt').text()).trim()]; // AGE-SECRET-KEY-1…
const source = directorySource({ path: '/srv/uploads' });

const full = await backups.create(source);
// { kind: 'full', parent: null, entries: 1204, reused: 0, … }

const next = await backups.create(source, { kind: 'incremental', identities });
// { kind: 'incremental', parent: full.id, entries: 1204, reused: 1187, … }

// The whole folder as it was at `next`, whatever stored each file:
await backups.restore(next.id, directoryTarget({ path: '/srv/restore' }), { identities });
```

## Full, incremental, differential

| `kind` | Builds on | Stores |
| --- | --- | --- |
| `full` (the default) | nothing | every entry |
| `incremental` | the newest backup older than this one, whatever its kind | the entries that changed since that backup |
| `differential` | the newest **full** backup older than this one | the entries that changed since that full backup |

The backup it builds on — its **parent**, the manifest's `parent` and
`Created.parent` — is chosen:

- **in one repository**: `from`, or the first repository still in the run —
  one whose lock another run holds is skipped. A `from` you name whose lock
  failed rejects the `create` with that repository's error, `LOCKED` say:
  read without its lock, the parent could be pruned mid-read;
- **under the lock**, once `create` holds it in every repository, so no other
  `create` or `prune` of the definition lands between the choice and the
  write ([locking](locking.md));
- **among the backups older than this one**: its id is earlier. A backup
  dated after it, by a clock that ran ahead, is never built on;
- **among the backups that read**: one whose manifest does not read — or,
  with `trusted` keys, that none of them signed — is passed over for the
  next older one, never built on.

Then, before the source is read, the parent must be fit to build on:

- **its whole chain is there**: every backup it builds on, down to the full
  one, has its manifest in that repository — or `create` rejects with
  `INTEGRITY`,
  [a backup it builds on is missing](../troubleshooting.md#restore-on-app-a-backup-it-builds-on-is-missing-repository-local);
- **it is encrypted to the same recipients** as the binding, as a set — or
  `create` rejects with a `TypeError`: [changing recipients](#changing-recipients);
- **its source was of the same `kind`** as the one given.

A differential passes over every incremental and differential to reach the
newest full backup. When there is nothing to build on, `create` rejects with
`NOT_FOUND` before reading the source:
[no backup to build on](../troubleshooting.md#create-on-app-no-backup-to-build-on-repository-local).

## The options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `kind` | `'full' \| 'incremental' \| 'differential'` | `'full'` | what to store. Anything else rejects with a `TypeError` |
| `identities` | `readonly string[]` | required unless `full` | age secret keys, at least one, that open the parent's catalog — [why](#it-needs-a-key-where-backups-are-made). The types refuse it on a full backup, and refuse an incremental or differential without it |
| `from` | `string` | the first repository still in the run | where to look for the parent. Every other repository must hold the same one, with its chain — [several repositories](#several-repositories) |

```ts
type BackupKind = 'full' | 'incremental' | 'differential';

type CreateOptions =
	| { kind?: 'full' | undefined }
	| {
			kind: 'incremental' | 'differential';
			identities: readonly string[];
			from?: string | undefined;
	  };

interface BoundBackup<Name extends string = string> {
	create(source: BackupSource, options?: CreateOptions): Promise<Created>;
	// …
}

interface Created {
	id: string;
	createdAt: Date;
	kind: BackupKind;
	parent: string | null; // the backup it builds on: null for a full one
	entries: number;       // every entry it holds — stored in it, or pointing to its chain
	reused: number;        // how many of them point to an object of an older backup
	size: number;          // the bytes of all its entries, as the source gave them
	storedSize: number;    // the bytes each repository holds for this backup itself, manifest apart
	signed: boolean;
	outcomes: RepositoryOutcome[];
}
```

`storedSize` is what the backup added to the repository: its own objects and
its catalog. `entries` and `size` are its whole view, so they match what a
restore of it writes.

## Every backup holds its whole view

A backup's catalog lists **every entry it restores**, not only the ones it
stored. An unchanged entry is a pointer: its `in` names the backup that
stored its object, and its `object` the key there. A pointer always names
the backup that **stored** the object, never an intermediate one, so there
is never a second hop. Lifted from the package's spec:

```ts
import {
	type BackupSource,
	bindBackup,
	defineBackup,
	localRepository,
	type RestoreTarget,
} from '@nxgt/backup';

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

const identities = [process.env.BACKUP_IDENTITY as string];
const backups = bindBackup(defineBackup({ name: 'app' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const full = await backups.create(memorySource({ same: 'same', changed: 'v1', removed: 'gone' }));
const next = await backups.create(memorySource({ same: 'same', changed: 'v2', added: 'new' }), {
	kind: 'incremental',
	identities,
});
// next: { kind: 'incremental', parent: full.id, entries: 3, reused: 1 }

const target = memoryTarget();
await backups.restore(next.id, target, { identities });
// target.written: same → 'same', changed → 'v2', added → 'new' — and no 'removed'

const { backups: listed } = await backups.list();
// listed.map((b) => [b.kind, b.parent, b.entries]):
// [['full', null, 3], ['incremental', full.id, 2]]
```

What follows from it:

- **`restore` and `verify` replay nothing.** They read the one backup's
  catalog and fetch each entry's object where it is — in the backup itself
  or an older one of its chain. A restore of an incremental reads the same
  objects a restore of a full backup of the same files would.
- **A deletion is an absent entry.** A file removed before `next` is not in
  its catalog, so restoring `next` does not bring it back; restoring `full`
  still does.
- **`only` works as on a full backup**: it picks names from the whole view.
- **`list` counts what a backup stores itself.** `BackupInfo.entries` is the
  number of objects in its manifest — `2` above, `changed` and `added` —
  while `Created.entries` is its whole view, `3`.

```ts
interface BackupInfo {
	id: string;
	createdAt: Date;
	kind: BackupKind;
	parent: string | null; // the backup it builds on: null for a full one
	entries: number;       // the entries it stores itself; an incremental one points to the rest
	storedSize: number;
	held: boolean;
}
```

The catalog's `in`, `fingerprint` and `position` fields are on the
[format](format.md#the-catalog) page.

## It needs a key where backups are made

To know what its parent recorded — the entry names, their digests and
fingerprints, the source's position — `create` decrypts the parent's
catalog. So an incremental or differential `create` takes `identities`, and
the host that makes them holds a **secret key** that opens every backup
encrypted to its recipient.

That is the trade-off. A full backup needs only `recipients`, public keys:
the host being backed up — the one an intruder would be on — holds nothing
that opens its own backups. A host that makes incrementals does. If that is
not acceptable, keep to full backups there; `verify` without a key still
runs anywhere.

When you do keep the key there, keep it in a file only the backup job can
read, not in an environment every process inherits:

```sh
chown backup:backup /etc/backup/identity.txt
chmod 600 /etc/backup/identity.txt
```

```ts
const identities = [(await Bun.file('/etc/backup/identity.txt').text()).trim()];
await backups.create(source, { kind: 'incremental', identities });
```

The identity is checked before anything is read, as `restore` checks it:
`identities: []` rejects with
[`identities must list at least one age secret key`](../troubleshooting.md#create-on-app-identities-must-list-at-least-one-age-secret-key),
and one that opens no recipient of the parent with
[`no identity given opens it`](../troubleshooting.md#restore-on-app-no-identity-given-opens-it-repository-local).

## How "unchanged" is decided

For each entry the source yields, by name, against what the parent recorded
under that name:

1. **The fingerprint is the recorded one** → the entry is **not opened**. It
   points to the object already stored.
2. **Otherwise it is read**, compressed and encrypted into `tmpDir` as on a
   full backup. If the SHA-256 of its plain bytes is the recorded one, the
   sealed file is **dropped** and the entry points to the object already
   stored; otherwise the object is stored, as a full backup would.
3. **A name the parent did not record** is stored. **A name the source no
   longer yields** is not in the new backup.

`reused` counts the pointers from steps 1 and 2. A source without
fingerprints still saves the storage — every entry is read, and only the
changed ones are stored; fingerprints save the read as well.

## The folder's fingerprint

`directorySource` gives each file a fingerprint of four numbers from
`lstat`, taken **before** the file is read:

```text
size:mtimeNs:ctimeNs:ino
5:1791158100123456789:1791158100123456789:48213377
```

- **A write moves it**: the size, the modification time, or both.
- **The change time cannot be set back.** It is the kernel's: a tool that
  puts the modification time back — `touch -d`, `rsync -t`, `tar -x`, a
  `cp -p` — still moves it, so the file is read again.
- **A file written while it is read** was measured before the read: its
  next fingerprint differs, and the next backup reads it again.
- **A `chmod`, a `chown` or a hard link** moves the change time: the file is
  read again, and not stored, since its bytes did not change.
- **A folder restored elsewhere** — another machine, a fresh disk, a copy —
  has new inodes and times. The first incremental there reads every file
  once, stores none whose bytes match, and records the new fingerprints; the
  next one is quick again.
- **A file changed in the last two seconds gets no fingerprint.** When its
  modification or change time is within two seconds of the moment it is
  measured, the file is read and stored as usual, but no fingerprint is
  recorded, so the next backup reads it again — and stores it only if its
  bytes changed. File times are only as fine as the file system's clock — a
  tick on Linux, two seconds on FAT — and a same-size write landing in the
  same tick, after the measure, would leave all four numbers as they were.
  Git's index applies the same rule.
- **A file removed between the walk and its turn**, or no longer a regular
  file then — swapped for a link — is left out, not an error.

## Writing a source with fingerprints and a position

A source of your own can do the same, and more: it gets back what the
parent recorded, and can keep a **position** — a change feed's cursor, a
log's offset, a change stream's resume token — for the next backup.

```ts
interface SourceEntry {
	name: string;
	open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
	fingerprint?: string | undefined; // at most 1024 bytes, UTF-8
}

interface Since {
	id: string;                  // the parent's id
	position: string | undefined; // the parent's position, if its source gave one
	entries: ReadonlyMap<string, { size: number; sha256: string; fingerprint: string | undefined }>;
}

interface BackupSource {
	readonly kind: string;
	entries(since?: Since): AsyncIterable<SourceEntry>;
	position?(): string | undefined | Promise<string | undefined>; // at most 64 KiB, UTF-8
}
```

- **`entries(since)`** gets `since` when the backup builds on another, and
  nothing for a full one. It still yields **every** entry the new backup
  should hold, the unchanged ones included: an entry it does not yield is
  not in the new backup.
- **`fingerprint`** is what the source can say of an entry without reading
  it, at most 1024 bytes in UTF-8. It **must change whenever the bytes do**: an
  entry whose fingerprint is the recorded one is not opened, and the new
  backup keeps the old bytes. When unsure, leave it out.
- **`position()`** is called once, after the last entry. What it returns,
  at most 64 KiB in UTF-8, is kept in the backup's catalog — encrypted, like the
  names — and handed back as `since.position` to the next backup that builds
  on this one. A differential gets its full backup's position.
- **`kind`** must be the one the parent was made from, or `create` rejects
  with
  [a `TypeError`](../troubleshooting.md#create-on-app-the-source-is-not-of-the-kind-the-backup-it-builds-on-was-made-from).

A source over a document store with a change feed: each document is an
entry, the feed's cursor is the position, and a document the feed does not
name since the parent's position keeps its recorded fingerprint, so it is
not fetched:

```ts
import type { BackupSource, Since } from '@nxgt/backup';

const api = 'http://localhost:3000/admin';

async function get<T>(path: string): Promise<T> {
	const response = await fetch(`${api}${path}`);
	if (!response.ok) throw new Error(`documents: ${path} answered ${response.status}`);
	return (await response.json()) as T;
}

/** Every document as one entry; the change feed says which moved since the last backup. */
export function documentsSource(): BackupSource {
	let cursor: string | undefined;
	return {
		kind: 'documents',
		async *entries(since?: Since) {
			// Taken before anything is read: a change made during the backup is
			// after this cursor, so the next backup reads that document again.
			cursor = (await get<{ cursor: string }>('/changes/cursor')).cursor;
			const changed =
				since?.position === undefined
					? undefined // a full backup, or a parent with no position: read everything
					: new Set(
							(await get<{ ids: string[] }>(`/changes?after=${encodeURIComponent(since.position)}`)).ids,
						);
			const { ids } = await get<{ ids: string[] }>('/documents');
			for (const id of ids) {
				const name = `documents/${id}.json`;
				const recorded = since?.entries.get(name)?.fingerprint;
				yield {
					name,
					// Untouched since the parent: its own fingerprint, so it is not fetched.
					// Changed or new: the current cursor, which no older backup recorded.
					fingerprint: changed && !changed.has(id) && recorded !== undefined ? recorded : cursor,
					open: async () => {
						const response = await fetch(`${api}/documents/${encodeURIComponent(id)}`);
						if (!response.ok) throw new Error(`documents: ${response.status}`);
						return response.body as ReadableStream<Uint8Array>;
					},
				};
			}
		},
		position: () => cursor,
	};
}
```

```ts
await backups.create(documentsSource()); // Sunday: every document
await backups.create(documentsSource(), { kind: 'incremental', identities }); // only what the feed names
```

The fingerprint here is a cursor, not a hash: it changes whenever the feed
says a document did, which is the one promise a fingerprint must keep. A
document the feed names but whose bytes did not change is fetched, and not
stored. [Sources and targets](sources-and-targets.md#writing-a-source) has
the rest of the contract.

## A typical schedule

A full backup once a week, and an incremental or a differential every other
day:

```ts
import {
	BackupError,
	bindBackup,
	type CreateOptions,
	defineBackup,
	directorySource,
	localRepository,
} from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'uploads' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
	tmpDir: '/var/tmp',
});
const identities = [(await Bun.file('/etc/backup/identity.txt').text()).trim()];
const source = directorySource({ path: '/srv/uploads' });

// Sunday (UTC) a full backup; every other day what changed since the day before.
const options: CreateOptions =
	new Date().getUTCDay() === 0 ? { kind: 'full' } : { kind: 'incremental', identities };

let created;
try {
	created = await backups.create(source, options);
} catch (error) {
	// The first night, or after the chain was pruned away: nothing to build on.
	if (!(error instanceof BackupError && error.code === 'NOT_FOUND')) throw error;
	created = await backups.create(source);
}
console.log(`${created.kind} ${created.id}: ${created.entries - created.reused} entries stored`);

await backups.prune({ keep: { daily: 14, weekly: 8 } }); // keeps every parent a kept backup needs
```

Which to pick:

| | `incremental` | `differential` |
| --- | --- | --- |
| Each night stores | what changed since the night before: the least | what changed since the full backup: more each night, until the next full one |
| A restore needs | the full backup and every incremental since: one more each night | the full backup and itself: two |
| A backup of its chain gone | every later backup fails to restore until the next full one | only that differential is lost |
| `verify` without a key reads | every object of the whole chain | the full backup's objects and its own |
| A restore reads | only the objects of its view — the same bytes either way | |

A restore never replays a chain, so its cost in bytes read is the same: what
grows with an incremental chain is the number of backups that must still be
there, intact, for the newest one to restore — and the number `prune` keeps
for it. A weekly full backup bounds both.

## Several repositories

The parent is chosen in one repository — `from`, or the first still in the
run — and every other repository must hold the **same** backup, and its
whole chain. One that does not — added since the last full backup, left out
of a `PARTIAL` night, pruned by hand — is left out of this run, as a failing
repository is: `create` rejects with `PARTIAL`, and that repository's
outcome is the reason:

```text
create on "uploads": the backup it builds on is not in this repository (repository "nas")   ← NOT_FOUND
create on "uploads": a backup it builds on is missing (repository "nas")                    ← INTEGRITY
```

A backup built on one a repository lacks could not be restored from there,
hence the refusal. A full backup lands everywhere, and the chains start
again from it:

```ts
import { BackupError } from '@nxgt/backup';

try {
	await backups.create(source, { kind: 'incremental', identities });
} catch (error) {
	const lacksParent =
		error instanceof BackupError &&
		error.code === 'PARTIAL' &&
		error.outcomes.some(
			(outcome) =>
				!outcome.stored && outcome.error instanceof BackupError && outcome.error.code === 'NOT_FOUND',
		);
	if (!lacksParent) throw error;
	await backups.create(source); // a full one, in every repository
}
```

## Reading a chain back

`restore` and `verify` read the manifest of the backup asked for, then the
manifest of its parent, of that one's parent, down to the full backup — each
one checked as any manifest is, its signature too with `trusted` keys. Then:

- **`restore`** decrypts the backup's catalog and fetches each entry's
  object in whichever backup of the chain stored it, checked against that
  backup's manifest before a byte is decrypted.
- **`verify` without a key** checks **every object of every backup of the
  chain** against its manifest — what any entry could point to.
- **`verify` with identities** decrypts the backup's catalog and checks
  every entry of its view, wherever it is stored.

An error about an object stored in an older backup carries **that** backup's
id in `error.id` — the one whose folder to look in — from `restore` as from
`verify`. A backup of the chain that no `trusted` key signed fails with
`SIGNATURE` and its own id.

`Verified.chain` lists the backups read, newest first:

```ts
interface Verified {
	id: string;
	repository: string;
	chain: string[];    // this backup, then each one it builds on, newest first; [id] for a full one
	objects: number;    // objects checked — not comparable with and without a key, see below
	storedSize: number; // their encrypted bytes
	decrypted: boolean;
	signatureChecked: boolean;
}
```

From the package's spec — a full backup `one` of three entries, then two
incrementals that each changed one:

```ts
const keyless = await backups.verify(three.id);
// { chain: [three.id, two.id, one.id], objects: 8, … }  — 3 + 1 + 1 objects, and 3 catalogs
const keyed = await backups.verify(three.id, { identities });
// { chain: [three.id, two.id, one.id], objects: 4, … }  — its catalog, and its 3 entries
```

The two counts measure different things. Without a key, `objects` is every
object of every backup of the chain, catalogs included — superseded ones
too: the first version of an entry that `two` replaced is still in `one`,
and still checked. With a key, it is the backup's catalog plus one object
per entry of its view, wherever stored.

**A backup of the chain that is gone makes every later one unreadable**,
never silently short: `restore` and `verify` reject with `INTEGRITY` —
[a backup it builds on is missing](../troubleshooting.md#restore-on-app-a-backup-it-builds-on-is-missing-repository-local).
`prune` never removes one a kept backup needs; a hand, a lifecycle rule or
an older `prune` can.

## Rotation keeps the chain

`prune` keeps a kept backup's parent, that parent's own, down to the full
backup, each with the reason `parent of <id>`; a held backup keeps its
chain the same way. A backup whose manifest does not read — damaged, or not
signed by a `trusted` key — stays in `unreadable`, never removed, and its
parent is still kept: `prune` reads the `parent` field from its raw JSON, as
best it can — [rotation](rotation.md#chains).

## Changing recipients

A backup's objects are encrypted to the recipients it was made with. An
incremental that pointed to them after `recipients` changed would be
readable by a key you removed, and not by one you added: a restore with the
new key would fail `DECRYPT` on the old entries. So `create` refuses a
parent encrypted to other recipients — compared as a set, order apart:

```text
TypeError: create on "uploads": the backup it builds on is encrypted to other recipients; make a full backup first
```

**After changing `recipients`, the next backup must be full**; incrementals
build on it from then on:

```ts
const backups = bindBackup(uploads, { repositories, recipients: [newRecipient, escrow] });
await backups.create(source); // full: encrypted to the new recipients
await backups.create(source, { kind: 'incremental', identities: [newIdentity] });
```

## Upgrade every process that prunes before the first incremental

`@nxgt/backup` 0.5 reads only full manifests. To a 0.5 `prune`, an
incremental or differential backup is **unreadable** — `its kind is not one
this version reads` — so it never removes one, and **does not know what it
builds on**: its policy can remove the full backup an incremental needs,
and every backup of that chain then fails with
[a backup it builds on is missing](../troubleshooting.md#restore-on-app-a-backup-it-builds-on-is-missing-repository-local).
A 0.5 `list`, `verify` or `restore` cannot read them either. Move every
process that reads or prunes the repository to 0.6 first, then create the
first incremental — [upgrading](../upgrading.md#05--06).

```sh
bun add @nxgt/backup@^0.6.0
```

## Errors

| Thrown | When |
| --- | --- |
| `TypeError: create on "uploads": kind must be full, incremental or differential` | a `kind` that is none of them |
| `TypeError: create on "uploads": identities must list at least one age secret key` | `identities: []` — or one age refuses: `identity 0 is not an age secret key` |
| `TypeError: create on "uploads": no repository has that name` | `from` names no repository |
| `BackupError` `LOCKED` | the repository named in `from` could not be locked — or whatever error kept its lock from being taken — as the rejection |
| `BackupError` `NOT_FOUND`: `create on "uploads": no backup to build on (repository "local")` | no readable backup older than this one in `from`; `no full backup to build on` for a differential |
| `BackupError` `INTEGRITY`: `create on "uploads": a backup it builds on is missing (repository "local")` | the parent's chain is broken in `from`; in another repository, that repository's outcome inside `PARTIAL` |
| `TypeError: create on "uploads": the backup it builds on is encrypted to other recipients; make a full backup first` | `recipients` changed since the parent — [above](#changing-recipients) |
| `TypeError: create on "uploads": the source is not of the kind the backup it builds on was made from` | the source's `kind` is not the parent's |
| `BackupError` `DECRYPT`, `INTEGRITY` | the parent's catalog: no identity opens it, or it does not read |
| `BackupError` `PARTIAL` with a `NOT_FOUND` or `INTEGRITY` outcome | a repository does not hold the parent, or its chain — [above](#several-repositories) |
| `TypeError: create on "uploads": the source gave a fingerprint that is not a string of at most 1024 bytes` | your source's `fingerprint` |
| `TypeError: create on "uploads": the source gave a position that is not a string of at most 64 KiB` | your source's `position()` |
| `BackupError` `INTEGRITY`: `restore on "uploads": a backup it builds on is missing (repository "local")` | `restore` or `verify`, a backup of the chain gone |
| `BackupError` `SIGNATURE` | `restore` or `verify`, with `trusted` keys: a backup of the chain no trusted key signed; `error.id` is that backup's |

All are rejections. Every message is in
[troubleshooting](../troubleshooting.md#chains), with its fix.

Next: [rotation](rotation.md), to keep chains in check;
[sources and targets](sources-and-targets.md), for the rest of the source
contract.
