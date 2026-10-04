# Getting started

This page takes you from a MongoDB database to a first backup, a first
restore and a first drill with `mongoBackups`, with every option and what
each method returns and throws. The lower-level `mongoSource` it is built
on comes after, from [Lower level](#lower-level).

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key
```

```ts
import { mongoBackups } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string); // a replica set
const backups = mongoBackups({
	db: client.db('shop'),
	repository: '/mnt/backups',
	keyFile: '/etc/backup/shop.key',
});

const report = await backups.run();
// { id: '20261004T221500123Z-9f3a61c0', kind: 'full', fellBack: false, entries: 12, storedSize: 48213, chain: 1, removed: [] }

await backups.restore({ into: client.db('shop-restored') });
// { id: '20261004T221500123Z-9f3a61c0', repository: 'local', entries: ['metadata/customers', …], size: 912345 }

await backups.drill();
// { id: '20261004T221500123Z-9f3a61c0', collections: [{ name: 'customers', documents: 1204 }, …] }
```

## What you need

- **Bun**, as `@nxgt/backup` needs — the `nxgt-mongo-backup` bin runs on it
  too.
- **A replica set.** A full backup is a snapshot read, and an incremental
  reads the change stream: a standalone `mongod` serves neither. A
  single-node replica set is enough — `mongod --replSet rs0`, then
  `rs.initiate()` once. A sharded cluster serves both too, but is untested:
  the specs run against a replica set, and a restore does not shard a
  collection.
- **A `Db` from the `mongodb` driver**, 7.x. Not a database name, and not a
  model: the backup takes the whole database.

```sh
bun add @nxgt/mongo-backup @nxgt/backup mongodb
```

## The key file

One file holds every secret a backup job needs: an **age identity**, which
every backup is encrypted for and which an incremental reads its parent
with, and an **Ed25519 signing key**, which signs every manifest. Write it
once, with the bin or from code:

```sh
bunx nxgt-mongo-backup keygen /etc/backup/shop.key
# key file written: /etc/backup/shop.key
# recipient: age1…
# keep a copy of it away from the backups
```

```ts
import { generateKeyFile } from '@nxgt/mongo-backup';

const { recipient } = await generateKeyFile('/etc/backup/shop.key');
// recipient: 'age1…' — the public half, safe to print
```

- **Mode `0600`**, readable by its owner alone, and synced to disk with
  its folder before the promise resolves.
- **Never overwritten**: a file already at that path rejects with Node's
  `EEXIST`, and leaves it as it was — the backups made with it would be
  lost with it. A write that fails halfway removes the file it created, so
  trying again is not refused with `EEXIST`. The bin prints `<path> is already there: it is never
  overwritten` and exits 1.
- **The bin prints only the recipient**, never a secret. A relative path is
  resolved against the current folder. `nxgt-mongo-backup --help` prints
  the usage and exits 0; a wrong command prints it and exits 2; any other
  failure prints `keygen failed: <message>` and exits 1.
- **Keep a copy away from the backups** — a password manager, a safe.
  Without the identity, the backups are noise.

`readKeyFile` reads it back — `mongoBackups` calls it on first use:

```ts
import { readKeyFile } from '@nxgt/mongo-backup';

const keys = await readKeyFile('/etc/backup/shop.key');
// { identity: 'AGE-SECRET-KEY-1…', recipient: 'age1…', signingKey: '-----BEGIN PRIVATE KEY-----…', publicKey: '-----BEGIN PUBLIC KEY-----…' }
```

```ts
interface BackupKeys {
	identity: string; // the age secret key: reads backups
	recipient: string; // its public half, age1…: every backup is encrypted to it
	signingKey: string; // the Ed25519 private key, PEM: signs every manifest
	publicKey: string; // its public half, PEM: a manifest must be signed by it to be read
}

