# Format

This page describes what a `mongoSource` backup holds — its entries, their
names and their bytes — and how to read one without this package.

```ts
import { bindBackup, defineBackup, directoryTarget, localRepository } from '@nxgt/backup';

const backups = bindBackup(defineBackup({ name: 'shop-db' }), {
	repositories: [localRepository({ path: '/mnt/backups' })],
	recipients: [process.env.BACKUP_RECIPIENT as string],
});

const latest = (await backups.list()).backups.at(-1);
if (!latest) throw new Error('no backup to inspect');

// Every entry as a plain file: metadata/orders, documents/orders, changes/000001, …
await backups.restore(latest.id, directoryTarget({ path: '/srv/inspect' }), {
	identities: [process.env.BACKUP_IDENTITY as string],
});
```

How entries are compressed, encrypted and stored — `0.age`, the catalog,
the manifest — is `@nxgt/backup`'s
[format](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/format.md).
What follows is what is inside each entry.

## The entries

| Name | Holds | In |
| --- | --- | --- |
| `metadata/<collection>` | a collection's or a view's options and indexes, as canonical Extended JSON | every backup |
| `documents/<collection>` | a collection's documents, as concatenated BSON | every backup, except for a view |
| `changes/<n>` | the changes one incremental or differential read, as concatenated BSON | incremental and differential backups |

- **`<collection>` is the collection's name**, as it is: `metadata/fs.files`,
  `documents/orders`.
- **`<n>` is six digits**, from `000001`, numbered in the order the changes
  apply: an incremental on an incremental holds its parent's
  `changes/000001` and its own `changes/000002`.
- **A full backup's entries come in collection-name order**, each
  collection's metadata just before its documents; an incremental's come in
  its parent's order, then its own `changes/<n>`. A restore takes them in
  that order — [restore](restore.md#the-order).

## `metadata/<collection>`

One JSON document, canonical Extended JSON — so a number keeps its kind:

```json
{
	"format": "nxgt-mongo-backup-metadata/1",
	"type": "collection",
	"options": {
		"validator": { "$jsonSchema": { "required": ["name"] } },
		"collation": { "locale": "fr", "strength": { "$numberInt": "2" } }
	},
	"indexes": [
		{ "key": { "name": { "$numberInt": "1" } }, "name": "by_name", "unique": true }
	]
}
```

| Field | |
| --- | --- |
| `format` | `nxgt-mongo-backup-metadata/1`. A restore refuses any other with `MALFORMED` |
| `type` | `collection` or `view` |
| `options` | what `listCollections` gave as the collection's options: validator, collation, `capped` and `size`, `changeStreamPreAndPostImages`; for a view, `viewOn` and `pipeline` |
| `indexes` | what `listIndexes` gave, without the `_id` index, `v` and `ns` |

The options and indexes are those read around the snapshot, not after
it: an index built while the backup runs is not here, but in the next
incremental's `changes/<n>` —
[one cluster time](getting-started.md#one-cluster-time).

A restore refuses a metadata entry over 16 MiB with `MALFORMED`: options
and indexes never come near it.

## `documents/<collection>`

Every document of the collection, each as its own BSON bytes, one after the
other — the format `mongodump` writes to a `.bson` file. Each document is
read raw from the server and written as it came: no number changes kind,
and nothing is re-encoded.

A restore reads them back one document at a time, never the whole entry:
a length that cannot be a document's — under 5 bytes, or over 17 MiB — or
a stream that ends inside one is refused with
`MongoBackupError (MALFORMED): mongoTarget: an entry is not a sequence of BSON documents`.

## `changes/<n>`

One BSON document per change, in the order they apply, each with an `op`
and the collection it is about, `coll`:

| `op` | Other fields |
| --- | --- |
| `insert`, `replace` | `key` (the document's `_id`), `doc` (the whole document) |
| `update` | `key`, `set` (fields and their new values, by path), `unset` (paths), `truncated` (`{ field, newSize }` for each array cut) |
| `delete` | `key` |
| `create` | `options` |
| `createIndexes` | `indexes` |
| `dropIndexes` | `names` |
| `modify` | `changes`: what `collMod` was given |
| `drop` | — |
| `rename` | `to`: the new name, in the same database; `dropTarget`: `true` when the rename replaced a collection of that name at the source, `false` otherwise |
| `dropDatabase` | no `coll` |

A record that is none of these — a `rename` without a boolean `dropTarget`
among them — is refused on restore with
`MongoBackupError (MALFORMED): mongoTarget: a change is not one this version wrote`.

On restore, an entry is staged whole before any change applies, to
`<tmpDir>/nxgt-mongo-changes-XXXXXX/changes.bson`: a folder made with
`mkdtemp`, readable only by the user that runs the restore, and removed
afterwards — [restore](restore.md#changes).

## The position and the fingerprints

`mongoSource` records **where the next incremental starts, and how the
collections it follows differ from the full backup's**, as the backup's
position, kept encrypted in its
catalog — canonical Extended JSON, with either a cluster time (after a full
backup) or a resume token (after an incremental):

```json
{ "format": "nxgt-mongo-backup-position/1", "startAtOperationTime": { "$timestamp": { "t": 1791158100, "i": 4 } }, "added": [], "removed": [] }
```

```json
{ "format": "nxgt-mongo-backup-position/1", "startAfter": { "_data": "8267…" }, "added": ["reviews"], "removed": ["drafts"] }
```

| Field | |
| --- | --- |
| `format` | `nxgt-mongo-backup-position/1` |
| `startAtOperationTime` | after a full backup: the first cluster time its snapshot does not hold |
| `startAfter` | after an incremental: the resume token of the last change it read, or the stream's own once it caught up |
| `added` | collections and views the chain follows that its full backup does not hold — created since, and taken by the filter — sorted |
| `removed` | collections and views the full backup holds that the chain follows no more — dropped or renamed away — sorted |

The chain follows its full backup's collections and views — one
`metadata/<name>` entry each, in the catalog every backup of the chain
lists — plus `added`, less `removed`: so the position stays small however
many collections the database holds —
[incremental](incremental.md#the-collections-a-chain-follows). A position
is at most 64 KiB, `@nxgt/backup`'s limit; past it the incremental fails
`UNSUPPORTED` — `mongoSource: the collections created, renamed or dropped
since the full backup are too many to record; make a full backup`.

An incremental built on a backup with no position this version reads — one
without `added` and `removed` — fails
with `MALFORMED` — `mongoSource: the backup built on recorded no position
this version reads; make a full backup`.

Each entry also has a **fingerprint**: `snapshot:<cluster time>` for a full
backup's entries, `changes:<parent id>:changes/<n>` for a changes entry. An
incremental gives its parent's entries back with the fingerprints they were
recorded with, so `@nxgt/backup` points to them and never reads them again;
an entry recorded without one cannot be given back, and the incremental
fails with
`MALFORMED` — `mongoSource: an entry of the backup built on was asked for again; it has no fingerprint, so make a full backup`.

## Reading a backup without this package

Restore it to a folder with `directoryTarget`, as at the top of this page,
then read each file with the MongoDB Database Tools:

```sh
cat /srv/inspect/metadata/orders                      # options and indexes, as JSON
bsondump /srv/inspect/documents/orders | head          # the documents, one JSON line each
bsondump /srv/inspect/changes/000001 | head            # the changes, one JSON line each
```

A `documents/<collection>` file is what `mongodump` would have written as
`<collection>.bson`. `directoryTarget` refuses an entry whose name is not a
safe relative path, so a collection named with a `\` or a `..` segment
needs a target of your own — `@nxgt/backup`'s
[sources and targets](https://github.com/softistx/nxgt-data/blob/develop/packages/backup/docs/guide/sources-and-targets.md#writing-a-target).