function generateKeyFile(path: string): Promise<{ recipient: string }>;
function readKeyFile(path: string, where?: string): Promise<BackupKeys>; // where: 'readKeyFile' by default
```

It opens the file once, and checks its mode and reads it through that one
descriptor. It refuses, with `MongoBackupError` code `KEY_FILE` — the
messages start with `readKeyFile:` when you call it, and with
`mongoBackups on "<name>":` — the backup's name — when `mongoBackups` does:

| Message | When |
| --- | --- |
| `readKeyFile: there is no key file there; write one with nxgt-mongo-backup keygen` | nothing at that path; the `ENOENT` is its `cause`. Any other failure to open it — `EACCES`, `ENOTDIR` — is the system's error, as it is |
| `readKeyFile: others than its owner can read or write the key file; chmod 600 it` | its group or others have any right on it — as ssh refuses such a key |
| `readKeyFile: the key file is not one keygen wrote` | it lacks the identity or the signing key, or either does not parse — an identity with a bad checksum, or a private key that is not Ed25519 (an RSA one, say), among them. No `cause`: the parsers' own errors quote the key |

No message quotes the file's content. The public key and the recipient are
derived from the secrets, so the file holds only those two.

## `mongoBackups`

```ts
interface MongoBackupsOptions {
	db: Db;
	repository: string | Repository | readonly [Repository, ...Repository[]];
	keyFile: string;
	name?: string | undefined;
	collections?: CollectionFilter | undefined;
	fullEvery?: number | undefined;
	keep?: KeepPolicy | false | undefined;
	tmpDir?: string | undefined;
}

function mongoBackups(options: MongoBackupsOptions): MongoBackups;
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `db` | `Db` | required | the database backed up; its client must reach a replica set or a sharded cluster. A drill's database is made on the same client |
| `repository` | `string \| Repository \| [Repository, …]` | required | an absolute folder — a `localRepository` — or `@nxgt/backup` repositories, `s3Repository` among them; every backup is written to each |
| `keyFile` | `string` | required | the absolute path of the file `keygen` wrote |
| `name` | `string` | `db.databaseName` | the backup's name in the repository: lowercase letters, digits, `.`, `_` and `-` |
| `collections` | `readonly string[] \| ((name: string) => boolean)` | every collection and view but `system.*` | which to back up — [choosing collections](#choosing-collections) |
| `fullEvery` | `number` (ms) | `DEFAULT_FULL_EVERY`, a week | how old the newest full backup may grow before `run` makes another; an hour at least |
| `keep` | `KeepPolicy \| false` | `DEFAULT_KEEP` | what `run` keeps after each backup; `false` keeps everything |
| `tmpDir` | `string` | the system's temporary folder | where objects and changes are staged; absolute |

```ts
import { DEFAULT_FULL_EVERY, DEFAULT_KEEP } from '@nxgt/mongo-backup';

DEFAULT_FULL_EVERY; // 604_800_000 — 7 days
DEFAULT_KEEP; // { last: 24, daily: 14, weekly: 8, monthly: 12 }
```

`DEFAULT_KEEP` keeps a day hour by hour, two weeks day by day, two months
week by week and a year month by month. A rotation never breaks a chain: a
kept incremental keeps what it builds on —
[`@nxgt/backup`'s rotation](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/rotation.md).

**`mongoBackups` checks its options at once**, and throws a bare
`TypeError`:

```ts
import { mongoBackups } from '@nxgt/mongo-backup';

mongoBackups({ db: client.db('shop'), repository: 'backups', keyFile: '/etc/backup/shop.key' });
// TypeError: mongoBackups: repository must be an absolute folder, or repositories
```

| Message | When |
| --- | --- |
| `mongoBackups: db must be a MongoDB Db` | `db` is missing, or is not a driver `Db` |
| `mongoBackups: keyFile must be an absolute path` | `keyFile` is missing or relative |
| `mongoBackups: repository must be an absolute folder, or repositories` | `repository` is a relative path |
| `mongoBackups: keep must be false, or name rules each a whole number, 1 or more` | `keep` names no rule (`{}`), or a rule — `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `within`, `maxTotalSize` — that is not a whole number of 1 or more. Checked here, not after a backup is stored |
| `mongoBackups: fullEvery must be a whole number of milliseconds, an hour or more` | `fullEvery` under 3 600 000, or not a whole number |
| `mongoBackups: repository must list repositories, each under a name of its own` | `repository` is an empty list, or two repositories in it have the same name |
| `mongoBackups: tmpDir must be an absolute path` | a relative `tmpDir` |
| `mongoBackups: name must be 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"` | `name` is given, and is not a backup name; `defineBackup`'s `TypeError` is its `cause` |
| `mongoBackups: the database's name cannot name a backup; give name: 1 to 100 characters, lowercase letters, digits, ".", "_" and "-", starting with a letter or a digit, without ".partial-"` | no `name`, and the database's name is not a backup name — `client.db('MyShop')`: pass `name: 'myshop'`. `defineBackup`'s `TypeError` is its `cause` |

**A database whose name is not a backup name needs `name`.** A backup
name is lowercase: `client.db('MyShop')` throws the last of these until
you pass one.

```ts
mongoBackups({ db: client.db('MyShop'), name: 'myshop', repository: '/mnt/backups', keyFile: '/etc/backup/shop.key' });
```

**The key file is read on first use**, not here: `mongoBackups` touches
neither the file nor the database. The first `run`, `restore`, `drill`,
`list` or `binding` reads it, and keeps the keys for the next. A read that
fails is tried again on the next call, so a key file put in place later is
picked up without a restart.

### The repository

A string is a local folder. Anything else is `@nxgt/backup`'s — an S3
bucket, or several repositories at once, each written by every backup:

```ts
import { localRepository, s3Repository } from '@nxgt/backup';
import { mongoBackups } from '@nxgt/mongo-backup';
import { S3Client } from 'bun';

const backups = mongoBackups({
	db: client.db('shop'),
	repository: [
		localRepository({ path: '/mnt/backups' }),
		s3Repository({ client: new S3Client({ bucket: 'shop-backups' }), prefix: 'mongo' }),
	],
	keyFile: '/etc/backup/shop.key',
});
```

Reads — `list`, `restore`, `drill` — use the first.

## What it returns

```ts
interface MongoBackups {
	run(now?: Date): Promise<RunReport>;
	restore(options: RestoreAtOptions): Promise<RestoreReport>;
	drill(): Promise<DrillReport>;
	list(): Promise<BackupInfo[]>;
	binding(): Promise<{ backups: BoundBackup; keys: BackupKeys }>;
}
```

### `run`

One scheduled run:

1. **a full backup when none is younger than `fullEvery`**, an incremental
   on the newest backup otherwise;
2. **a full backup after all on `HISTORY_LOST`** — the oplog no longer
   reaches the last backup, and every incremental would fail alike until
   one — with `fellBack: true`. Any other error rejects the run, nothing
   pruned;
3. **`verify` with the identity**: the new backup read back, decrypted,
   every digest and the signature checked;
4. **the rotation**, with `keep` — unless `keep: false`.

```ts
interface RunReport {
	id: string;
	kind: 'full' | 'incremental';
	fellBack: boolean; // an incremental was due, but the oplog no longer reached the last backup
	entries: number;
	storedSize: number;
	chain: number; // how many backups a restore of this one reads: itself and those it builds on
	removed: string[]; // the ids the rotation removed
}
```

```ts
const report = await backups.run();
if (report.fellBack) console.warn('the oplog window is shorter than the interval between runs');
console.log(JSON.stringify(report)); // ids and sizes: never a key nor a document
```

`now` decides between a full and an incremental backup, nothing else.
The backup and the rotation go by the machine's clock: a backup carries
the time it was made, and a later `now` given to the rotation would remove
the backup just made. So a `now` a `fullEvery` ahead makes a full backup
today, and keeps it — for a spec, or to
[force a full backup](operations.md#forcing-a-full-backup):

```ts
import { DEFAULT_FULL_EVERY } from '@nxgt/mongo-backup';

await backups.run(new Date(Date.now() + DEFAULT_FULL_EVERY)); // { kind: 'full', chain: 1, … }
```

A `now` that is not a valid `Date` rejects before anything is read, with
a bare `TypeError`: `run on "shop": now must be a valid Date`.

**The messages name the call.** What `mongoSource` throws when called
directly — `mongoSource: the snapshot outlived the history the server
keeps; …` — `run` throws as `run on "shop": the snapshot outlived the
history the server keeps; …`: same class, same `code`, the original as
`cause`. `restore` and `drill` do the same with `restore on "shop":` and
`drill on "shop":` for `mongoTarget:` and `restoreCollections:` —
[errors](errors.md#through-mongobackups).

A run that overlaps another fails on the repository's lock, and an error
`run` does not handle — `UNSUPPORTED`, `CHANGING`, a driver error — is
thrown as it is: [running it in production](operations.md#the-job) and
[errors](errors.md).

### `restore`

```ts
interface RestoreCommon {
	into: Db;
	at?: string | Date | undefined;
	collections?: CollectionFilter | undefined;
	as?: Readonly<Record<string, string>> | ((name: string) => string) | undefined;
}

type RestoreAtOptions =
	| (RestoreCommon & { documents?: undefined; replace?: boolean | undefined }) // collections whole
	| (RestoreCommon & { documents: { filter: Document; existing: 'replace' | 'keep' }; replace?: never }); // some documents

type RestoreReport = Restored & {
	collections?: { name: string; as: string; documents?: number }[];
};
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `into` | `Db` | required | the database restored into: another, or the one backed up |
| `at` | `string \| Date` | the newest backup | a backup's id, or a time: the newest backup made at or before it |
| `collections` | `readonly string[] \| ((name: string) => boolean)` | all | some collections and views only, by their name at the backup's time |
| `as` | `Record<string, string> \| ((name: string) => string)` | their own names | other names to restore them under |
| `documents` | `{ filter, existing }` | — | only the documents `filter` matches, merged on `_id` into what is there; `existing: 'keep'` or `'replace'` says what happens to one already there |
| `replace` | `boolean` | `false` | replace collections and views already there, rather than refuse them with `EXISTS` — on a whole restore, or a part by `collections` or `as`. Refused with `documents`, by the types and at run time |

**Whole or part.** With none of `collections`, `as` and `documents`, the
restore is whole, through `mongoTarget`, and the report is `@nxgt/backup`'s
`Restored` — `{ id, repository, entries, size }`. With any of them it goes
through `restoreCollections`: the whole backup is rebuilt in a scratch
database `nxgt-restore-<uuid>` on `into`'s client, then what was asked for
moves into `into`, and the report has `collections`:

```ts
// the database as it was this morning, into another one
const back = await backups.restore({ into: client.db('shop-restored'), at: new Date('2026-10-04T09:00:00Z') });
back.collections; // undefined: a whole restore

// every collection beside the live one, under another name
const part = await backups.restore({ into: client.db('shop'), as: (name) => `${name}-before` });
// part.collections: [{ name: 'customers', as: 'customers-before' }, { name: 'orders', as: 'orders-before' }]

// one deleted document, back where it was
const some = await backups.restore({
	into: client.db('shop'),
	collections: ['orders'],
	documents: { filter: { _id: 'o-1001' }, existing: 'keep' },
});
// some.collections: [{ name: 'orders', as: 'orders', documents: 1 }]
```

**Picking the backup.** A `Date` takes the newest backup made at or before
it, an incremental included: it holds the database as it was then, its
chain replayed. A string is taken as an id, as `list` gives it.

```ts
await backups.restore({ into: client.db('shop-restored') });
// MongoBackupError (NOT_FOUND): restore on "shop": the repository holds no backup yet

await backups.restore({ into: client.db('shop-restored'), at: new Date('2020-01-01') });
// MongoBackupError (NOT_FOUND): restore on "shop": no backup was made at or before that time
```

`"shop"` is the backup's name: `name`, or the database's. Three options
are refused before anything is read, the key file included, with a bare
`TypeError`: an `into` that is not a driver `Db`
(`restore on "shop": into must be a MongoDB Db`), and these two:

```ts
await backups.restore({ into: client.db('shop-restored'), at: new Date('yesterday') });
// TypeError: restore on "shop": at must be a backup's id or a valid Date

const documents = { filter: { _id: 'o-1001' }, existing: 'keep' } as const;
// @ts-expect-error — the types refuse it too
await backups.restore({ into: client.db('shop'), documents, replace: true });
// TypeError: restore on "shop": replace is for whole collections; documents says what happens to those there
```

An id the repository does not hold rejects with `@nxgt/backup`'s
`BackupError` `NOT_FOUND`. Everything else a restore throws — `EXISTS`, a
name in `collections` the backup lacks, an `as` that names nothing — is
`mongoTarget`'s and `restoreCollections`'s, on [restore](restore.md). A
partial restore's refusals name the call: where `restoreCollections` says
`restoreCollections: as names a collection not restored`, `restore` says
`restore on "shop": as names a collection not restored`.

### `drill`

```ts
interface DrillReport {
	id: string;
	collections: { name: string; documents: number }[];
}
```

The newest backup, chain included, restored through `mongoTarget` into a
database of its own, `nxgt-drill-<uuid>` on `db`'s client; each collection
counted, in name order — views and `system.*` apart; then the database
dropped, failed or not. It rejects with `NOT_FOUND`
(`drill on "shop": the repository holds no backup yet`) on an empty
repository, and with whatever the restore threw otherwise.

```ts
const { id, collections } = await backups.drill();
const orders = collections.find((c) => c.name === 'orders');
if (!orders || orders.documents === 0) throw new Error(`drill of ${id}: no orders`);
```

The user needs the right to create that database, and the server the room
for a whole copy for as long as the drill runs. A process killed mid-drill
leaves the `nxgt-drill-<uuid>` database behind: drop it by hand.

### `list`

The backups the repository holds, oldest first, as `@nxgt/backup` lists
them: `{ id, createdAt, kind, parent, entries, storedSize, held }`. It
decrypts nothing, but reads the key file all the same: a manifest is
listed only when it is signed with the key file's signing key, so a backup
made with other keys — or by hand, unsigned — is not in it.

```ts
const newest = (await backups.list()).at(-1);
const hours = newest ? (Date.now() - newest.createdAt.getTime()) / 3_600_000 : Infinity;
if (hours > 2) console.error('no backup for two hours');
```

### `binding`

The `@nxgt/backup` binding `mongoBackups` uses — bound to the repository,
the recipient and the signing key — and the keys, for what it does not do:
a differential backup, a legal hold, a restore with `only`, a full backup
on demand.

```ts
import { mongoSource } from '@nxgt/mongo-backup';

const { backups: bound, keys } = await backups.binding();
const full = await bound.create(mongoSource({ db: client.db('shop') }));
await bound.verify(full.id, { identities: [keys.identity] });
```

Give the source the same `collections` as `mongoBackups`, or the next
incremental follows another set.

## A drill in a spec

A backup nobody restored is a hope. With `bun test`, against the backups a
job made:

```ts
import { afterAll, expect, test } from 'bun:test';
import { mongoBackups } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
afterAll(() => client.close());

test('the newest backup restores', async () => {
	const backups = mongoBackups({
		db: client.db('shop'),
		repository: '/mnt/backups',
		keyFile: '/etc/backup/shop.key',
	});
	const { collections } = await backups.drill();
	expect(collections.find((c) => c.name === 'orders')?.documents).toBeGreaterThan(0);
}, 600_000);
```

## Lower level

`mongoBackups` is `@nxgt/backup`'s `bindBackup`, with `mongoSource` to back
up and `mongoTarget` or `restoreCollections` to restore. Reach for them
when you keep the keys apart rather than in one file, make differential
backups, or decide the schedule yourself. The rest of this page is
`mongoSource`; the targets are on [restore](restore.md).

```ts
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { mongoSource, mongoTarget } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string); // a replica set
const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string], // age1… — a public key
});

const created = await backups.create(mongoSource({ db: client.db('shop') }));
// { id: '20261004T221500123Z-9f3a61c0', kind: 'full', parent: null, entries: 12, … }

await backups.verify(created.id); // every object against the manifest, no key

await backups.restore(created.id, mongoTarget({ db: client.db('shop-restored') }), {
	identities: [process.env.BACKUP_IDENTITY as string], // AGE-SECRET-KEY-1…
});
```

`defineBackup`, `bindBackup`, the keys and the repositories are
`@nxgt/backup`'s; its
[getting started](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/getting-started.md)
covers them.

## `mongoSource`

```ts
type CollectionFilter = readonly string[] | ((name: string) => boolean);

interface MongoSourceOptions {
	db: Db;
	collections?: CollectionFilter | undefined;
}

function mongoSource(options: MongoSourceOptions): BackupSource; // kind: 'mongo'
```

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `db` | `Db` | required | the database to back up. Its client must reach a replica set or a sharded cluster |
| `collections` | `readonly string[] \| ((name: string) => boolean)` | every collection and view but `system.*` | which collections and views to read: their names, or a test on each name |

`mongoSource` checks its options at once, and touches nothing:

```ts
mongoSource({ db: 'shop' as never });
// TypeError: mongoSource: db must be a MongoDB Db

mongoSource({ db: client.db('shop'), collections: 'orders' as never });
// TypeError: mongoSource: collections must be a list of names or a function
```

The types refuse both before they run. The source keeps nothing between
backups — where the next incremental resumes is recorded in the backup
itself — so a new process makes the next backup with a new `mongoSource`.
Give one `create` at a time a given source object: it holds the position of
the backup it is reading until `@nxgt/backup` asks for it.

## What a full backup holds

For each collection, in name order:

| Entry | Holds |
| --- | --- |
| `metadata/<name>` | its options as `listCollections` gives them — validator, collation, capped size, … — and its indexes as `listIndexes` gives them, `_id` apart |
| `documents/<name>` | every document, as concatenated BSON: the bytes `mongodump` writes to a `.bson` file |

- **A view** has its metadata only — `viewOn` and `pipeline` among its
  options — and is created from it on restore.
- **A GridFS bucket** is two plain collections, `<bucket>.files` and
  `<bucket>.chunks`, backed up and restored like the others. With a list,
  name both: `collections: ['orders', 'fs.files', 'fs.chunks']`.
- **`system.*` is never read**, whatever `collections` says: neither
  `system.views` (views come back from their metadata), nor `system.js`, nor
  `system.profile`. Users and roles live in the `admin` database, not in
  the one backed up.
- **Numbers keep their kind.** Documents are read raw and written back raw:
  an `Int32`, a `Long`, a `Double` and a `Decimal128` come back as they
  were, as do dates, binaries and regular expressions.

The byte layout is on the [format](format.md) page.

## Choosing collections

`mongoBackups`' `collections` is passed to `mongoSource` as it is, so what
follows holds for both. A list names exactly what to back up:

```ts
const source = mongoSource({ db: client.db('shop'), collections: ['orders', 'customers'] });
```

**A name in the list that the database lacks rejects the backup** — a typo
would otherwise back up nothing, and say nothing. The check runs when the
full backup starts reading, so it is `create` that rejects, before any entry
is stored:

```ts
await backups.create(mongoSource({ db: client.db('shop'), collections: ['ordres'] }));
// TypeError: mongoSource: a collection named in collections is not in the database
```

A test picks what it returns `true` for, and never complains about a
collection that is not there — the way to leave something out:

```ts
const source = mongoSource({
	db: client.db('shop'),
	collections: (name) => !name.startsWith('cache.') && name !== 'metrics',
});
```

Either form applies to views as to collections, and to the changes an
[incremental](incremental.md#the-collections-a-chain-follows) backup
records: a change to a collection the chain does not follow is not
recorded. A change to
`collections` takes effect at the **next full backup**: an incremental
follows the collections its full backup held, plus those created since that
the filter takes.

**A time-series collection is refused**, not skipped: a full backup that
meets one rejects with `UNSUPPORTED`, and the way out is to leave it out:

```ts
await backups.create(mongoSource({ db: client.db('shop') }));
// MongoBackupError (UNSUPPORTED): mongoSource: a collection is of a type this version
// does not back up (a time-series one); leave it out with collections

await backups.create(mongoSource({ db: client.db('shop'), collections: (name) => name !== 'metrics' }));
```

## One cluster time

A full backup opens **one snapshot session** before it gives its first
entry, and reads every collection in it. Every document it holds is as it
was at that one cluster time, however long the backup runs: a write that
lands after the snapshot opened is not in it, even in a collection read an
hour later. That is what makes the collections agree with each other — an
order and its customer, a GridFS file and its chunks.

The collections, their options and their indexes are not read in a
snapshot — the server does not serve those reads at a cluster time — so a
full backup reads them **before** it pins the snapshot and **again after**.
The same both times, they are what the snapshot holds; otherwise it pins
again, up to five times, then fails:

```text
MongoBackupError (CHANGING): mongoSource: the collections or their indexes kept
changing while the snapshot was taken; try again when they settle
```

Nothing is stored when it does: run the backup again once whatever was
creating, dropping or indexing collections has finished. Past that point
the metadata entries come from what was read, not from the database, so:

- **an index built while the backup runs** is not in it: it arrives in the
  next incremental, as a `createIndexes` change, and a restore of this
  backup has the collection without it;
- **a collection dropped or renamed while it runs** is still read, at the
  snapshot, as it was.

The next incremental starts **just after** that cluster time, so it replays
nothing the full backup holds, and misses nothing written since. It follows
the collections this backup holds — its `metadata/<name>` entries say
which, and each position records only what changed since, on the
[format](format.md#the-position-and-the-fingerprints) page.

## A long snapshot

The server keeps the history a snapshot reads for
`minSnapshotHistoryWindowInSeconds` — 300 seconds by default. A full
backup reads its collections one at a time, and each entry is compressed,
encrypted and stored in every repository before the next is read, so the
whole backup — slow repositories included — must fit in that window, or it
fails:

```text
MongoBackupError (SNAPSHOT_TOO_OLD): mongoSource: the snapshot outlived the history
the server keeps; raise minSnapshotHistoryWindowInSeconds, or back up fewer
collections at a time
```

Raise the window on every member that may serve the read (on every shard,
for a sharded cluster), to more than your longest full backup:

```ts
await client.db('admin').command({ setParameter: 1, minSnapshotHistoryWindowInSeconds: 3600 });
```

The server keeps more history for it, in its cache and on disk; set it
back once the backup is done if that matters to you. Or split the database
into two definitions with two `collections` lists — at the cost of the one
cluster time, which then holds within each backup, not between them.

## Restoring with `mongoTarget`

```ts
import { mongoTarget } from '@nxgt/mongo-backup';

await backups.restore(created.id, mongoTarget({ db: client.db('shop-restored') }), {
	identities: [process.env.BACKUP_IDENTITY as string],
});
```

Each collection lands whole or not at all; one already there is refused
with `EXISTS` unless `replace: true` — [restore](restore.md) has every
option.

## A nightly job by hand

A full backup every night, checked, rotated, run with `bun run` — what
`run` does, without incrementals, for keys kept apart. Once incrementals
make sense, [incremental](incremental.md#a-weekly-schedule) has the weekly
schedule, or [`run`](#run) does it for you.

```ts
// backup.ts — run with `bun run backup.ts` from cron
import { bindBackup, defineBackup, localRepository } from '@nxgt/backup';
import { MongoBackupError, mongoSource } from '@nxgt/mongo-backup';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGO_URL as string);
try {
	const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
		repositories: [localRepository({ path: '/mnt/backups' })],
		recipients: [process.env.BACKUP_RECIPIENT as string],
		tmpDir: '/var/tmp',
	});

	const created = await backups.create(
		mongoSource({ db: client.db('shop'), collections: (name) => name !== 'metrics' }),
	);
	await backups.verify(created.id);
	await backups.prune({ keep: { daily: 14, weekly: 8 } });
	console.log(`backup ${created.id}: ${created.entries} entries, ${created.storedSize} bytes`);
} catch (error) {
	if (error instanceof MongoBackupError) {
		console.error(`backup failed (${error.code}): ${error.message}`, error.cause);
	}
	throw error;
} finally {
	await client.close();
}
```

Next: [running it in production](operations.md), then
[incremental](incremental.md) for what an incremental records.
